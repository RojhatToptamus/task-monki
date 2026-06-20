import type {
  CancelRunRequest,
  CreateTaskRequest,
  GitSnapshotRecord,
  PrepareWorktreeRequest,
  ReadArtifactRequest,
  RepositoryPreflight,
  RunRecord,
  RunTestsRequest,
  StartRunRequest,
  Task,
  TaskSnapshot,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest
} from '../../shared/contracts';
import os from 'node:os';
import path from 'node:path';
import { buildDiffEvidence, inspectGitSnapshot } from '../git/GitSnapshotService';
import { LocalTestRunner } from '../test/LocalTestRunner';
import { WorktreeService } from '../worktree/WorktreeService';
import { validateRepositoryPath } from '../repository/RepositoryPreflight';
import { CodexExecRunner } from '../runner/CodexExecRunner';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly runner: CodexExecRunner;
  private readonly testRunner: LocalTestRunner;
  private readonly worktrees: WorktreeService;

  constructor(
    private readonly store: FileTaskStore,
    private readonly defaultRepositoryPath: string,
    events = new AppEventBus(),
    options: { worktreeRoot?: string } = {}
  ) {
    this.events = events;
    this.runner = new CodexExecRunner(store, events);
    this.testRunner = new LocalTestRunner(store, events);
    this.worktrees = new WorktreeService(
      options.worktreeRoot ??
        process.env.TASK_MANAGER_WORKTREE_ROOT ??
        path.join(os.tmpdir(), 'task-manager-worktrees')
    );
    this.events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) {
        void this.capturePostRunEvidence(event.runId);
      }
    });
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  getDefaultRepositoryPath(): string {
    return this.defaultRepositoryPath;
  }

  validateRepository(repositoryPath: string): Promise<RepositoryPreflight> {
    return validateRepositoryPath(repositoryPath);
  }

  listTasks(): Promise<TaskSnapshot> {
    return this.store.snapshot();
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    return this.store.createTask(input);
  }

  async prepareWorktree(input: PrepareWorktreeRequest): Promise<WorktreeRecord> {
    const task = await this.requireTask(input.taskId);
    const existing = await this.store.getCurrentWorktree(task.id);
    if (existing && existing.status !== 'ERROR' && existing.status !== 'MISSING') {
      const verified = await this.worktrees.verify(existing);
      return this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    }

    const preflight = await this.validateAndRecordRepository(task);
    const spec = this.worktrees.buildSpec(task, preflight);
    const { worktree } = await this.store.createIterationAndWorktree({
      task,
      branchName: spec.branchName,
      worktreePath: spec.worktreePath,
      baseRef: spec.baseRef,
      baseSha: spec.baseSha
    });

    try {
      const created = await this.worktrees.create(worktree);
      const stored = await this.store.updateWorktree(created, 'WORKTREE_CREATED');
      await this.refreshEvidence({ taskId: task.id });
      this.events.emit({
        type: 'worktree.updated',
        taskId: task.id,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        payload: stored,
        at: new Date().toISOString()
      });
      return stored;
    } catch (error) {
      const failed: WorktreeRecord = {
        ...worktree,
        status: 'ERROR',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      await this.store.updateWorktree(failed, 'WORKTREE_FAILED');
      throw error;
    }
  }

  async startRun(input: StartRunRequest): Promise<RunRecord> {
    const task = await this.requireTask(input.taskId);
    if (input.mode === 'READ_ONLY_ANALYSIS') {
      await this.validateAndRecordRepository(task);
      return this.runner.start(task);
    }

    const worktree = await this.prepareWorktree({ taskId: task.id });
    const iteration = await this.store.getCurrentIteration(task.id);
    if (!iteration) {
      throw new Error('Task iteration was not created.');
    }
    const snapshot = await this.refreshEvidence({ taskId: task.id });

    return this.runner.start(task, {
      cwd: worktree.worktreePath,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      mode: 'IMPLEMENTATION',
      iterationId: iteration.id,
      worktreeId: worktree.id,
      generationKey: snapshot.dirtyFingerprint,
      promptSuffix: [
        'You are implementing this task in an isolated Git worktree.',
        `Repository root: ${worktree.worktreePath}`,
        'Only modify files inside this worktree.',
        'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.',
        'When finished, summarize the files changed and verification you performed.'
      ].join('\n')
    });
  }

  cancelRun(input: CancelRunRequest): Promise<void> {
    return this.runner.cancel(input.runId);
  }

  async runTests(input: RunTestsRequest) {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const snapshot = await this.refreshEvidence({ taskId: task.id });
    return this.testRunner.start(task, worktree, snapshot);
  }

  async refreshEvidence(input: RefreshEvidenceRequest): Promise<GitSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const verified = await this.worktrees.verify(worktree);
    const storedWorktree = await this.store.updateWorktree(verified, 'WORKTREE_VERIFIED');
    if (storedWorktree.status !== 'PRESENT') {
      throw new Error(`Worktree is not ready: ${storedWorktree.status}`);
    }

    const snapshot = await inspectGitSnapshot(storedWorktree);
    const diffEvidence = await buildDiffEvidence(storedWorktree);
    const storedSnapshot = await this.store.recordGitSnapshot(snapshot, diffEvidence);
    this.events.emit({
      type: 'git.updated',
      taskId: task.id,
      iterationId: storedSnapshot.iterationId,
      worktreeId: storedSnapshot.worktreeId,
      payload: storedSnapshot,
      at: new Date().toISOString()
    });
    return storedSnapshot;
  }

  async transitionTask(input: TransitionTaskRequest): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const snapshot = await this.store.snapshot();
    const latestGit = snapshot.gitSnapshots
      .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    const latestTest = snapshot.testRuns
      .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

    const blockedReason = transitionBlocker(task, input.toPhase, {
      hasWorktree: Boolean(task.currentWorktreeId),
      gitStatus: latestGit?.status,
      testStatus: latestTest?.status
    });
    if (blockedReason) {
      await this.store.recordBlockedTransition(task, input.toPhase, blockedReason);
      throw new Error(blockedReason);
    }

    return this.store.transitionTask(task.id, input.toPhase, 'Guarded transition accepted.');
  }

  readArtifact(input: ReadArtifactRequest): Promise<string> {
    return this.store.readArtifact(input.artifactId);
  }

  private async validateAndRecordRepository(task: Task): Promise<RepositoryPreflight> {
    const preflight = await validateRepositoryPath(task.repositoryPath);
    await this.store.appendEvent(
      createDomainEvent({
        type: 'REPOSITORY_PREFLIGHT_COMPLETED',
        taskId: task.id,
        source: 'repository',
        payload: preflight
      })
    );

    if (preflight.status !== 'VALID') {
      throw new Error(preflight.error ?? 'Repository preflight failed.');
    }
    return preflight;
  }

  private async capturePostRunEvidence(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.mode !== 'IMPLEMENTATION') {
      return;
    }
    try {
      await this.refreshEvidence({ taskId: run.taskId });
    } catch {
      // The terminal event already completed the run. Evidence refresh failures remain visible
      // through explicit refresh attempts and stored process/Codex artifacts.
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async requireWorktree(task: Task): Promise<WorktreeRecord> {
    const worktree = await this.store.getCurrentWorktree(task.id);
    if (!worktree) {
      throw new Error('Create a task worktree before running this action.');
    }
    return worktree;
  }
}

