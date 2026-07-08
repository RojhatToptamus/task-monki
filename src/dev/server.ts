import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import type { AppUpdateEvent } from '../shared/contracts';
import { chooseRepositoryFolder } from './folderPicker';

const port = Number(process.env.TASK_MANAGER_API_PORT ?? 3099);
const defaultRepositoryPath = process.env.TASK_MANAGER_REPO_PATH ?? process.cwd();
const storeDir =
  process.env.TASK_MANAGER_STORE_DIR ?? path.join(os.tmpdir(), 'task-monki-dev-store');
const appSettingsPath =
  process.env.TASK_MANAGER_APP_SETTINGS_PATH ?? path.join(storeDir, 'app-settings.json');

const service = new TaskManagerService(
  new FileTaskStore(storeDir),
  defaultRepositoryPath,
  undefined,
  {
    appSettingsStore: new AppSettingsStore(appSettingsPath)
  }
);
const clients = new Set<http.ServerResponse>();
let server: http.Server | undefined;
let shutdownPromise: Promise<void> | undefined;

function sendEvent(response: http.ServerResponse, event: AppUpdateEvent): void {
  response.write(`event: update\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/defaultRepositoryPath') {
      sendJson(response, 200, await service.getDefaultRepositoryPath());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/agent/provider') {
      sendJson(response, 200, await service.getAgentProviderState());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(response, 200, await service.getAppSettings());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      sendJson(response, 200, await service.updateAppSettings((await readJson(request)) as never));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/tools') {
      sendJson(response, 200, await service.getExternalToolStatus());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/tools/test') {
      sendJson(response, 200, await service.testExternalTool((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/open-target/inspect') {
      sendJson(response, 200, await service.inspectOpenTarget((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/open-target/execute') {
      sendJson(response, 200, await service.executeOpenTargetAction((await readJson(request)) as never));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      sendJson(response, 200, await service.listTasks());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/repository/validate') {
      const body = (await readJson(request)) as { path: string };
      sendJson(response, 200, await service.validateRepository(body.path));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/repository/chooseFolder') {
      sendJson(response, 200, (await chooseRepositoryFolder()) ?? null);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      sendJson(response, 200, await service.createTask((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/prompt/refine') {
      sendJson(response, 200, await service.refinePrompt((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/worktrees/prepare') {
      sendJson(response, 200, await service.prepareWorktree((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/start') {
      sendJson(response, 200, await service.startRun((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/steer') {
      await service.steerRun((await readJson(request)) as never);
      sendJson(response, 200, {});
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/continue') {
      sendJson(response, 200, await service.continueRun((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/retry') {
      sendJson(response, 200, await service.retryRun((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/review') {
      sendJson(response, 200, await service.startReview((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/goal/sync') {
      sendJson(response, 200, await service.syncAgentGoal((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/cancel') {
      await service.cancelRun((await readJson(request)) as never);
      sendJson(response, 200, {});
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/interactions/respond') {
      sendJson(
        response,
        200,
        await service.respondToInteraction((await readJson(request)) as never)
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/evidence/refresh') {
      sendJson(response, 200, await service.refreshEvidence((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/delivery-commit') {
      sendJson(response, 200, await service.createDeliveryCommit((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/preflight') {
      sendJson(response, 200, await service.preflightGitHub((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/publish') {
      sendJson(response, 200, await service.publishBranch((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/pr/create') {
      sendJson(response, 200, await service.createPullRequest((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/refresh') {
      sendJson(response, 200, await service.refreshGitHub((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks/transition') {
      sendJson(response, 200, await service.transitionTask((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks/delete') {
      sendJson(response, 200, await service.deleteTask((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/artifact/read') {
      const text = await service.readArtifact((await readJson(request)) as never);
      sendJson(response, 200, text);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/protocol/read') {
      sendJson(
        response,
        200,
        await service.readProtocolMessage((await readJson(request)) as never)
      );
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unknown server error.'
    });
  }
}

service.events.on((event) => {
  for (const client of clients) {
    sendEvent(client, event);
  }
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownPromise ??= (async () => {
    console.log(`Received ${signal}; shutting down.`);
    for (const client of clients) {
      client.end();
    }
    clients.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await service.shutdown();
  })();
  await shutdownPromise;
}

function handleSignal(signal: NodeJS.Signals): void {
  void shutdown(signal).catch((error: unknown) => {
    console.error('Task Monki dev API failed to shut down cleanly.', error);
    process.exitCode = 1;
  });
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

service.init().then(() => {
  server = http.createServer((request, response) => void route(request, response));
  server.listen(port, '127.0.0.1', () => {
    console.log(`Task Monki dev API listening on http://127.0.0.1:${port}`);
    console.log(`Store: ${storeDir}`);
    console.log(`Default repository: ${defaultRepositoryPath}`);
  });
}).catch((error: unknown) => {
  console.error('Task Monki dev API failed to start.', error);
  process.exitCode = 1;
});
