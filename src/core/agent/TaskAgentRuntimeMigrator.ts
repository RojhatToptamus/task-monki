import crypto from 'node:crypto';
import path from 'node:path';
import type { AgentSessionRecord, RunRecord, TaskSnapshot } from '../../shared/contracts';
import type {
  AgentExecutionContext,
  AgentRuntimePurpose,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../shared/agentRuntime';
import type { FileTaskStore } from '../storage/FileTaskStore';
import { createAgentSessionAccessEpoch } from './AgentRuntimeOwnership';
import type { AgentRuntimeStore } from './AgentRuntimeStore';

const LEGACY_REVIEW_TARGET = {
  type: 'CUSTOM' as const,
  instructions:
    'Historical detached review target was not stored by Task Monki schema 11 and is unavailable after runtime extraction.'
};

/**
 * One-way compatibility bridge for shipped schema-11 task runtime records.
 * The task store remains untouched as the rollback source. Legacy sessions are
 * explicitly un-attested and are therefore never reusable for a new turn.
 */
export class TaskAgentRuntimeMigrator {
  constructor(
    private readonly tasks: FileTaskStore,
    private readonly runtime: AgentRuntimeStore
  ) {}

  async migrateTaskStoreV11(): Promise<void> {
    await this.runtime.init();
    if (await this.runtime.getTaskStoreV11Migration()) return;
    const snapshot = await this.tasks.snapshot();
    const sourceSha256 = migrationSourceHash(snapshot);

    for (const legacySession of snapshot.agentSessions) {
      await this.importSession(legacySession);
    }
    for (const legacyRun of snapshot.runs) {
      await this.importRun(legacyRun);
    }
    await this.importTelemetry(snapshot);
    await this.runtime.recordTaskStoreV11Migration({
      sourceSha256,
      sessionCount: snapshot.agentSessions.length,
      runCount: snapshot.runs.length,
      operationId: `task-store-v11-import:${sourceSha256}`
    });
  }

  private async importTelemetry(snapshot: TaskSnapshot): Promise<void> {
    for (const server of snapshot.agentServers) {
      await this.runtime.recordTelemetry({
        id: migrationTelemetryId('server', server.id),
        kind: 'SERVER',
        serverInstanceId: server.id,
        providerIdentity: server.provider,
        clientOperationId: `task-store-v11-server:${server.id}`,
        payload: server,
        observedAt:
          server.exitedAt ?? server.disconnectedAt ?? server.lastHealthAt ?? server.startedAt
      });
    }
    for (const item of snapshot.agentItems) {
      await this.recordTaskTelemetry('ITEM', item.id, item.taskId, item.sessionId, item.runId, item, item.updatedAt);
    }
    for (const interaction of snapshot.interactionRequests) {
      await this.recordTaskTelemetry(
        'INTERACTION',
        interaction.id,
        interaction.taskId,
        interaction.sessionId,
        interaction.runId,
        interaction,
        interaction.resolvedAt ?? interaction.respondedAt ?? interaction.requestedAt
      );
    }
    for (const goal of snapshot.agentGoalSnapshots) {
      await this.recordTaskTelemetry('GOAL', goal.id, goal.taskId, goal.sessionId, undefined, goal, goal.observedAt);
    }
    for (const plan of snapshot.agentPlanRevisions) {
      await this.recordTaskTelemetry('PLAN', plan.id, plan.taskId, plan.sessionId, plan.runId, plan, plan.observedAt);
    }
    for (const usage of snapshot.agentUsageSnapshots) {
      await this.recordTaskTelemetry('USAGE', usage.id, usage.taskId, usage.sessionId, usage.runId, usage, usage.observedAt);
    }
    for (const settings of snapshot.agentSettingsObservations) {
      await this.recordTaskTelemetry('SETTINGS', settings.id, settings.taskId, settings.sessionId, settings.runId, settings, settings.observedAt);
    }
    for (const subagent of snapshot.agentSubagentObservations) {
      await this.recordTaskTelemetry('SUBAGENT', subagent.id, subagent.taskId, subagent.sessionId, subagent.parentRunId, subagent, subagent.observedAt);
    }
  }

  private async recordTaskTelemetry(
    kind: 'ITEM' | 'INTERACTION' | 'GOAL' | 'PLAN' | 'USAGE' | 'SETTINGS' | 'SUBAGENT',
    id: string,
    taskId: string,
    sessionId: string,
    runId: string | undefined,
    payload: unknown,
    observedAt: string
  ): Promise<void> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) {
      throw new Error(`Schema-11 ${kind.toLowerCase()} telemetry has no imported session.`);
    }
    const resolvedRunId = runId && (await this.runtime.getRun(runId)) ? runId : undefined;
    await this.runtime.recordTelemetry({
      id: migrationTelemetryId(kind.toLowerCase(), id),
      kind,
      owner: { kind: 'TASK', taskId },
      sessionId,
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      clientOperationId: `task-store-v11-${kind.toLowerCase()}:${id}`,
      payload: stripLegacyTaskScope(payload),
      observedAt
    });
  }

  private async importSession(
    legacy: AgentSessionRecord
  ): Promise<AgentRuntimeSessionRecord> {
    const existing = await this.runtime.getSession(legacy.id);
    if (existing) {
      assertLegacyOwner(existing, legacy.taskId);
      return existing;
    }
    const owner = { kind: 'TASK' as const, taskId: legacy.taskId };
    const executionContext = legacyExecutionContext(legacy);
    const accessEpoch = createAgentSessionAccessEpoch({
      owner,
      sessionId: legacy.id,
      epoch: 1,
      providerId: legacy.provider,
      model: legacy.requestedSettings.model ?? 'legacy-unresolved-model',
      executionContext,
      createdAt: legacy.createdAt
    });
    return this.runtime.createSession({
      id: legacy.id,
      owner,
      accessEpoch,
      executionContext,
      clientOperationId: `task-store-v11-session:${legacy.id}`,
      provider: legacy.provider,
      role: legacy.role,
      providerSessionId: legacy.providerSessionId,
      providerSessionTreeId: legacy.providerSessionTreeId,
      parentSessionId: legacy.parentSessionId,
      forkedFromSessionId: legacy.forkedFromSessionId,
      providerParentSessionId: legacy.providerParentSessionId,
      providerForkedFromSessionId: legacy.providerForkedFromSessionId,
      parentRunId: legacy.parentRunId,
      relationshipState: legacy.relationshipState,
      relationshipDetail: legacy.relationshipDetail,
      providerNickname: legacy.providerNickname,
      providerRole: legacy.providerRole,
      delegatedPrompt: legacy.delegatedPrompt,
      agentPath: legacy.agentPath,
      subagentStatus: legacy.subagentStatus,
      status: legacy.status,
      materialized: legacy.materialized,
      requestedSettings: legacy.requestedSettings,
      observedSettings: legacy.observedSettings
    });
  }

  private async importRun(legacy: RunRecord): Promise<AgentRuntimeRunRecord> {
    const existing = await this.runtime.getRun(legacy.id);
    if (existing) {
      assertLegacyOwner(existing, legacy.taskId);
      return existing;
    }
    const session = await this.runtime.getSession(legacy.sessionId);
    if (!session) {
      throw new Error(`Schema-11 task run ${legacy.id} has no imported session.`);
    }
    const run = await this.runtime.createRun({
      id: legacy.id,
      owner: { kind: 'TASK', taskId: legacy.taskId },
      scope: {
        kind: 'TASK',
        taskId: legacy.taskId,
        iterationId: legacy.iterationId,
        worktreeId: legacy.worktreeId
      },
      sessionId: session.id,
      sessionAccessEpoch: session.accessEpoch.epoch,
      serverInstanceId: legacy.serverInstanceId,
      providerTurnId: legacy.providerTurnId,
      purpose: legacyPurpose(legacy),
      parentRunId: legacy.parentRunId ?? legacy.continuedFromRunId,
      ...(legacy.mode === 'REVIEW' ? { taskReviewTarget: LEGACY_REVIEW_TARGET } : {}),
      generationKey: legacy.generationKey ?? `legacy-task-run-${legacy.id}`,
      clientOperationId: `task-store-v11-run:${legacy.id}`,
      requestedSettings: legacy.requestedSettings,
      observedSettings: legacy.observedSettings,
      promptArtifactId: legacy.promptArtifactId,
      outputArtifactId: legacy.outputArtifactId,
      diagnosticArtifactId: legacy.diagnosticArtifactId,
      finalArtifactId: legacy.finalArtifactId,
      terminalReason: legacy.terminalReason,
      providerTerminalSource: legacy.providerTerminalSource
    });
    await this.importArtifact(run, legacy.promptArtifactId, 'PROMPT');
    await this.importArtifact(run, legacy.outputArtifactId, 'OUTPUT');
    await this.importArtifact(run, legacy.diagnosticArtifactId, 'DIAGNOSTIC');
    if (legacy.finalArtifactId) {
      await this.importArtifact(run, legacy.finalArtifactId, 'FINAL');
    }

    if (isLegacyTerminal(legacy)) {
      return this.importTerminalRun(run, legacy);
    }
    const entry = await this.runtime.enqueueRun(
      run.id,
      'TASK_FOREGROUND',
      `task-store-v11-enqueue:${run.id}`
    );
    await this.runtime.leaseQueueEntry(
      entry.id,
      entry.recordRevision,
      `task-store-v11-lease:${run.id}`
    );
    return this.transitionLegacyProviderRun(run, legacy, {
      status: 'RECOVERY_REQUIRED',
      delivery: 'AMBIGUOUS',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason:
        legacy.terminalReason ??
        'This task turn was active before owner-neutral runtime delivery checkpoints existed; Task Monki will not replay it automatically.',
      lastEventAt: legacy.lastEventAt ?? legacy.startedAt
    });
  }

  private async importArtifact(
    run: AgentRuntimeRunRecord,
    artifactId: string,
    kind: 'PROMPT' | 'OUTPUT' | 'DIAGNOSTIC' | 'FINAL'
  ): Promise<void> {
    if (await this.runtime.getArtifact(artifactId)) return;
    await this.runtime.createArtifact({
      id: artifactId,
      owner: run.owner,
      runId: run.id,
      kind,
      clientOperationId: `task-store-v11-artifact:${artifactId}`,
      content: await this.tasks.readArtifact(artifactId)
    });
  }

  private async importTerminalRun(
    runtimeRun: AgentRuntimeRunRecord,
    legacy: RunRecord
  ): Promise<AgentRuntimeRunRecord> {
    const providerReached = Boolean(legacy.providerTurnId) || legacy.status === 'COMPLETED';
    if (!providerReached) {
      return this.runtime.updateRun(
        runtimeRun.id,
        runtimeRun.recordRevision,
        {
          status: legacy.status,
          delivery: 'NOT_DELIVERED',
          recoveryState: legacy.recoveryState,
          terminalReason: legacy.terminalReason,
          lastEventAt: legacy.lastEventAt ?? legacy.endedAt,
          endedAt: legacy.endedAt ?? legacy.lastEventAt ?? legacy.startedAt
        },
        `task-store-v11-terminal-not-delivered:${legacy.id}`
      );
    }
    return this.transitionLegacyProviderRun(runtimeRun, legacy, {
      status: legacy.status,
      delivery: 'TERMINAL',
      recoveryState: legacy.recoveryState,
      terminalReason: legacy.terminalReason,
      providerTerminalSource: legacy.providerTerminalSource,
      lastEventAt: legacy.lastEventAt ?? legacy.endedAt,
      endedAt: legacy.endedAt ?? legacy.lastEventAt ?? legacy.startedAt
    });
  }

  private async transitionLegacyProviderRun(
    initial: AgentRuntimeRunRecord,
    legacy: RunRecord,
    terminal: Parameters<AgentRuntimeStore['updateRun']>[2]
  ): Promise<AgentRuntimeRunRecord> {
    let run = await this.runtime.updateRun(
      initial.id,
      initial.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: legacy.startedAt,
        lastEventAt: legacy.lastEventAt ?? legacy.startedAt
      },
      `task-store-v11-starting:${legacy.id}`
    );
    run = await this.runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'RUNNING',
        delivery: 'ACKNOWLEDGED',
        lastEventAt: legacy.lastEventAt ?? legacy.startedAt
      },
      `task-store-v11-acknowledged:${legacy.id}`
    );
    return this.runtime.updateRun(
      run.id,
      run.recordRevision,
      terminal,
      `task-store-v11-final-state:${legacy.id}`
    );
  }
}