function transitionBlocker(
  task: Task,
  toPhase: Task['workflowPhase'],
  evidence: { hasWorktree: boolean; gitStatus?: string; testStatus?: string }
): string | undefined {
  if (toPhase === 'IN_PROGRESS') {
    return evidence.hasWorktree ? undefined : 'A task worktree is required before implementation starts.';
  }
  if (toPhase === 'REVIEW') {
    if (!evidence.hasWorktree) {
      return 'A task worktree is required before review.';
    }
    if (task.projection.codexRun !== 'COMPLETED') {
      return 'Codex must complete before moving to review.';
    }
    return undefined;
  }
  if (toPhase === 'TESTING') {
    if (!evidence.hasWorktree) {
      return 'A task worktree is required before testing.';
    }
    if (evidence.gitStatus === 'CONFLICTED' || evidence.gitStatus === 'UNAVAILABLE') {
      return `Git state ${evidence.gitStatus} blocks testing.`;
    }
    return undefined;
  }
  if (toPhase === 'PR_READY') {
    if (evidence.testStatus !== 'PASSED') {
      return 'Current-generation local tests must pass before PR_READY.';
    }
    if (evidence.gitStatus === 'CONFLICTED' || evidence.gitStatus === 'UNAVAILABLE') {
      return `Git state ${evidence.gitStatus} blocks PR readiness.`;
    }
    return undefined;
  }
  return undefined;
}
