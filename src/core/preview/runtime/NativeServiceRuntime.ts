import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  PreviewNativeResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewServicePlan,
  PreviewWorkerPlan
} from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { buildPreviewEnvironment } from '../PreviewEnvironment';
import { boundedPreviewFailure as boundedError } from '../PreviewFailure';
import {
  NativeLauncherHost,
  digestCommand,
  type NativeOwnedProcess,
  type NativeLauncherReceipt
} from './NativeLauncherHost';
import { resolvePreparedNodeCwd } from './NativeJobRunner';

export interface RunningNativeService {
  attempt: PreviewNodeAttemptRecord;
  resource: PreviewNativeResourceRecord;
  owned: NativeOwnedProcess;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  completion: Promise<NativeServiceExit>;
  isRunning(): boolean;
}

export interface NativeServiceExit {
  receipt: NativeLauncherReceipt;
  wasStopping: boolean;
}

export class NativeServiceRuntime {
  private readonly live = new Map<string, NativeOwnedProcess>();
  private readonly stopping = new Set<string>();

  constructor(
    private readonly store: FileTaskStore,
    private readonly launcherHost: NativeLauncherHost
  ) {}

  async start(input: {
    taskId: string;
    generationId: string;
    generationRoot: string;
    sourcePath: string;
    markerDigest: string;
    node: PreviewServicePlan | PreviewWorkerPlan;
    portValues: Record<string, number>;
    resolvedEnv?: Record<string, string>;
    kind?: 'SERVICE' | 'WORKER';
    attempt?: number;
    redactions?: string[];
  }): Promise<RunningNativeService> {
    const cwd = await resolvePreparedNodeCwd(input.sourcePath, input.node.cwd, input.node.id);
    const [executable, ...argv] = input.node.command;
    const commandDigest = digestCommand(executable, argv, cwd);
    const stdout = await this.store.createPreviewArtifact(input.taskId, 'preview-stdout');
    const stderr = await this.store.createPreviewArtifact(input.taskId, 'preview-stderr');
    const generatedEnv = Object.fromEntries(
      Object.entries(input.portValues).map(([portId, port]) => [input.node.ports[portId].env, String(port)])
    );
    const now = new Date().toISOString();
    let attempt: PreviewNodeAttemptRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      generationId: input.generationId,
      nodeId: input.node.id,
      kind: input.kind ?? 'SERVICE',
      attempt: input.attempt ?? 1,
      commandDigest,
      state: 'INTENDED',
      stdoutArtifactId: stdout.id,
      stderrArtifactId: stderr.id
    };
    attempt = await this.store.savePreviewNodeAttempt(attempt);
    const targetPort =
      !input.node.ready || input.node.ready.type === 'argv'
        ? Object.values(input.portValues)[0]
        : input.portValues[input.node.ready.port];
    const resourceId = randomUUID();
    const receiptPath = path.join(input.generationRoot, 'runtime', `${resourceId}.json`);
    let resource: PreviewNativeResourceRecord = {
      id: resourceId,
      taskId: input.taskId,
      generationId: input.generationId,
      logicalNodeId: input.node.id,
      adapterKind: 'NATIVE_PROCESS',
      state: 'INTENDED',
      ownershipMarkerDigest: input.markerDigest,
      receiptPath,
      targetHost: '127.0.0.1',
      targetPort,
      creationAttemptedAt: now,
      updatedAt: now
    };
    resource = await this.store.savePreviewResource(resource);
    let owned: NativeOwnedProcess;
    try {
      owned = await this.launcherHost.launch({
      receiptPath,
      executable,
      argv,
      cwd,
      env: buildPreviewEnvironment({
        recipe: input.resolvedEnv ?? literalEnvironment(input.node.env),
        generated: generatedEnv
      }),
      stdoutPath: stdout.path,
      stderrPath: stderr.path,
      redactions: input.redactions,
      persistPrepared: async (identity) => {
        resource = await this.store.savePreviewResource({
          ...resource,
          state: 'PREPARED',
          native: identity,
          updatedAt: new Date().toISOString()
        });
        attempt = await this.store.savePreviewNodeAttempt({ ...attempt, state: 'PREPARING_LAUNCHER' });
      },
      persistStarted: async (identity) => {
        resource = await this.store.savePreviewResource({
          ...resource,
          state: 'RUNNING',
          native: identity,
          updatedAt: new Date().toISOString()
        });
        attempt = await this.store.savePreviewNodeAttempt({
          ...attempt,
          state: 'RUNNING',
          startedAt: new Date().toISOString()
        });
      }
      });
    } catch (error) {
      await Promise.allSettled([
        this.store.syncArtifactByteCount(stdout.id),
        this.store.syncArtifactByteCount(stderr.id)
      ]);
      const endedAt = new Date().toISOString();
      attempt = await this.store.savePreviewNodeAttempt({
        ...attempt,
        state: 'FAILED',
        startedAt: attempt.startedAt ?? now,
        endedAt
      });
      resource = await this.store.savePreviewResource({
        ...resource,
        state: 'FAILED',
        updatedAt: endedAt
      });
      throw error;
    }
    resource = await this.store.savePreviewResource({
      ...resource,
      state: 'RUNNING',
      native: owned.identity,
      updatedAt: new Date().toISOString()
    });
    this.live.set(resource.id, owned);
    const completion = owned.completion.then(async (receipt): Promise<NativeServiceExit> => {
      this.live.delete(resource.id);
      const wasStopping = this.stopping.delete(resource.id);
      await Promise.all([
        this.store.syncArtifactByteCount(stdout.id),
        this.store.syncArtifactByteCount(stderr.id)
      ]);
      resource = await this.store.savePreviewResource({
        ...resource,
        state: wasStopping ? 'STOPPED' : receipt.state === 'FAILED' ? 'FAILED' : 'EXITED',
        updatedAt: new Date().toISOString()
      });
      attempt = await this.store.savePreviewNodeAttempt({
        ...attempt,
        state: wasStopping ? 'STOPPED' : 'FAILED',
        endedAt: new Date().toISOString(),
        exitCode: receipt.exitCode,
        signal: receipt.signal as NodeJS.Signals | null | undefined
      });
      return { receipt, wasStopping };
    }).catch(async (error: unknown) => {
      this.live.delete(resource.id);
      this.stopping.delete(resource.id);
      const endedAt = new Date().toISOString();
      await Promise.allSettled([
        this.store.syncArtifactByteCount(stdout.id),
        this.store.syncArtifactByteCount(stderr.id),
        this.store.savePreviewResource({
          ...resource,
          state: 'CLEANUP_INCOMPLETE',
          cleanupError: boundedError(error),
          updatedAt: endedAt
        }),
        this.store.savePreviewNodeAttempt({
          ...attempt,
          state: 'RECOVERY_REQUIRED',
          endedAt
        })
      ]);
      throw error;
    });
    void completion.catch(() => undefined);
    return {
      attempt,
      resource,
      owned,
      stdoutArtifactId: stdout.id,
      stderrArtifactId: stderr.id,
      completion,
      isRunning: () => this.live.has(resource.id)
    };
  }

  async stop(resource: PreviewNativeResourceRecord): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    this.stopping.add(resource.id);
    const owned = this.live.get(resource.id);
    let result: 'STOPPED' | 'ALREADY_EXITED' | 'REFUSED';
    if (owned) {
      await owned.stop();
      result = 'STOPPED';
    } else if (resource.native) {
      result = await this.launcherHost.stopVerified(resource.native);
    } else if (
      resource.receiptPath &&
      (await this.launcherHost.inspectUnverifiedReceipt(resource.receiptPath)) ===
        'NO_PROCESS_OBSERVED'
    ) {
      result = 'ALREADY_EXITED';
    } else {
      result = 'REFUSED';
    }
    this.live.delete(resource.id);
    this.stopping.delete(resource.id);
    await this.store.savePreviewResource({
      ...resource,
      state: result === 'REFUSED' ? 'CLEANUP_INCOMPLETE' : 'STOPPED',
      cleanupAttemptedAt: new Date().toISOString(),
      cleanupError: result === 'REFUSED' ? 'Native process identity could not be verified.' : undefined,
      updatedAt: new Date().toISOString()
    });
    return result;
  }
}

function literalEnvironment(
  env: PreviewServicePlan['env'] | PreviewWorkerPlan['env']
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new Error(`Preview environment reference ${key} was not resolved before launch.`);
    }
    result[key] = value;
  }
  return result;
}
