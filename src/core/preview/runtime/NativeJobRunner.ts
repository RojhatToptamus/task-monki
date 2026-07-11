import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  PreviewJobPlan,
  PreviewNativeResourceRecord,
  PreviewNodeKind,
  PreviewNodeAttemptRecord
} from '../../../shared/contracts';
import { canonicalProspectivePath, isPathWithin } from '../PreviewPaths';
import { buildPreviewEnvironment } from '../PreviewEnvironment';
import { FileTaskStore } from '../../storage/FileTaskStore';
import {
  digestCommand,
  NativeLauncherHost,
  type NativeLauncherReceipt,
  type NativeOwnedProcess
} from './NativeLauncherHost';

export interface NativeJobResult {
  attempt: PreviewNodeAttemptRecord;
  resource: PreviewNativeResourceRecord;
  receipt: NativeLauncherReceipt;
}

export class NativeJobRunner {
  constructor(
    private readonly store: FileTaskStore,
    private readonly launcherHost: NativeLauncherHost
  ) {}

  async run(input: {
    taskId: string;
    generationId: string;
    generationRoot: string;
    sourcePath: string;
    markerDigest: string;
    node: PreviewJobPlan;
    kind?: Extract<PreviewNodeKind, 'JOB' | 'PROBE'>;
    attempt?: number;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<NativeJobResult> {
    const cwd = await resolvePreparedNodeCwd(input.sourcePath, input.node.cwd, input.node.id);
    const [executable, ...argv] = input.node.command;
    const commandDigest = digestCommand(executable, argv, cwd);
    const stdout = await this.store.createPreviewArtifact(input.taskId, 'preview-stdout');
    const stderr = await this.store.createPreviewArtifact(input.taskId, 'preview-stderr');
    const now = new Date().toISOString();
    let attempt: PreviewNodeAttemptRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      generationId: input.generationId,
      nodeId: input.node.id,
      kind: input.kind ?? 'JOB',
      attempt: input.attempt ?? 1,
      commandDigest,
      state: 'INTENDED',
      stdoutArtifactId: stdout.id,
      stderrArtifactId: stderr.id
    };
    attempt = await this.store.savePreviewNodeAttempt(attempt);
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
      env: buildPreviewEnvironment({ recipe: input.env }),
      stdoutPath: stdout.path,
      stderrPath: stderr.path,
      persistPrepared: async (identity) => {
        resource = await this.store.savePreviewResource({
          ...resource,
          state: 'PREPARED',
          native: identity,
          updatedAt: new Date().toISOString()
        });
        attempt = await this.store.savePreviewNodeAttempt({
          ...attempt,
          state: 'PREPARING_LAUNCHER'
        });
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
    let receipt: NativeLauncherReceipt;
    let timedOut = false;
    let canceled = false;
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => {
      canceled = true;
      void owned.stop().catch(() => undefined);
    };
    try {
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          void owned.stop().catch(() => undefined);
        }, input.timeoutMs);
        timeout.unref();
      }
      receipt = await owned.completion;
    } catch (error) {
      await Promise.allSettled([
        this.store.syncArtifactByteCount(stdout.id),
        this.store.syncArtifactByteCount(stderr.id)
      ]);
      const endedAt = new Date().toISOString();
      attempt = await this.store.savePreviewNodeAttempt({
        ...attempt,
        state: 'RECOVERY_REQUIRED',
        startedAt: attempt.startedAt ?? now,
        endedAt
      });
      resource = await this.store.savePreviewResource({
        ...resource,
        state: 'CLEANUP_INCOMPLETE',
        native: owned.identity,
        cleanupError: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        updatedAt: endedAt
      });
      throw new PreviewJobCompletionAmbiguousError(
        input.node.id,
        input.node.role,
        input.node.retrySafe,
        error
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
    }
    await Promise.all([
      this.store.syncArtifactByteCount(stdout.id),
      this.store.syncArtifactByteCount(stderr.id)
    ]);
    const succeeded = !timedOut && !canceled && receipt.state === 'EXITED' && receipt.exitCode === 0;
    attempt = await this.store.savePreviewNodeAttempt({
      ...attempt,
      state: succeeded ? 'SUCCEEDED' : canceled ? 'STOPPED' : 'FAILED',
      startedAt: attempt.startedAt ?? now,
      endedAt: new Date().toISOString(),
      exitCode: receipt.exitCode,
      signal: asSignal(receipt.signal)
    });
    resource = await this.store.savePreviewResource({
      ...resource,
      state: succeeded ? 'EXITED' : canceled ? 'STOPPED' : 'FAILED',
      native: owned.identity,
      updatedAt: new Date().toISOString()
    });
    if (!succeeded) {
      if (canceled) {
        const error = new Error(`Preview node ${input.node.id} was canceled.`);
        error.name = 'AbortError';
        throw error;
      }
      if (timedOut) {
        throw new Error(`Preview probe ${input.node.id} timed out after ${input.timeoutMs}ms.`);
      }
      throw new PreviewJobFailure(input.node.id, receipt, attempt, resource);
    }
    return { attempt, resource, receipt };
  }
}

export class PreviewJobFailure extends Error {
  constructor(
    nodeId: string,
    readonly receipt: NativeLauncherReceipt,
    readonly attempt: PreviewNodeAttemptRecord,
    readonly resource: PreviewNativeResourceRecord
  ) {
    super(`Preview job ${nodeId} failed with ${receipt.exitCode ?? receipt.signal ?? receipt.state}.`);
  }
}

export class PreviewJobCompletionAmbiguousError extends Error {
  constructor(
    nodeId: string,
    readonly role: PreviewJobPlan['role'],
    readonly retrySafe: boolean,
    cause: unknown
  ) {
    super(
      `Preview ${role} job ${nodeId} completion is ambiguous; automatic rerun is ${retrySafe ? 'permitted only after verified cleanup' : 'blocked'}.`,
      { cause }
    );
  }
}

export async function resolvePreparedNodeCwd(
  sourcePath: string,
  relativeCwd: string,
  nodeId: string
): Promise<string> {
  const root = await canonicalProspectivePath(sourcePath);
  const cwd = await canonicalProspectivePath(path.join(sourcePath, relativeCwd));
  if (!isPathWithin(root, cwd)) {
    throw new Error(`Preview node ${nodeId} cwd escapes the prepared source.`);
  }
  return cwd;
}

function asSignal(value: string | null | undefined): NodeJS.Signals | null | undefined {
  return value as NodeJS.Signals | null | undefined;
}
