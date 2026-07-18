import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskMonkiScenario } from '../../testSupport/taskMonkiScenario';
import { buildRunProgressViewModel } from '../../renderer/model/runProgress';
import type { RunRecord } from '../../shared/contracts';

describe('TaskManagerService progress harness', () => {
  it('starts a throwaway-repo run with progress guidance and projects useful fallback progress', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-progress-harness'
    });
    try {
      const task = await scenario.createTask({
        title: 'Improve throwaway progress',
        prompt: 'Add a hello.txt file and verify the repository status.'
      });

      const run = await scenario.service.startRun({ taskId: task.id });
      const providerPrompt = scenario.agent.startedTurns[0]?.prompt ?? '';
      expect(providerPrompt).toContain('Task Monki progress contract');
      expect(providerPrompt).toContain('Keep exactly one step in progress');
      expect(providerPrompt).toContain('provider tool telemetry');
      expect(providerPrompt).toContain('Progress:');
      expect(providerPrompt.indexOf('Task Monki progress contract')).toBeLessThan(
        providerPrompt.indexOf('Authoritative Task Monki goal')
      );
      expect(
        providerPrompt.endsWith(
          'Authoritative Task Monki goal:\nAdd a hello.txt file and verify the repository status.'
        )
      ).toBe(true);
      expect(providerPrompt).not.toContain('When finished, summarize');

      const startedRun = await requireRun(scenario.store.getRun(run.id));
      await scenario.store.upsertAgentItem({
        taskId: task.id,
        iterationId: startedRun.iterationId,
        runId: startedRun.id,
        sessionId: startedRun.sessionId,
        providerItemId: 'progress-message-1',
        type: 'AGENT_MESSAGE',
        status: 'COMPLETED',
        payload: {
          type: 'agentMessage',
          id: 'progress-message-1',
          text: 'Progress: Finished discovery and will add hello.txt next.'
        },
        providerCompletedAt: '2026-07-07T10:01:00.000Z'
      });
      await scenario.store.upsertAgentItem({
        taskId: task.id,
        iterationId: startedRun.iterationId,
        runId: startedRun.id,
        sessionId: startedRun.sessionId,
        providerItemId: 'command-read-1',
        type: 'COMMAND_EXECUTION',
        status: 'COMPLETED',
        payload: {
          type: 'commandExecution',
          id: 'command-read-1',
          command: "sed -n '1,2p' README.md",
          cwd: scenario.repositoryPath,
          commandActions: [
            {
              type: 'read',
              command: "sed -n '1,2p' README.md",
              name: 'README.md',
              path: path.join(scenario.repositoryPath, 'README.md')
            }
          ],
          aggregatedOutput: '# Scenario\n',
          exitCode: 0,
          durationMs: 25
        },
        providerCompletedAt: '2026-07-07T10:02:00.000Z'
      });
      await scenario.store.upsertAgentItem({
        taskId: task.id,
        iterationId: startedRun.iterationId,
        runId: startedRun.id,
        sessionId: startedRun.sessionId,
        providerItemId: 'file-change-1',
        type: 'FILE_CHANGE',
        status: 'COMPLETED',
        payload: {
          type: 'fileChange',
          id: 'file-change-1',
          changes: [
            {
              path: 'hello.txt',
              kind: { type: 'add' },
              diff: '+++ b/hello.txt\n+hello\n'
            }
          ]
        },
        providerCompletedAt: '2026-07-07T10:03:00.000Z'
      });

      let snapshot = await scenario.store.snapshot();
      let view = buildRunProgressViewModel({
        preferredRun: startedRun,
        runs: snapshot.runs.filter((candidate) => candidate.taskId === task.id),
        planRevisions: snapshot.agentPlanRevisions.filter((plan) => plan.taskId === task.id),
        items: snapshot.agentItems.filter((item) => item.taskId === task.id)
      });
      expect(view).toMatchObject({
        state: 'RUNNING',
        headerLabel: 'Current run',
        steps: [
          {
            step: 'Waiting for provider plan...',
            status: 'IN_PROGRESS'
          }
        ],
        activityTail: [
          expect.objectContaining({
            category: 'other',
            label: 'Finished discovery and will add hello.txt next.',
            detail: undefined,
            tone: 'neutral',
            status: 'completed'
          }),
          expect.objectContaining({
            category: 'read',
            label: 'Read',
            detail: 'README.md',
            metric: '1 line'
          }),
          expect.objectContaining({
            category: 'write',
            label: 'Wrote',
            detail: 'hello.txt',
            metric: '+1'
          })
        ],
        activityOutputSummary: 'show full output · 1 line'
      });

      const server = await scenario.store.createAgentServer({
        runtimeId: 'codex',
        runtimeKind: 'APP_SERVER',
        transport: 'STDIO',
        executable: 'scenario-agent',
        argv: ['serve']
      });
      await scenario.store.updateRun(startedRun.id, {
        serverInstanceId: server.id
      });
      const planMessage = await scenario.store.appendProtocolMessage(
        server.id,
        'INBOUND',
        '{"method":"turn/plan/updated"}'
      );
      await scenario.store.recordAgentPlanRevision({
        taskId: task.id,
        iterationId: startedRun.iterationId,
        runId: startedRun.id,
        sessionId: startedRun.sessionId,
        runtimeId: 'codex',
        explanation: 'Implementation in progress',
        steps: [
          { step: 'Inspect repository state', status: 'COMPLETED' },
          { step: 'Add hello file', status: 'IN_PROGRESS' },
          { step: 'Verify repository status', status: 'PENDING' }
        ],
        rawMessage: planMessage
      });

      snapshot = await scenario.store.snapshot();
      view = buildRunProgressViewModel({
        preferredRun: startedRun,
        runs: snapshot.runs.filter((candidate) => candidate.taskId === task.id),
        planRevisions: snapshot.agentPlanRevisions.filter((plan) => plan.taskId === task.id),
        items: snapshot.agentItems.filter((item) => item.taskId === task.id)
      });
      expect(view).toMatchObject({
        state: 'RUNNING',
        headerLabel: 'Current run',
        steps: [
          { step: 'Inspect repository state', status: 'COMPLETED' },
          { step: 'Add hello file', status: 'IN_PROGRESS' },
          { step: 'Verify repository status', status: 'PENDING' }
        ],
        activityTail: [
          expect.objectContaining({
            category: 'other',
            label: 'Finished discovery and will add hello.txt next.',
            detail: undefined
          }),
          expect.objectContaining({
            category: 'read',
            label: 'Read',
            detail: 'README.md',
            metric: '1 line'
          }),
          expect.objectContaining({
            category: 'write',
            label: 'Wrote',
            detail: 'hello.txt',
            metric: '+1'
          })
        ],
        activityOutputSummary: 'show full output · 1 line'
      });
    } finally {
      await scenario.service.shutdown();
    }
  });
});

async function requireRun(run: Promise<RunRecord | undefined>): Promise<RunRecord> {
  const resolved = await run;
  if (!resolved) {
    throw new Error('Expected scenario run to exist.');
  }
  return resolved;
}
