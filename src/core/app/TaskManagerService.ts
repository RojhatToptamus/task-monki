import type {
  CancelRunRequest,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  GitSnapshotRecord,
  GitHubPreflightRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  ReadProtocolMessageRequest,
  RefinePromptRequest,
  RefinePromptResponse,
  RepositoryPreflight,
  RunRecord,
  RunTestsRequest,
  StartRunRequest,
  Task,
  TaskSnapshot,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest,
  CreatePullRequestRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RetryRunRequest,
  StartReviewRequest,
  SteerRunRequest,
  SyncAgentGoalRequest,
  AgentExecutionSettings
} from '../../shared/contracts';
import os from 'node:os';
import path from 'node:path';
import { git, gitSucceeds } from '../git/gitCli';
import { buildDiffEvidence, inspectGitSnapshot } from '../git/GitSnapshotService';
import { GitHubService } from '../github/GitHubService';
import { PromptRefinementService } from '../prompt/PromptRefinementService';
import { LocalTestRunner } from '../test/LocalTestRunner';
import { WorktreeService } from '../worktree/WorktreeService';
import { validateRepositoryPath } from '../repository/RepositoryPreflight';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import { AgentOrchestrator } from '../agent/AgentOrchestrator';
import { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly agents: AgentOrchestrator;
  private readonly testRunner: LocalTestRunner;
  private readonly worktrees: WorktreeService;
  private readonly github: GitHubService;
  private readonly promptRefiner = new PromptRefinementService();

  constructor(
    private readonly store: FileTaskStore,
    private readonly defaultRepositoryPath: string,
    events = new AppEventBus(),
    options: { worktreeRoot?: string; ghPath?: string; codexPath?: string } = {}
  ) {
    this.events = events;
    this.agents = new AgentOrchestrator(
      store,
      events,
      new CodexAppServerAdapter(store, events, {
        cwd: defaultRepositoryPath,
        executable: options.codexPath
      })
    );
    this.testRunner = new LocalTestRunner(store, events);
    this.worktrees = new WorktreeService(
      options.worktreeRoot ??
        process.env.TASK_MANAGER_WORKTREE_ROOT ??
        path.join(os.tmpdir(), 'task-monki-worktrees')
    );
    this.github = new GitHubService(options.ghPath);
    this.events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) {
        void this.capturePostRunEvidence(event.runId);
      }
    });
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.agents.initialize();
    const snapshot = await this.store.snapshot();
    const recoveryTaskIds = new Set(
      snapshot.runs
        .filter((run) => run.recoveryState !== 'NONE')
        .map((run) => run.taskId)
    );
    await Promise.all(
      [...recoveryTaskIds].map((taskId) =>
        this.refreshEvidence({ taskId }).catch(() => undefined)
      )
    );
  }

  getDefaultRepositoryPath(): string {
    return this.defaultRepositoryPath;
  }

  validateRepository(repositoryPath: string): Promise<RepositoryPreflight> {
    return validateRepositoryPath(repositoryPath);
  }

  getAgentProviderState() {
    return this.agents.getProviderState();
  }

  listTasks(): Promise<TaskSnapshot> {
    return this.store.snapshot();
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    return this.store.createTask(input);
  }

  async refinePrompt(input: RefinePromptRequest): Promise<RefinePromptResponse> {
    const refined = await this.promptRefiner.refine(
      input.repositoryPath,
      input.input,
      input.model
    );
    this.events.emit({
      type: 'prompt.refined',
      taskId: 'prompt-preview',
      payload: refined,
      at: new Date().toISOString()
    });
    return refined;
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
    const worktree = await this.prepareWorktree({ taskId: task.id });
    const iteration = await this.store.getCurrentIteration(task.id);
    if (!iteration) {
      throw new Error('Task iteration was not created.');
    }
    const snapshot = await this.refreshEvidence({ taskId: task.id });
    const mode = input.mode ?? 'IMPLEMENTATION';
    const readOnlyMode = mode === 'ANALYSIS' || mode === 'REVIEW';
    const settings = mergeRunSettings({
      readOnly: readOnlyMode,
      settings: [task.agentSettings, input.settings]
    });
    const prompt = [
      task.prompt,
      '',
      readOnlyMode
        ? 'Analyze this task in an isolated Git worktree without modifying files.'
        : 'You are implementing this task in an isolated Git worktree.',
      `Repository root: ${worktree.worktreePath}`,
      settings.sandbox === 'WORKSPACE_WRITE'
        ? 'Only modify files inside this worktree.'
        : 'Do not modify repository files.',
      'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.',
      'When finished, summarize the files changed and verification you performed.'
    ].join('\n');

    return this.agents.startTurn({
      task,
      iteration,
      worktree,
      mode,
      prompt,
      settings,
      generationKey: snapshot.dirtyFingerprint,
      beforeGitSnapshotId: snapshot.id
    });
  }

  cancelRun(input: CancelRunRequest): Promise<void> {
    return this.agents.interruptRun(input.runId);
  }

  async steerRun(input: SteerRunRequest): Promise<void> {
    const run = await this.requireRunForTask(input.runId, input.taskId);
    return this.agents.steerRun(run.id, input.instruction);
  }

  async continueRun(input: ContinueRunRequest): Promise<RunRecord> {
    const { task, run, iteration, worktree } = await this.requireContinuationContext(
      input.taskId,
      input.runId
    );
    assertContinuable(run);
    const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
    const settings = followUpSettings(task, run, input.settings, false);
    const prompt = buildContinuationPrompt({
      task,
      run,
      gitSnapshot,
      instruction: input.instruction,
      kind: 'continuation'
    });
    return this.agents.startTurn({
      task,
      iteration,
      worktree,
      sessionId: run.sessionId,
      mode: 'FOLLOW_UP',
      prompt,
      settings,
      generationKey: gitSnapshot.dirtyFingerprint,
      beforeGitSnapshotId: gitSnapshot.id,
      continuedFromRunId: run.id
    });
  }

  async retryRun(input: RetryRunRequest): Promise<RunRecord> {
    const { task, run, iteration, worktree } = await this.requireContinuationContext(
      input.taskId,
      input.runId
    );
    assertRetryable(run);
    const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
    const settings = followUpSettings(task, run, input.settings, false);
    const prompt = buildContinuationPrompt({
      task,
      run,
      gitSnapshot,
      instruction: input.instruction,
      kind: input.strategy === 'FORK' ? 'forked retry' : 'retry'
    });
    if (input.strategy === 'FORK') {
      return this.agents.forkAndStartTurn({
        task,
        iteration,
        worktree,
        sourceRun: run,
        retryStrategy: 'FORK',
        mode: 'RETRY',
        prompt,
        settings,
        generationKey: gitSnapshot.dirtyFingerprint,
        beforeGitSnapshotId: gitSnapshot.id,
        retryOfRunId: run.id
      });
    }
    return this.agents.startTurn({
      task,
      iteration,
      worktree,
      sessionId: run.sessionId,
      mode: 'RETRY',
      prompt,
      settings,
      generationKey: gitSnapshot.dirtyFingerprint,
      beforeGitSnapshotId: gitSnapshot.id,
      retryOfRunId: run.id
    });
  }

  async startReview(input: StartReviewRequest): Promise<RunRecord> {
    const task = await this.requireTask(input.taskId);
    const snapshot = await this.store.snapshot();
    const runId = input.runId ?? task.currentRunId;
    if (!runId) {
      throw new Error('Complete an agent turn before starting a detached review.');
    }
    const run = await this.requireRunForTask(runId, task.id);
    if (
      ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(
        run.status
      )
    ) {
      throw new Error('Wait for the active turn to finish before starting a review.');
    }
    const iteration = snapshot.iterations.find(
      (candidate) => candidate.id === run.iterationId
    );
    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.id === run.worktreeId
    );
    if (!iteration || !worktree) {
      throw new Error('The source run no longer has a valid task iteration.');
    }
    const gitSnapshot = await this.refreshEvidence({ taskId: task.id });
    const settings = followUpSettings(task, run, input.settings, true);
    return this.agents.startReview({
      task,
      iteration,
      worktree,
      sourceRun: run,
      target: input.target ?? { type: 'UNCOMMITTED_CHANGES' },
      settings,
      generationKey: gitSnapshot.dirtyFingerprint,
      beforeGitSnapshotId: gitSnapshot.id
    });
  }

  async syncAgentGoal(input: SyncAgentGoalRequest) {
    const task = await this.requireTask(input.taskId);
    return this.agents.syncGoal(task, input.sessionId);
  }

  respondToInteraction(input: RespondToInteractionRequest) {
    return this.agents.respondToInteraction(input);
  }

  shutdown(): Promise<void> {
    return this.agents.shutdown();
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

  async createDeliveryCommit(input: CreateDeliveryCommitRequest): Promise<GitSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const latestGit = await this.refreshEvidence({ taskId: task.id });
    if (latestGit.status === 'CONFLICTED' || latestGit.status === 'UNAVAILABLE') {
      throw new Error(`Cannot create delivery commit while Git status is ${latestGit.status}.`);
    }
    if (latestGit.workingDiffFileCount === 0 && latestGit.stagedCount === 0 && latestGit.untrackedCount === 0) {
      throw new Error('No uncommitted task changes are available to commit.');
    }

    await git(worktree.worktreePath, ['add', '-A']);
    const hasStagedChanges = !(await gitSucceeds(worktree.worktreePath, ['diff', '--cached', '--quiet']));
    if (!hasStagedChanges) {
      throw new Error('No staged changes are available to commit.');
    }
    await git(worktree.worktreePath, ['commit', '-m', `Task: ${task.title}`], 120_000);
    const headSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await this.store.appendEvent(
      createDomainEvent({
        type: 'DELIVERY_COMMIT_CREATED',
        taskId: task.id,
        iterationId: worktree.iterationId,
        worktreeId: worktree.id,
        source: 'git',
        payload: { headSha, branchName: worktree.branchName }
      })
    );
    return this.refreshEvidence({ taskId: task.id });
  }

  async preflightGitHub(input: GitHubPreflightRequest) {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const preflight = await this.github.preflight(task, worktree);
    const stored = await this.store.recordGitHubPreflight(preflight);
    this.emitGitHubUpdate(task.id, worktree, stored);
    return stored;
  }

  async publishBranch(input: PublishBranchRequest) {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const latestGit = await this.ensureCommittedPublishableGit(task);

    assertPublishReady(latestGit);

    const githubReady = await this.preflightGitHub({ taskId: task.id });
    if (githubReady.status !== 'READY') {
      throw new Error(githubReady.error ?? `GitHub preflight is ${githubReady.status}.`);
    }

    await this.store.recordBranchPublishRequested(task, worktree);
    const publication = await this.github.publishBranch({
      task,
      worktree,
      remoteName: githubReady.remoteName
    });
    const stored = await this.store.recordBranchPublication(publication);
    this.emitGitHubUpdate(task.id, worktree, stored);
    if (stored.status !== 'PUSHED') {
      throw new Error(stored.error ?? 'Branch publication failed.');
    }
    await this.refreshEvidence({ taskId: task.id });
    return stored;
  }

  async createPullRequest(input: CreatePullRequestRequest): Promise<PullRequestSnapshotRecord> {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    let snapshot = await this.store.snapshot();
    let latestGit = latestForIteration(snapshot.gitSnapshots, task.currentIterationId, 'capturedAt');
    let latestTest = latestForIteration(snapshot.testRuns, task.currentIterationId, 'startedAt');
    let latestPublication = latestForIteration(
      snapshot.branchPublications,
      task.currentIterationId,
      'updatedAt'
    );

    if (latestPublication?.status !== 'PUSHED') {
      latestPublication = await this.publishBranch({ taskId: task.id });
      snapshot = await this.store.snapshot();
      latestGit = latestForIteration(snapshot.gitSnapshots, task.currentIterationId, 'capturedAt');
      latestTest = latestForIteration(snapshot.testRuns, task.currentIterationId, 'startedAt');
    }
    assertPublishReady(latestGit);

    const prBodyContent = await this.github.writePullRequestBody({
      filePath: path.join(os.tmpdir(), `task-monki-pr-${task.id}.md`),
      task,
      gitDiffStat: latestGit?.diffStat,
      testStatus: latestTest?.status,
      agentSummary: snapshot.runs.find((run) => run.id === task.currentRunId)?.finalMessage
    });
    const bodyArtifact = await this.store.recordPullRequestBodyArtifact(task, prBodyContent);
    const bodyPath = await this.store.getArtifactPath(bodyArtifact.id);

    await this.store.recordPullRequestCreateRequested(task, worktree);
    const sync = await this.github.createOrFindDraftPullRequest({
      task,
      worktree,
      headSha: latestGit?.headSha,
      baseRef: worktree.baseRef,
      bodyFilePath: bodyPath
    });
    sync.pullRequest.bodyArtifactId = bodyArtifact.id;
    const pullRequest = await this.store.recordPullRequestSync(sync);
    this.emitGitHubUpdate(task.id, worktree, pullRequest);

    if (pullRequest.status === 'OPEN_DRAFT' || pullRequest.status === 'OPEN_READY') {
      await this.store.transitionTask(task.id, 'IN_REVIEW', 'GitHub confirmed a matching open pull request.');
    }

    return pullRequest;
  }

  async refreshGitHub(input: RefreshGitHubRequest): Promise<PullRequestSnapshotRecord | undefined> {
    const task = await this.requireTask(input.taskId);
    const worktree = await this.requireWorktree(task);
    const latest = await this.store.getLatestPullRequest(task.id);
    if (!latest?.number && !latest?.url) {
      return undefined;
    }
    try {
      const sync = await this.github.viewPullRequest(worktree, latest.number ?? latest.url ?? worktree.branchName);
      const stored = await this.store.recordPullRequestSync(sync);
      this.emitGitHubUpdate(task.id, worktree, stored);
      return stored;
    } catch (error) {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'GITHUB_SYNC_FAILED',
          taskId: task.id,
          iterationId: worktree.iterationId,
          worktreeId: worktree.id,
          source: 'github',
          payload: { error: error instanceof Error ? error.message : String(error) }
        })
      );
      throw error;
    }
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
    const latestPr = snapshot.pullRequests
      .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const latestMerge = snapshot.mergeSnapshots
      .filter((candidate) => candidate.taskId === task.id && candidate.iterationId === task.currentIterationId)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];

    const blockedReason = transitionBlocker(task, input.toPhase, {
      hasWorktree: Boolean(task.currentWorktreeId),
      hasGitSnapshot: Boolean(latestGit),
      hasTestRun: Boolean(latestTest),
      gitStatus: latestGit?.status ?? task.projection.git,
      testStatus: latestTest?.status ?? task.projection.tests,
      gitHeadSha: latestGit?.headSha,
      testHeadSha: latestTest?.testedHeadSha,
      testDirtyFingerprint: latestTest?.testedDirtyFingerprint,
      gitDirtyFingerprint: latestGit?.dirtyFingerprint,
      pullRequestStatus: latestPr?.status,
      pullRequestHeadSha: latestPr?.headRefOid,
      mergeStatus: latestMerge?.status
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

  readProtocolMessage(input: ReadProtocolMessageRequest) {
    return this.store.readProtocolMessage(input.reference);
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
    if (
      !run ||
      !['IMPLEMENTATION', 'FOLLOW_UP', 'RETRY', 'REVIEW'].includes(run.mode)
    ) {
      return;
    }
    try {
      const snapshot = await this.refreshEvidence({ taskId: run.taskId });
      await this.store.updateRun(run.id, { afterGitSnapshotId: snapshot.id });
      if (run.mode === 'REVIEW' && run.beforeGitSnapshotId) {
        const state = await this.store.snapshot();
        const before = state.gitSnapshots.find(
          (candidate) => candidate.id === run.beforeGitSnapshotId
        );
        if (before && before.dirtyFingerprint !== snapshot.dirtyFingerprint) {
          await this.store.appendEvent(
            createDomainEvent({
              type: 'AGENT_REVIEW_POLICY_VIOLATION',
              taskId: run.taskId,
              iterationId: run.iterationId,
              runId: run.id,
              worktreeId: run.worktreeId,
              agentSessionId: run.sessionId,
              source: 'git',
              payload: {
                beforeDirtyFingerprint: before.dirtyFingerprint,
                afterDirtyFingerprint: snapshot.dirtyFingerprint
              }
            })
          );
        }
      }
    } catch {
      // The terminal event already completed the run. Evidence refresh failures remain visible
      // through explicit refresh attempts and stored runtime/provider artifacts.
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async requireRunForTask(runId: string, taskId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run || run.taskId !== taskId) {
      throw new Error(`Run ${runId} does not belong to task ${taskId}.`);
    }
    return run;
  }

  private async requireContinuationContext(taskId: string, runId: string) {
    const [task, snapshot] = await Promise.all([
      this.requireTask(taskId),
      this.store.snapshot()
    ]);
    const run = snapshot.runs.find(
      (candidate) => candidate.id === runId && candidate.taskId === taskId
    );
    if (!run) {
      throw new Error(`Run ${runId} does not belong to task ${taskId}.`);
    }
    const iteration = snapshot.iterations.find(
      (candidate) => candidate.id === run.iterationId
    );
    const worktree = snapshot.worktrees.find(
      (candidate) => candidate.id === run.worktreeId
    );
    if (!iteration || !worktree) {
      throw new Error('The source run no longer has a valid task iteration.');
    }
    return { task, run, iteration, worktree };
  }

  private async requireWorktree(task: Task): Promise<WorktreeRecord> {
    const worktree = await this.store.getCurrentWorktree(task.id);
    if (!worktree) {
      throw new Error('Create a task worktree before running this action.');
    }
    return worktree;
  }

  private emitGitHubUpdate(taskId: string, worktree: WorktreeRecord, payload: unknown): void {
    this.events.emit({
      type: 'github.updated',
      taskId,
      iterationId: worktree.iterationId,
      worktreeId: worktree.id,
      payload,
      at: new Date().toISOString()
    });
  }

  private async ensureCommittedPublishableGit(task: Task): Promise<GitSnapshotRecord> {
    const latestGit = await this.refreshEvidence({ taskId: task.id });
    if (latestGit.status === 'DIRTY') {
      return this.createDeliveryCommit({ taskId: task.id });
    }
    return latestGit;
  }
}

function followUpSettings(
  task: Task,
  run: RunRecord,
  overrides: AgentExecutionSettings | undefined,
  readOnly: boolean
): AgentExecutionSettings {
  return mergeRunSettings({
    readOnly,
    settings: [run.requestedSettings, task.agentSettings, overrides]
  });
}

export function mergeRunSettings(input: {
  readOnly: boolean;
  settings: Array<AgentExecutionSettings | undefined>;
}): AgentExecutionSettings {
  const defaultSandbox: NonNullable<AgentExecutionSettings['sandbox']> = input.readOnly
    ? 'READ_ONLY'
    : 'WORKSPACE_WRITE';
  const requestedSettings: AgentExecutionSettings = Object.assign(
    {
      sandbox: defaultSandbox,
      networkAccess: false,
      approvalPolicy: 'on-request'
    } satisfies AgentExecutionSettings,
    ...input.settings.filter(Boolean)
  );
  return {
    ...requestedSettings,
    sandbox: input.readOnly
      ? 'READ_ONLY'
      : (requestedSettings.sandbox ?? defaultSandbox),
    networkAccess: requestedSettings.networkAccess ?? false,
    approvalPolicy: requestedSettings.approvalPolicy ?? 'on-request'
  };
}

function buildContinuationPrompt(input: {
  task: Task;
  run: RunRecord;
  gitSnapshot: GitSnapshotRecord;
  instruction?: string;
  kind: 'continuation' | 'retry' | 'forked retry';
}): string {
  const instruction = input.instruction?.trim();
  return [
    `Authoritative Task Monki goal:\n${input.task.prompt}`,
    '',
    `This is a ${input.kind} after run ${input.run.id} ended with ${input.run.status}.`,
    `Current independent Git evidence: status=${input.gitSnapshot.status}, head=${input.gitSnapshot.headSha ?? 'unknown'}, dirtyFingerprint=${input.gitSnapshot.dirtyFingerprint}.`,
    instruction ? `Additional user instruction:\n${instruction}` : undefined,
    '',
    `Repository root: ${input.gitSnapshot.worktreePath}`,
    'Continue in the existing isolated task worktree.',
    'Only modify files inside this worktree.',
    'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.',
    'Reinspect the current repository state instead of assuming the prior turn completed every step.',
    'When finished, summarize the files changed and verification you performed.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function assertContinuable(run: RunRecord): void {
  if (
    !['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
      run.status
    )
  ) {
    throw new Error(`Run ${run.id} cannot continue while it is ${run.status}.`);
  }
}

function assertRetryable(run: RunRecord): void {
  if (
    !['COMPLETED', 'FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(
      run.status
    )
  ) {
    throw new Error(`Run ${run.id} cannot be retried while it is ${run.status}.`);
  }
}

export function transitionBlocker(
  task: Task,
  toPhase: Task['workflowPhase'],
  evidence: {
    hasWorktree: boolean;
    hasGitSnapshot?: boolean;
    hasTestRun?: boolean;
    gitStatus?: string;
    testStatus?: string;
    gitHeadSha?: string;
    testHeadSha?: string;
    testDirtyFingerprint?: string;
    gitDirtyFingerprint?: string;
    pullRequestStatus?: string;
    pullRequestHeadSha?: string;
    mergeStatus?: string;
  }
): string | undefined {
  if (toPhase === 'IN_PROGRESS') {
    return evidence.hasWorktree ? undefined : 'A task worktree is required before implementation starts.';
  }
  if (toPhase === 'REVIEW') {
    if (!evidence.hasWorktree) {
      return 'A task worktree is required before review.';
    }
    if (task.projection.agentRun !== 'COMPLETED') {
      return 'The agent turn must complete before moving to review.';
    }
    return undefined;
  }
  if (toPhase === 'IN_REVIEW') {
    if (evidence.pullRequestStatus !== 'OPEN_DRAFT' && evidence.pullRequestStatus !== 'OPEN_READY') {
      return 'A matching open GitHub pull request is required before IN_REVIEW.';
    }
    if (evidence.gitHeadSha && evidence.pullRequestHeadSha && evidence.gitHeadSha !== evidence.pullRequestHeadSha) {
      return 'GitHub pull request head SHA does not match the current task branch HEAD.';
    }
    return undefined;
  }
  if (toPhase === 'DONE') {
    if (task.completionPolicy === 'MERGED' && evidence.mergeStatus !== 'MERGED') {
      return 'GitHub must report the pull request merged before DONE.';
    }
    return undefined;
  }
  return undefined;
}

function latestForIteration<T extends { iterationId: string }>(
  rows: T[],
  iterationId: string | undefined,
  dateKey: keyof T
): T | undefined {
  return rows
    .filter((row) => row.iterationId === iterationId)
    .sort((a, b) => String(b[dateKey]).localeCompare(String(a[dateKey])))[0];
}

export function assertPublishReady(
  latestGit: GitSnapshotRecord | undefined
): void {
  if (!latestGit) {
    throw new Error('Refresh Git evidence before opening a draft PR.');
  }
  if (latestGit.status === 'DIRTY') {
    throw new Error('Create a delivery commit before opening a draft PR. Dirty worktree changes cannot be pushed.');
  }
  if (latestGit.status === 'CONFLICTED' || latestGit.status === 'UNAVAILABLE') {
    throw new Error(`Git status ${latestGit.status} blocks draft PR creation.`);
  }
  if (latestGit.commitsAheadOfBase <= 0) {
    throw new Error('The task branch has no committed changes to open a draft PR for.');
  }
}
