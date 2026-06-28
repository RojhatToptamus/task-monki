import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from './FileTaskStore';
import { createDomainEvent } from './domainEvent';

describe('FileTaskStore', () => {
  it('persists tasks, runs, events, and artifacts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Read repo',
      prompt: 'Summarize and do not write.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/test',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'ANALYSIS',
      prompt: task.prompt
    });

    await store.appendArtifact(run.outputArtifactId, '{"type":"turn.started"}\n');
    const final = await store.writeFinalArtifact(task.id, run.id, '# Final\n');

    const reloaded = new FileTaskStore(dir);
    const snapshot = await reloaded.snapshot();

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.agentSessions).toHaveLength(1);
    expect(snapshot.events.some((event) => event.type === 'TASK_CREATED')).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.id === final.id)).toBe(true);
    await expect(reloaded.readArtifact(final.id)).resolves.toBe('# Final\n');
  });

  it('links forked alternative tasks to their source task and run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-fork-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Compare approaches',
      prompt: 'Implement the feature.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/source',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    const alternative = await store.createForkedAlternativeTask({
      title: 'Alternative: Compare approaches',
      prompt: 'Try another implementation.',
      repositoryPath: dir,
      sourceTaskId: task.id,
      sourceRunId: run.id
    });
    const snapshot = await store.snapshot();
    const source = snapshot.tasks.find((candidate) => candidate.id === task.id);
    const linkedAlternative = snapshot.tasks.find(
      (candidate) => candidate.id === alternative.id
    );

    expect(source?.forkedAlternativeTaskIds).toEqual([alternative.id]);
    expect(linkedAlternative?.forkedFromTaskId).toBe(task.id);
    expect(linkedAlternative?.forkedFromRunId).toBe(run.id);
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'TASK_ALTERNATIVE_CREATED' &&
          event.taskId === task.id &&
          event.runId === run.id
      )
    ).toBe(true);
  });

  it('repairs schema-current task records missing alternative ids', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair task shape',
      prompt: 'Keep current records loadable.',
      repositoryPath: dir
    });
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.tasks = raw.tasks.map((candidate: any) => {
      if (candidate.id !== task.id) {
        return candidate;
      }
      const withoutAlternatives = { ...candidate };
      delete withoutAlternatives.forkedAlternativeTaskIds;
      return withoutAlternatives;
    });
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const repaired = await new FileTaskStore(dir).snapshot();
    expect(repaired.tasks[0]?.forkedAlternativeTaskIds).toEqual([]);
  });

  it('preserves structured terminal review status when reloading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-status-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Keep review verdict',
      prompt: 'Render passed review actions.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-verdict',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: implementationRun.id,
        worktreeId: worktree.id,
        agentSessionId: implementationSession.id,
        source: 'provider',
        payload: { terminalReason: 'completed' }
      })
    );

    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: reviewRun.id,
        worktreeId: worktree.id,
        agentSessionId: reviewSession.id,
        source: 'provider',
        payload: {
          mode: 'REVIEW',
          codexReviewResult: {
            schemaVersion: 'codex-review/v1',
            verdict: 'PASSED',
            summary: 'No blocking issues found.',
            findings: []
          }
        }
      })
    );

    expect((await store.getTask(task.id))?.projection.codexReview?.status).toBe('PASSED');
    const reloadedTask = (await new FileTaskStore(dir).getTask(task.id))!;
    expect(reloadedTask.projection.codexReview?.status).toBe('PASSED');
    expect(reloadedTask.projection.codexReview?.result?.verdict).toBe('PASSED');
  });

  it('keeps detached review runs inside the review workflow phase', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Review flow',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-flow',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storedTask = (await store.getTask(task.id))!;
    expect(storedTask.workflowPhase).toBe('REVIEW');
    expect(storedTask.currentRunId).toBe(implementationRun.id);
    expect(storedTask.projection.codexReview?.status).toBe('RUNNING');
    expect(storedTask.projection.codexReview?.runId).toBe(reviewRun.id);
  });

  it('repairs persisted active review runs that were incorrectly moved to in progress', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair review flow',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === implementationRun.id
        ? {
            ...candidate,
            status: 'COMPLETED'
          }
        : candidate.id === reviewRun.id
          ? {
              ...candidate,
              status: 'RUNNING'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'IN_PROGRESS',
            projection: {
              ...candidate.projection,
              agentRun: 'RUNNING',
              codexReview: undefined
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('RUNNING');
    expect(repairedTask?.projection.codexReview?.runId).toBe(reviewRun.id);
  });

  it('repairs interrupting reviews whose provider session is already idle', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-review-idle-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair idle review',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-idle-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.agentSessions = raw.agentSessions.map((candidate: any) =>
      candidate.id === reviewSession.id
        ? {
            ...candidate,
            status: 'IDLE'
          }
        : candidate
    );
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'INTERRUPTING'
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
          : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'REVIEW',
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'RUNNING',
                runId: reviewRun.id,
                summary: 'Codex is reviewing the current diff.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    const repairedReviewRun = repaired.runs.find(
      (candidate) => candidate.id === reviewRun.id
    );
    expect(repairedReviewRun?.status).toBe('INTERRUPTED');
    expect(repairedReviewRun?.recoveryState).toBe('NONE');
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('CANCELED');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'Codex review was stopped before completion.'
    );
  });

  it('repairs running reviews whose provider session is already idle', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-review-running-idle-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair completed but unfinalized review',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-running-idle-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.agentSessions = raw.agentSessions.map((candidate: any) =>
      candidate.id === reviewSession.id
        ? {
            ...candidate,
            status: 'IDLE'
          }
        : candidate
    );
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === implementationRun.id
        ? {
            ...candidate,
            status: 'COMPLETED'
          }
        : candidate.id === reviewRun.id
          ? {
              ...candidate,
              status: 'RUNNING'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'RUNNING',
                runId: reviewRun.id,
                summary: 'Codex is reviewing the current diff.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    const repairedReviewRun = repaired.runs.find(
      (candidate) => candidate.id === reviewRun.id
    );
    expect(repairedReviewRun?.status).toBe('RECOVERY_REQUIRED');
    expect(repairedReviewRun?.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('FAILED');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'Codex review stopped sending updates before Task Monki received a terminal event.'
    );
  });

  it('repairs persisted completed review results with structured findings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-result-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair completed review result',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-result-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const finalMessage = `Review found a blocker.

\`\`\`json
{
  "schemaVersion": "codex-review/v1",
  "verdict": "NEEDS_CHANGES",
  "summary": "A keyboard shortcut listener leaks.",
  "findings": [
    {
      "id": "listener-leak",
      "severity": "BLOCKER",
      "title": "Listener is not cleaned up",
      "explanation": "The listener is added repeatedly.",
      "path": "src/renderer/ui/App.tsx",
      "line": 42
    }
  ]
}
\`\`\``;
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'COMPLETED',
            finalMessage
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'IN_PROGRESS',
            projection: {
              ...candidate.projection,
              agentRun: 'RUNNING',
              codexReview: undefined
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('NEEDS_CHANGES');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'A keyboard shortcut listener leaks.'
    );
    expect(repairedTask?.projection.codexReview?.result?.findings[0]?.id).toBe(
      'listener-leak'
    );
  });

  it('repairs persisted completed review results with native Codex review comments', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-native-review-result-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair native review result',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/native-review-result-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const finalMessage = `The patch introduces review-flow regressions that can bypass the review gate.

Full review comments:

- [P2] Pause source-run controls while reviews run — ${dir}/src/renderer/ui/AgentControlPanel.tsx:44-45
  The selected run remains the completed implementation run while a detached review is running.

- [P3] Allow change requests from unstructured reviews — ${dir}/src/renderer/ui/taskView.ts:96-99
  The predicate hides Request changes even though the drawer can build a follow-up from raw output.
`;
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'COMPLETED',
            finalMessage
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
          : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'REVIEW',
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'INCONCLUSIVE',
                runId: reviewRun.id,
                sourceRunId: implementationRun.id,
                summary: 'Codex review completed, but no structured pass/fail verdict was provided.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('NEEDS_CHANGES');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'The patch introduces review-flow regressions that can bypass the review gate.'
    );
    expect(repairedTask?.projection.codexReview?.result?.findings).toHaveLength(2);
    expect(repairedTask?.projection.codexReview?.result?.findings[0]).toMatchObject({
      severity: 'MAJOR',
      title: 'Pause source-run controls while reviews run',
      path: 'src/renderer/ui/AgentControlPanel.tsx',
      line: 44,
      endLine: 45
    });
  });
});
