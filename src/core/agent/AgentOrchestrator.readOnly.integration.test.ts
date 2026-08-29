import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { git } from '../git/gitCli';
import { AppEventBus } from '../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { AgentOrchestrator } from './AgentOrchestrator';

describe('AgentOrchestrator read-only repository boundary', () => {
  it('accepts a completed turn only when the repository stays unchanged', async () => {
    const fixture = await createFixture('unchanged');
    fixture.adapter.nextRuntimeTurnResult = { output: 'Read-only result.' };

    const runId = await startReadOnlyTurn(fixture, 'unchanged');
    const result = await fixture.orchestrator.waitForRuntimeTurn(runId, 3_000);

    expect(result.run).toMatchObject({
      status: 'COMPLETED',
      repositoryIntegrity: {
        status: 'UNCHANGED',
        beforeFingerprint: expect.any(String),
        afterFingerprint: expect.any(String)
      }
    });
  });

  it('fails the turn and leaves repository changes as evidence', async () => {
    const fixture = await createFixture('changed');
    fixture.adapter.beforeNextRuntimeTurnTerminal = () =>
      fs.writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Changed\n');
    fixture.adapter.nextRuntimeTurnResult = { output: 'Unsafe result.' };

    const runId = await startReadOnlyTurn(fixture, 'changed');
    const result = await fixture.orchestrator.waitForRuntimeTurn(runId, 3_000);

    expect(result.run).toMatchObject({
      status: 'FAILED',
      providerTerminalSource: 'REPOSITORY_INTEGRITY',
      repositoryIntegrity: {
        status: 'CHANGED',
        beforeFingerprint: expect.any(String),
        afterFingerprint: expect.any(String)
      }
    });
    await expect(
      fs.readFile(path.join(fixture.repositoryPath, 'README.md'), 'utf8')
    ).resolves.toBe('# Changed\n');
  });

  it('fails the turn when the provider leaves a clean commit', async () => {
    const fixture = await createFixture('clean-commit');
    const initialHead = (await git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    fixture.adapter.beforeNextRuntimeTurnTerminal = async () => {
      await fs.writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Committed\n');
      await git(fixture.repositoryPath, ['add', 'README.md']);
      await git(fixture.repositoryPath, ['commit', '-m', 'Provider mutation']);
    };
    fixture.adapter.nextRuntimeTurnResult = { output: 'Unsafe result.' };

    const runId = await startReadOnlyTurn(fixture, 'clean-commit');
    const result = await fixture.orchestrator.waitForRuntimeTurn(runId, 3_000);

    expect(result.run).toMatchObject({
      status: 'FAILED',
      providerTerminalSource: 'REPOSITORY_INTEGRITY',
      repositoryIntegrity: {
        status: 'CHANGED',
        beforeFingerprint: expect.any(String),
        afterFingerprint: expect.any(String)
      }
    });
    await expect(git(fixture.repositoryPath, ['status', '--porcelain'])).resolves.toBe('');
    expect((await git(fixture.repositoryPath, ['rev-parse', 'HEAD'])).trim()).not.toBe(
      initialHead
    );
  });

  it('fails the turn when the repository can no longer be inspected', async () => {
    const fixture = await createFixture('unverifiable');
    const unavailablePath = `${fixture.repositoryPath}-unavailable`;
    fixture.adapter.beforeNextRuntimeTurnTerminal = () =>
      fs.rename(fixture.repositoryPath, unavailablePath);
    fixture.adapter.nextRuntimeTurnResult = { output: 'Unverified result.' };

    const runId = await startReadOnlyTurn(fixture, 'unverifiable');
    try {
      const result = await fixture.orchestrator.waitForRuntimeTurn(runId, 3_000);

      expect(result.run).toMatchObject({
        status: 'FAILED',
        providerTerminalSource: 'REPOSITORY_INTEGRITY',
        repositoryIntegrity: {
          status: 'UNVERIFIABLE',
          beforeFingerprint: expect.any(String),
          detail: expect.stringContaining(
            'could not inspect the repository after the read-only turn'
          )
        }
      });
    } finally {
      await fs.rename(unavailablePath, fixture.repositoryPath);
    }
  });

  it('repairs pending repository evidence after a restart before accepting output', async () => {
    const fixture = await createFixture('restart');
    const runId = await startReadOnlyTurn(fixture, 'restart');
    const running = (await fixture.runtimeStore.getRun(runId))!;
    await fs.writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Changed after crash\n');
    await fixture.runtimeStore.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        providerTerminalSource: 'SCRIPTED_CRASH_BOUNDARY',
        lastEventAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      },
      `simulate-terminal-before-event:${runId}`
    );

    await fixture.orchestrator.initialize();

    await expect(fixture.runtimeStore.getRun(runId)).resolves.toMatchObject({
      status: 'FAILED',
      providerTerminalSource: 'REPOSITORY_INTEGRITY',
      repositoryIntegrity: { status: 'CHANGED' }
    });
  });

  it('checks the repository when the provider process is lost', async () => {
    const fixture = await createFixture('process-loss');
    const runId = await startReadOnlyTurn(fixture, 'process-loss');
    const running = (await fixture.runtimeStore.getRun(runId))!;
    await fs.writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Changed before loss\n');
    const observedAt = new Date().toISOString();
    const waiting = fixture.orchestrator.waitForRuntimeTurn(runId, 3_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovering = await fixture.runtimeStore.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'RECOVERY_REQUIRED',
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: 'Provider process was lost.',
        lastEventAt: observedAt
      },
      `simulate-process-loss:${runId}`
    );

    fixture.adapter.emitRuntimeTurnEvent({
      type: 'RECOVERY_REQUIRED',
      runId,
      providerTurnId: recovering.providerTurnId,
      reason: 'Provider process was lost.',
      observedAt
    });

    await expect(waiting).resolves.toMatchObject({
      run: {
        status: 'FAILED',
        repositoryIntegrity: { status: 'CHANGED' }
      }
    });
  });

  it('keeps an ambiguous stop inside the active repository boundary', async () => {
    const fixture = await createFixture('ambiguous-stop');
    const runId = await startReadOnlyTurn(fixture, 'ambiguous-stop');
    fixture.adapter.ambiguousRuntimeInterrupt = true;

    const stopped = await fixture.orchestrator.interruptTurn(
      runId,
      'Stop the read-only turn.',
      'ambiguous-stop:interrupt'
    );

    expect(stopped).toMatchObject({
      status: 'INTERRUPTING',
      interruptDelivery: 'AMBIGUOUS',
      recoveryState: 'NONE',
      repositoryIntegrity: {
        status: 'PENDING',
        beforeFingerprint: expect.any(String)
      }
    });
    expect(stopped.repositoryIntegrity?.afterFingerprint).toBeUndefined();
  });

  it('recovers a completed read-only turn when no repository root applies', async () => {
    const fixture = await createFixture('empty-managed');
    const runId = await startReadOnlyTurn(
      fixture,
      'empty-managed',
      'EMPTY_MANAGED'
    );
    const running = (await fixture.runtimeStore.getRun(runId))!;
    expect(running.repositoryIntegrity).toEqual({ status: 'PENDING' });
    const completedAt = new Date().toISOString();
    await fixture.runtimeStore.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        providerTerminalSource: 'SCRIPTED_CRASH_BOUNDARY',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `simulate-empty-managed-terminal:${runId}`
    );

    await fixture.orchestrator.initialize();

    await expect(fixture.runtimeStore.getRun(runId)).resolves.toMatchObject({
      status: 'COMPLETED',
      repositoryIntegrity: {
        status: 'UNCHANGED',
        checkedAt: completedAt
      }
    });
  });

  it('cleans up a preverified terminal prompt refinement after restart', async () => {
    const fixture = await createFixture('refinement-cleanup');
    const runId = await startReadOnlyTurn(
      fixture,
      'refinement-cleanup',
      'REPOSITORY',
      'PROMPT_REFINEMENT'
    );
    const running = (await fixture.runtimeStore.getRun(runId))!;
    const completedAt = new Date().toISOString();
    await fixture.runtimeStore.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        providerTerminalSource: 'SCRIPTED_CRASH_AFTER_INTEGRITY',
        repositoryIntegrity: {
          ...running.repositoryIntegrity,
          status: 'UNCHANGED',
          afterFingerprint: running.repositoryIntegrity?.beforeFingerprint,
          checkedAt: completedAt
        },
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      `simulate-refinement-terminal-after-integrity:${runId}`
    );

    await fixture.orchestrator.initialize();

    await expect(fixture.runtimeStore.snapshot()).resolves.toMatchObject({
      sessions: [],
      runs: [],
      artifacts: [],
      queueEntries: []
    });
  });

  it('rejects immediately when recovery is already durable', async () => {
    const fixture = await createFixture('stored-recovery');
    const runId = await startReadOnlyTurn(fixture, 'stored-recovery');
    await markRecoveryRequired(
      fixture.runtimeStore,
      runId,
      'The provider process was lost before completion.'
    );

    await expect(
      fixture.orchestrator.waitForRuntimeTurn(runId, 1_000)
    ).rejects.toThrow('The provider process was lost before completion.');
  });

  it('rejects when recovery becomes durable before subscription', async () => {
    const fixture = await createFixture('subscribe-recovery-race');
    const runId = await startReadOnlyTurn(fixture, 'subscribe-recovery-race');
    const readRun = fixture.runtimeStore.getRun.bind(fixture.runtimeStore);
    let matchingReads = 0;
    const getRun = vi
      .spyOn(fixture.runtimeStore, 'getRun')
      .mockImplementation(async (requestedRunId) => {
        const run = await readRun(requestedRunId);
        if (requestedRunId === runId && run && ++matchingReads === 1) {
          await markRecoveryRequired(
            fixture.runtimeStore,
            runId,
            'Recovery became durable before the listener was registered.'
          );
        }
        return run;
      });

    try {
      await expect(
        fixture.orchestrator.waitForRuntimeTurn(runId, 1_000)
      ).rejects.toThrow(
        'Recovery became durable before the listener was registered.'
      );
      expect(matchingReads).toBeGreaterThanOrEqual(2);
    } finally {
      getRun.mockRestore();
    }
  });
});

