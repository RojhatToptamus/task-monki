import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import {
  createDevApiTokenLease,
  DEFAULT_DEV_API_PORT,
  DEFAULT_DEV_RENDERER_PORT,
  devApiExpectedHost,
  devRendererOrigin,
  parseDevPort,
  type DevApiTokenLease
} from './devApiSecurity';
import { createDevHttpServer, type DevHttpServer } from './devHttpServer';
import { DevProcessLifecycle } from './devProcessLifecycle';
import { chooseRepositoryFolder } from './folderPicker';

const port = parseDevPort(
  process.env.TASK_MANAGER_API_PORT,
  DEFAULT_DEV_API_PORT,
  'TASK_MANAGER_API_PORT'
);
const rendererPort = parseDevPort(
  process.env.TASK_MANAGER_RENDERER_PORT,
  DEFAULT_DEV_RENDERER_PORT,
  'TASK_MANAGER_RENDERER_PORT'
);
const defaultRepositoryPath = process.env.TASK_MANAGER_REPO_PATH ?? process.cwd();
const defaultDevDataDir = path.join(process.cwd(), '.local', 'task-monki-dev');
const storeDir =
  process.env.TASK_MANAGER_STORE_DIR ?? path.join(defaultDevDataDir, 'dev-store');
const appSettingsPath =
  process.env.TASK_MANAGER_APP_SETTINGS_PATH ?? path.join(storeDir, 'app-settings.json');
const inertSeedMode = process.env.TASK_MANAGER_DEV_SEED_MODE === '1';
const taskStore = new FileTaskStore(storeDir);

const service = new TaskManagerService(
  taskStore,
  defaultRepositoryPath,
  undefined,
  {
    appSettingsStore: new AppSettingsStore(appSettingsPath),
    // A same-user provider process can read ordinary filesystem secrets. Keep
    // the browser-only HTTP development surface unreachable from agent commands
    // by requiring non-escalatable, network-disabled turns. Startup also makes
    // unsafe persisted runs terminal before Codex initialization/recovery;
    // external tools are forced off with fail-closed MCP discovery. Packaged
    // Electron uses guarded IPC and does not enable this restriction.
    allowAgentNetworkAccess: false,
    agentProviderStartupDisabledReason: inertSeedMode
      ? 'Agent runtimes are disabled while deterministic development seed scenarios are loaded. Regenerate or use a normal development store to run agent work.'
      : undefined
  }
);
const security = {
  token: '',
  expectedHost: devApiExpectedHost(port),
  expectedOrigin: devRendererOrigin(rendererPort)
};

let devServer: DevHttpServer | undefined;
let tokenLease: DevApiTokenLease | undefined;
const lifecycle = new DevProcessLifecycle();

async function start(): Promise<void> {
  await service.init();
  if (lifecycle.isStopping) {
    return;
  }
  devServer = createDevHttpServer({
    service,
    security,
    chooseRepositoryFolder
  });
  await listen(devServer.server, port);
  if (lifecycle.isStopping) {
    return;
  }
  tokenLease = await createDevApiTokenLease(port);
  if (lifecycle.isStopping) {
    return;
  }
  security.token = tokenLease.token;

  console.log(`Task Monki dev API listening on http://${security.expectedHost}`);
  console.log(`Renderer origin: ${security.expectedOrigin}`);
  console.log(`Store: ${storeDir}`);
  console.log(`Default repository: ${defaultRepositoryPath}`);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  await lifecycle.stop(cleanupResources);
}

async function cleanupResources(): Promise<void> {
  security.token = '';
  const activeServer = devServer;
  const activeTokenLease = tokenLease;
  devServer = undefined;
  tokenLease = undefined;

  const cleanupErrors: unknown[] = [];

  await attemptCleanup(() => activeTokenLease?.dispose(), cleanupErrors);
  if (activeServer) {
    await attemptCleanup(() => activeServer.closeEventStreams(), cleanupErrors);
    await attemptCleanup(() => closeServer(activeServer.server), cleanupErrors);
    await attemptCleanup(() => activeServer.dispose(), cleanupErrors);
  }
  await attemptCleanup(() => service.shutdown(), cleanupErrors);

  if (cleanupErrors.length > 0) {
    throw cleanupErrors[0];
  }
}

function handleSignal(signal: NodeJS.Signals): void {
  void shutdown(signal).catch((error: unknown) => {
    console.error('Task Monki dev API failed to shut down cleanly.', error);
    process.exitCode = 1;
  });
}

function listen(server: import('node:http').Server, listenPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, '127.0.0.1');
  });
}

function closeServer(server: import('node:http').Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}

async function attemptCleanup(
  cleanup: () => void | Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

const startupPromise = lifecycle.start(start);
void startupPromise.catch(async (error: unknown) => {
  try {
    await lifecycle.stop(cleanupResources);
  } catch (cleanupError) {
    console.error('Task Monki dev API failed to clean up after startup.', cleanupError);
  }
  console.error('Task Monki dev API failed to start.', error);
  process.exitCode = 1;
});
