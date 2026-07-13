import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewApprovalPolicy } from './PreviewApprovalPolicy';
import { PreviewGateway } from './PreviewGateway';
import { PreviewGraph } from './PreviewGraph';
import { PreviewManager } from './PreviewManager';
import { PreviewPlanResolver } from './PreviewPlanResolver';
import { PreviewReadinessService } from './PreviewReadinessService';
import { PreviewRecipeLoader } from './PreviewRecipeLoader';
import { PreviewReconciler } from './PreviewReconciler';
import { PreviewSourcePreparer } from './PreviewSourcePreparer';
import { NativeJobRunner } from './runtime/NativeJobRunner';
import { NativeLauncherHost } from './runtime/NativeLauncherHost';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';
import { PreviewOpenService, type PreviewUrlHost } from './runtime/PreviewOpenService';
import { PreviewPortAllocator } from './runtime/PreviewPortAllocator';
import { MacPreviewListenerInspector } from './runtime/PreviewListenerInspector';
import { OciEngineAdapter } from './runtime/OciEngineAdapter';
import { OciResourceRuntime } from './runtime/OciResourceRuntime';
import { PreviewCredentialHost } from './runtime/PreviewCredentialHost';
import path from 'node:path';
import { PreviewPrivateVault, type PreviewSecretProtector } from './private/PreviewPrivateVault';
import { PreviewComposeCliAdapter } from './compose/PreviewComposeCliAdapter';
import { PreviewComposeInspector } from './compose/PreviewComposeInspector';
import { PreviewComposeRuntime } from './compose/PreviewComposeRuntime';

export interface CreatePreviewManagerOptions {
  previewRoot: string;
  launcherPath: string;
  launcherExecPath?: string;
  launcherEnv?: NodeJS.ProcessEnv;
  ociExecutablePath?: string;
  ociContextName?: string;
  ociEnv?: NodeJS.ProcessEnv;
  openHost?: PreviewUrlHost;
  secretProtector?: PreviewSecretProtector;
}

export function createPreviewManager(
  store: FileTaskStore,
  events: AppEventBus,
  options: CreatePreviewManagerOptions
): PreviewManager {
  const source = new PreviewSourcePreparer(options.previewRoot, store.getStoreIdentity());
  const launcher = new NativeLauncherHost(
    options.launcherPath,
    options.launcherExecPath,
    options.launcherEnv
  );
  const nativeRuntime = new NativeServiceRuntime(store, launcher);
  const ociEngine = new OciEngineAdapter({
    executable: options.ociExecutablePath,
    contextName: options.ociContextName,
    env: options.ociEnv
  });
  const gateway = new PreviewGateway();
  const credentialHost = new PreviewCredentialHost(path.join(options.previewRoot, 'runtime-credentials'));
  const ociRuntime = new OciResourceRuntime(
    store,
    ociEngine,
    new PreviewReadinessService(),
    credentialHost
  );
  const composeControlRoot = path.join(options.previewRoot, 'compose-control');
  const composeCli = new PreviewComposeCliAdapter({
    executable: options.ociExecutablePath,
    contextName: options.ociContextName,
    dockerConfigPath: options.ociEnv?.DOCKER_CONFIG ?? path.join(
      options.ociEnv?.HOME ?? process.env.HOME ?? '',
      '.docker'
    ),
    controlledHome: composeControlRoot
  });
  const composeInspector = new PreviewComposeInspector(
    composeCli,
    path.join(composeControlRoot, 'inspection')
  );
  const composeRuntime = new PreviewComposeRuntime(
    store,
    composeCli,
    composeInspector,
    ociEngine
  );
  const graph = new PreviewGraph(
    store,
    new NativeJobRunner(store, launcher),
    nativeRuntime,
    new PreviewReadinessService(),
    new PreviewPortAllocator(),
    new MacPreviewListenerInspector()
  );
  return new PreviewManager(
    store,
    events,
    new PreviewRecipeLoader(),
    new PreviewPlanResolver(ociEngine, store, composeInspector),
    new PreviewApprovalPolicy(store),
    source,
    graph,
    gateway,
    nativeRuntime,
    new PreviewReconciler(store, gateway, nativeRuntime, source, ociRuntime, composeRuntime),
    new PreviewOpenService(store, options.openHost),
    ociRuntime,
    options.secretProtector
      ? new PreviewPrivateVault(path.join(options.previewRoot, 'private-vault'), options.secretProtector)
      : undefined,
    composeRuntime
  );
}