interface ReadOnlyFixture {
  adapter: ScriptedAgentRuntimeAdapter;
  orchestrator: AgentOrchestrator;
  repositoryPath: string;
  runtimeStore: FileAgentRuntimeStore;
}

async function createFixture(name: string): Promise<ReadOnlyFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-read-only-${name}-`));
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Initial\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);

  const taskStore = new FileTaskStore(path.join(root, 'task-store'));
  const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime-store'));
  const taskRuntime = runtimeStore.taskAgentRuntimeAccess((event, operationId) =>
    taskStore.recordAgentRuntimeEvent(event, operationId)
  );
  taskStore.bindAgentRuntime(taskRuntime);
  const adapter = new ScriptedAgentRuntimeAdapter(taskRuntime, runtimeStore);
  return {
    adapter,
    orchestrator: new AgentOrchestrator(
      taskStore,
      runtimeStore,
      new AppEventBus(),
      adapter
    ),
    repositoryPath,
    runtimeStore
  };
}

async function startReadOnlyTurn(
  fixture: ReadOnlyFixture,
  operation: string,
  readRootKind: 'REPOSITORY' | 'EMPTY_MANAGED' = 'REPOSITORY',
  workflow: 'DISCOURSE' | 'PROMPT_REFINEMENT' = 'DISCOURSE'
): Promise<string> {
  const sessionId = `session-${operation}`;
  const runId = `run-${operation}`;
  const settings = {
    runtimeId: 'codex',
    model: 'scenario-model',
    sandbox: 'READ_ONLY' as const,
    approvalPolicy: 'NEVER' as const,
    networkAccess: false
  };
  const executionContext = await fixture.adapter.buildExecutionContext!({
    sessionId,
    primaryCwd: fixture.repositoryPath,
    readRoots: [{ canonicalPath: fixture.repositoryPath, kind: readRootKind }],
    modelSettings: settings,
    clientOperationId: `read-only:${operation}`,
    attachments: []
  });
  const prepared = await fixture.orchestrator.prepareTurn({
    sessionId,
    runId,
    owner:
      workflow === 'PROMPT_REFINEMENT'
        ? { kind: 'PROMPT_REFINEMENT', requestId: operation }
        : {
            kind: 'DISCOURSE',
            conversationId: `conversation-${operation}`,
            stableParticipantId: 'participant'
          },
    scope:
      workflow === 'PROMPT_REFINEMENT'
        ? { kind: 'PROMPT_REFINEMENT', requestId: operation }
        : {
            kind: 'DISCOURSE',
            conversationId: `conversation-${operation}`,
            waveId: 'wave',
            jobId: 'job',
            contextSnapshotId: 'context',
            attemptId: 'attempt'
          },
    runtimeId: 'codex',
    model: 'scenario-model',
    purpose: workflow === 'PROMPT_REFINEMENT' ? 'PROMPT_REFINEMENT' : 'DISCOURSE_ANSWER',
    generationKey: operation,
    executionContext,
    prompt: 'Inspect the repository without changing it.',
    priority: 'TASK_FOREGROUND',
    clientOperationId: `read-only:${operation}`,
    createdAt: new Date().toISOString()
  });
  await fixture.orchestrator.startPreparedTurnNow(
    prepared.queueEntry.id,
    `read-only:${operation}:start`
  );
  return runId;
}

async function markRecoveryRequired(
  runtimeStore: FileAgentRuntimeStore,
  runId: string,
  terminalReason: string
): Promise<void> {
  const run = await runtimeStore.getRun(runId);
  if (!run) throw new Error(`Runtime run not found: ${runId}`);
  await runtimeStore.updateRun(
    run.id,
    run.recordRevision,
    {
      status: 'RECOVERY_REQUIRED',
      delivery: 'ACKNOWLEDGED',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason,
      lastEventAt: new Date().toISOString()
    },
    `test-recovery-required:${runId}`
  );
}