function legacyExecutionContext(session: AgentSessionRecord): AgentExecutionContext {
  const primaryCwd = path.resolve(session.worktreePath);
  return {
    attestation: {
      status: 'LEGACY_UNATTESTED',
      reason:
        'Schema-11 did not persist a complete provider permission/tool/attachment attestation.'
    },
    primaryCwd,
    readRoots: [
      { canonicalPath: primaryCwd, kind: 'WORKTREE', entityId: session.worktreeId }
    ],
    managedAttachments: [],
    permissionProfileHash: crypto
      .createHash('sha256')
      .update(`legacy-unattested:${session.id}:${primaryCwd}`)
      .digest('hex'),
    modelSettings: session.requestedSettings,
    externalTools: {
      network: session.requestedSettings.networkAccess === true,
      webSearch: 'disabled',
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: `task-store-v11-context:${session.id}`
  };
}

function migrationSourceHash(snapshot: TaskSnapshot): string {
  return crypto
    .createHash('sha256')
    .update(stableJson({
      schemaVersion: snapshot.schemaVersion,
      sessions: snapshot.agentSessions,
      runs: snapshot.runs,
      artifacts: snapshot.artifacts
        .filter((artifact) => artifact.runId)
        .map(({ id, taskId, runId, kind, byteCount, updatedAt }) => ({
          id,
          taskId,
          runId,
          kind,
          byteCount,
          updatedAt
        }))
    }))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyPurpose(run: RunRecord): AgentRuntimePurpose {
  switch (run.mode) {
    case 'REVIEW':
      return 'TASK_REVIEW';
    case 'FOLLOW_UP':
    case 'COMPACTION':
      return 'TASK_FOLLOW_UP';
    case 'RETRY':
      return 'TASK_RETRY';
    case 'SUBAGENT':
      return 'PROVIDER_SUBAGENT';
    case 'ANALYSIS':
    case 'IMPLEMENTATION':
      return 'TASK_IMPLEMENTATION';
  }
}

function isLegacyTerminal(run: RunRecord): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(run.status);
}

function assertLegacyOwner(
  record: AgentRuntimeSessionRecord | AgentRuntimeRunRecord,
  taskId: string
): void {
  if (record.owner.kind !== 'TASK' || record.owner.taskId !== taskId) {
    throw new Error('Existing owner-neutral runtime record conflicts with schema-11 task ownership.');
  }
}

function migrationTelemetryId(kind: string, id: string): string {
  const candidate = `legacy-${kind}-${id}`;
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(candidate)) return candidate;
  return `legacy-${kind}-${crypto.createHash('sha256').update(id).digest('hex')}`;
}

function stripLegacyTaskScope(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const {
    taskId: _taskId,
    iterationId: _iterationId,
    runId: _runId,
    sessionId: _sessionId,
    ...ownerNeutral
  } = payload as Record<string, unknown>;
  return ownerNeutral;
}
