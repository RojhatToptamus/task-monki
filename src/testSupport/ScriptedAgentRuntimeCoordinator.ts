import type {
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../shared/agentRuntime';
import type {
  AgentRuntimeCoordinator,
  AgentRuntimeTurnEvent,
  PrepareAgentRuntimeTurnInput
} from '../core/agent/AgentRuntimeCoordinator';
import { AgentMutationAmbiguousError } from '../core/agent/AgentRuntimeAdapter';
import { createAgentSessionAccessEpoch } from '../core/agent/AgentRuntimeOwnership';
import { FileAgentRuntimeStore } from '../core/storage/FileAgentRuntimeStore';

export interface ScriptedRuntimeStartCall {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  prompt: string;
}

interface ScriptedRuntimeStartResult {
  serverInstanceId: string;
  providerSessionId: string;
  providerSessionTreeId?: string;
  providerTurnId: string;
  startedAt: string;
}

/** Small runtime-lifecycle fake for workflow tests. */
export class ScriptedAgentRuntimeCoordinator implements AgentRuntimeCoordinator {
  readonly calls: ScriptedRuntimeStartCall[] = [];
  readonly interruptCalls: string[] = [];
  ambiguousInterrupt = false;
  notDeliveredInterrupt = false;
  startHook?: (
    input: ScriptedRuntimeStartCall
  ) => Promise<ScriptedRuntimeStartResult>;

  private readonly listeners = new Set<(event: AgentRuntimeTurnEvent) => void>();
  private startSequence = 0;

  constructor(private readonly runtime: FileAgentRuntimeStore) {}

  hasRuntime(runtimeId: string): boolean {
    return runtimeId === 'codex';
  }

  async buildExecutionContext(
    runtimeId: string,
    input: Parameters<AgentRuntimeCoordinator['buildExecutionContext']>[1]
  ) {
    if (!this.hasRuntime(runtimeId)) throw new Error(`Unknown runtime: ${runtimeId}`);
    return {
      attestation: { status: 'ATTESTED' as const },
      primaryCwd: input.primaryCwd,
      readRoots: input.readRoots,
      managedAttachments: [],
      permissionProfileHash: 'd'.repeat(64),
      modelSettings: {
        ...input.modelSettings,
        runtimeId,
        sandbox: 'READ_ONLY' as const,
        approvalPolicy: 'NEVER' as const,
        networkAccess: false
      },
      externalTools: {
        network: false,
        webSearch: 'disabled' as const,
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: input.clientOperationId
    };
  }

  async prepareTurn(input: PrepareAgentRuntimeTurnInput) {
    const promptArtifactId = `${input.runId}-prompt`;
    const outputArtifactId = `${input.runId}-output`;
    const diagnosticArtifactId = `${input.runId}-diagnostic`;
    return this.runtime.prepareRuntimeTurn({
      session: {
        id: input.sessionId,
        owner: input.owner,
        accessEpoch: createAgentSessionAccessEpoch({
          owner: input.owner,
          sessionId: input.sessionId,
          epoch: 1,
          runtimeId: input.runtimeId,
          model: input.model,
          executionContext: input.executionContext,
          createdAt: input.createdAt
        }),
        executionContext: input.executionContext,
        clientOperationId: `${input.clientOperationId}:session`,
        runtimeId: input.runtimeId,
        role: 'PRIMARY',
        relationshipState: 'ROOT',
        status: 'NOT_MATERIALIZED',
        materialized: false,
        requestedSettings: input.executionContext.modelSettings
      },
      run: {
        id: input.runId,
        owner: input.owner,
        scope: input.scope,
        sessionId: input.sessionId,
        sessionAccessEpoch: 1,
        purpose: input.purpose,
        generationKey: input.generationKey,
        clientOperationId: `${input.clientOperationId}:run`,
        requestedSettings: input.executionContext.modelSettings,
        promptArtifactId,
        outputArtifactId,
        diagnosticArtifactId
      },
      prompt: input.prompt,
      priority: input.priority,
      queueOperationId: `${input.clientOperationId}:enqueue`,
      notBefore: input.notBefore
    });
  }

  async startPreparedTurn(queueEntryId: string, clientOperationId: string) {
    const snapshot = await this.runtime.snapshot();
    const entry = snapshot.queueEntries.find((candidate) => candidate.id === queueEntryId);
    if (!entry || entry.status !== 'LEASED') throw new Error('Expected a leased turn.');
    let run = snapshot.runs.find((candidate) => candidate.id === entry.runId)!;
    let session = snapshot.sessions.find((candidate) => candidate.id === run.sessionId)!;
    const prompt = await this.runtime.readArtifact(run.promptArtifactId);
    run = await this.runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:07:00.000Z',
        lastEventAt: '2026-07-13T00:07:00.000Z'
      },
      `${clientOperationId}:runtime-starting`
    );
    const call = {
      session,
      run,
      prompt
    };
    this.calls.push(call);
    if (
      run.owner.kind !== 'DISCOURSE' ||
      session.executionContext.modelSettings.sandbox !== 'READ_ONLY' ||
      session.executionContext.externalTools.network
    ) {
      throw new Error('Scripted Discourse turn did not keep its read-only boundary.');
    }
    const sequence = ++this.startSequence;
    const started = this.startHook
      ? await this.startHook(call)
      : {
          serverInstanceId: 'server-1',
          providerSessionId: `provider-session-${sequence}`,
          providerTurnId: `provider-turn-${sequence}`,
          startedAt: '2026-07-13T00:07:00.000Z'
        };
    session = (await this.runtime.getSession(session.id)) ?? session;
    run = (await this.runtime.getRun(run.id)) ?? run;
    if (run.status === 'RUNNING' && run.delivery === 'ACKNOWLEDGED') return run;
    if (!session.providerSessionId) {
      session = await this.runtime.updateSession(
        session.id,
        session.recordRevision,
        {
          providerSessionId: started.providerSessionId,
          ...(started.providerSessionTreeId
            ? { providerSessionTreeId: started.providerSessionTreeId }
            : {}),
          status: 'ACTIVE',
          materialized: true,
          lastAttachedAt: started.startedAt
        },
        `${clientOperationId}:session-acknowledged`
      );
    }
    return this.runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        serverInstanceId: started.serverInstanceId,
        providerTurnId: started.providerTurnId,
        status: 'RUNNING',
        delivery: 'ACKNOWLEDGED',
        lastEventAt: started.startedAt
      },
      `${clientOperationId}:runtime-acknowledged`
    );
  }

  async cancelQueuedTurn(runId: string, reason: string, clientOperationId: string) {
    let run = (await this.runtime.getRun(runId))!;
    if (!isRuntimeTerminal(run.status)) {
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'INTERRUPTED',
          delivery: 'NOT_DELIVERED',
          recoveryState: 'NONE',
          terminalReason: reason,
          lastEventAt: '2026-07-13T00:07:00.000Z',
          endedAt: '2026-07-13T00:07:00.000Z'
        },
        `${clientOperationId}:run`
      );
    }
    const entry = (await this.runtime.snapshot()).queueEntries.find(
      (candidate) => candidate.runId === run.id
    );
    if (entry?.status === 'QUEUED') {
      await this.runtime.cancelQueueEntry(
        entry.id,
        entry.recordRevision,
        reason,
        `${clientOperationId}:queue`
      );
    } else if (entry?.status === 'LEASED') {
      await this.runtime.settleQueueEntry(
        entry.id,
        entry.recordRevision,
        `${clientOperationId}:queue`
      );
    }
    return run;
  }

  async interruptTurn(runId: string, reason: string, clientOperationId: string) {
    let run = (await this.runtime.getRun(runId))!;
    if (isRuntimeTerminal(run.status)) return run;
    if (run.status === 'INTERRUPTING') {
      if (run.interruptDelivery === 'ACKNOWLEDGED') return run;
      if (run.interruptDelivery === 'SENDING') {
        return this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            interruptDelivery: 'AMBIGUOUS',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason: 'A durable interrupt intent has no authoritative delivery result.',
            lastEventAt: '2026-07-13T00:07:00.000Z'
          },
          `${clientOperationId}:existing-ambiguity`
        );
      }
    }
    if (
      run.status === 'RECOVERY_REQUIRED' &&
      ['NOT_SENT', 'NOT_DELIVERED'].includes(run.delivery)
    ) {
      return this.cancelQueuedTurn(run.id, reason, clientOperationId);
    }
    if (run.status === 'RECOVERY_REQUIRED') {
      if (
        run.interruptDelivery === 'AMBIGUOUS' ||
        run.interruptDelivery === 'SENDING'
      ) {
        return run;
      }
      if (run.delivery !== 'ACKNOWLEDGED' || !run.providerTurnId) return run;
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'RUNNING',
          interruptDelivery: undefined,
          stopRequestedAt: undefined,
          recoveryState: 'NONE',
          lastEventAt: '2026-07-13T00:07:00.000Z'
        },
        `${clientOperationId}:rearm`
      );
    }
    run = await this.runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTING',
        interruptDelivery: 'SENDING',
        stopRequestedAt: '2026-07-13T00:07:00.000Z',
        terminalReason: reason,
        lastEventAt: '2026-07-13T00:07:00.000Z'
      },
      `${clientOperationId}:intent`
    );
    this.interruptCalls.push(run.id);
    if (this.ambiguousInterrupt || this.notDeliveredInterrupt) {
      const delivery = this.ambiguousInterrupt ? 'AMBIGUOUS' : 'NOT_DELIVERED';
      const message = this.ambiguousInterrupt
        ? 'Provider interrupt response was lost.'
        : 'Provider rejected the interrupt before delivery.';
      await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'RECOVERY_REQUIRED',
          interruptDelivery: delivery,
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: message,
          lastEventAt: '2026-07-13T00:07:00.000Z'
        },
        `${clientOperationId}:recovery`
      );
      if (this.ambiguousInterrupt) {
        throw new AgentMutationAmbiguousError('turn/interrupt', message);
      }
      throw new Error(message);
    }
    return this.runtime.updateRun(
      run.id,
      run.recordRevision,
      { interruptDelivery: 'ACKNOWLEDGED', lastEventAt: '2026-07-13T00:07:00.000Z' },
      `${clientOperationId}:acknowledged`
    );
  }

  subscribe(listener: (event: AgentRuntimeTurnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentRuntimeTurnEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isRuntimeTerminal(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}
