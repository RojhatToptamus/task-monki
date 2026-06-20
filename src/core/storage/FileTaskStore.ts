import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactKind,
  ArtifactRecord,
  CreateTaskRequest,
  DomainEvent,
  GitSnapshotRecord,
  RunRecord,
  Task,
  TaskIteration,
  TaskSnapshot,
  TestRunRecord,
  WorktreeRecord
} from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';
import { applyEventToState, createEmptyState, type StoreState } from '../projection/reducer';
import type { CodexCommand } from '../codex/commandBuilder';
import { createDomainEvent } from './domainEvent';

interface CreateRunOptions {
  cwd?: string;
  mode?: RunRecord['mode'];
  iterationId?: string;
  worktreeId?: string;
  generationKey?: string;
}

interface CreateTestRunInput {
  task: Task;
  worktree: WorktreeRecord;
  gitSnapshot: GitSnapshotRecord;
  commandLine: string;
  executable: string;
  argv: string[];
}

interface PersistedState extends StoreState {}

export class FileTaskStore {
  private readonly storePath: string;
  private readonly artifactsDir: string;
  private state: StoreState = createEmptyState();
  private loaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.storePath = path.join(baseDir, 'store.json');
    this.artifactsDir = path.join(baseDir, 'artifacts');
  }

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(this.artifactsDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw) as PersistedState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.state = createEmptyState();
      await this.persist();
    }

    this.loaded = true;
  }

  async snapshot(): Promise<TaskSnapshot> {
    await this.init();
    return clone(this.state);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    await this.init();
    return clone(this.state.tasks.find((task) => task.id === taskId));
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    await this.init();
    return clone(this.state.runs.find((run) => run.id === runId));
  }

  async getCurrentIteration(taskId: string): Promise<TaskIteration | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.iterations.find((iteration) => iteration.id === task?.currentIterationId));
  }

  async getCurrentWorktree(taskId: string): Promise<WorktreeRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    return clone(this.state.worktrees.find((worktree) => worktree.id === task?.currentWorktreeId));
  }

  async getLatestGitSnapshot(taskId: string): Promise<GitSnapshotRecord | undefined> {
    await this.init();
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    const iterationId = task?.currentIterationId;
    return clone(
      this.state.gitSnapshots
        .filter((snapshot) => snapshot.taskId === taskId && snapshot.iterationId === iterationId)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]
    );
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    await this.init();

    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      repositoryPath: input.repositoryPath.trim(),
      workflowPhase: 'READY',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 1,
      testCommand: input.testCommand?.trim() || 'npm test',
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };

    if (!task.title) {
      throw new Error('Task title is required.');
    }
    if (!task.prompt) {
      throw new Error('Task prompt is required.');
    }
    if (!task.repositoryPath) {
      throw new Error('Repository path is required.');
    }

    this.state = {
      ...this.state,
      tasks: [task, ...this.state.tasks]
    };

    this.state = applyEventToState(
      this.state,
      createDomainEvent({
        type: 'TASK_CREATED',
        taskId: task.id,
        source: 'ui',
        payload: { title: task.title, repositoryPath: task.repositoryPath, testCommand: task.testCommand }
      })
    );

    await this.persistQueued();
    return clone(task);
  }

  async createRun(task: Task, command: CodexCommand, options: CreateRunOptions = {}): Promise<RunRecord> {
    await this.init();

    const now = new Date().toISOString();
    const runId = randomUUID();
    const stdoutArtifact = await this.createArtifactRecord(task.id, 'stdout', { runId });
    const stderrArtifact = await this.createArtifactRecord(task.id, 'stderr', { runId });
    const jsonlArtifact = await this.createArtifactRecord(task.id, 'jsonl', { runId });
    await Promise.all([
      fs.writeFile(stdoutArtifact.path, '', 'utf8'),
      fs.writeFile(stderrArtifact.path, '', 'utf8'),
      fs.writeFile(jsonlArtifact.path, '', 'utf8')
    ]);

    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      iterationId: options.iterationId,
      worktreeId: options.worktreeId,
      mode: options.mode ?? 'READ_ONLY_ANALYSIS',
      generationKey: options.generationKey,
      status: 'QUEUED',
      processStatus: 'CREATED',
      executable: command.executable,
      argv: command.argv,
      cwd: options.cwd ?? task.repositoryPath,
      startedAt: now,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      jsonlArtifactId: jsonlArtifact.id,
      eventCount: 0
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === task.id
          ? {
              ...existing,
              workflowPhase: 'IN_PROGRESS',
              currentRunId: run.id,
              currentIterationId: options.iterationId ?? existing.currentIterationId,
              currentWorktreeId: options.worktreeId ?? existing.currentWorktreeId,
              phaseVersion: existing.phaseVersion + 1,
              updatedAt: now
            }
          : existing
      ),
      runs: [run, ...this.state.runs],
      artifacts: [stdoutArtifact, stderrArtifact, jsonlArtifact, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_REQUESTED',
        taskId: task.id,
        iterationId: options.iterationId,
        runId: run.id,
        worktreeId: options.worktreeId,
        source: 'ui',
        payload: { fromPhase: task.workflowPhase, toPhase: 'IN_PROGRESS' }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'ACTION_ATTEMPT_STARTED',
        taskId: task.id,
        iterationId: options.iterationId,
        runId: run.id,
        worktreeId: options.worktreeId,
        source: 'process',
        payload: {
          executable: command.executable,
          argv: command.argv,
          cwd: options.cwd ?? task.repositoryPath,
          mode: run.mode,
          generationKey: run.generationKey
        }
      }),
      false
    );

    await this.persistQueued();
    return clone(run);
  }

  async createIterationAndWorktree(input: {
    task: Task;
    branchName: string;
    worktreePath: string;
    baseRef?: string;
    baseSha: string;
  }): Promise<{ iteration: TaskIteration; worktree: WorktreeRecord }> {
    await this.init();

    const now = new Date().toISOString();
    const iteration: TaskIteration = {
      id: randomUUID(),
      taskId: input.task.id,
      actionRequestId: randomUUID(),
      generationKey: randomUUID(),
      status: 'ACTIVE',
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      createdAt: now,
      updatedAt: now
    };
    const worktree: WorktreeRecord = {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: iteration.id,
      repositoryPath: input.task.repositoryPath,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now
    };
    const storedIteration = { ...iteration, worktreeId: worktree.id };

    this.state = {
      ...this.state,
      iterations: [storedIteration, ...this.state.iterations],
      worktrees: [worktree, ...this.state.worktrees],
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              currentIterationId: storedIteration.id,
              currentWorktreeId: worktree.id,
              updatedAt: now
            }
          : existing
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TASK_ITERATION_CREATED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'ui',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'WORKTREE_CREATE_REQUESTED',
        taskId: input.task.id,
        iterationId: storedIteration.id,
        worktreeId: worktree.id,
        source: 'git',
        payload: {
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          baseSha: input.baseSha
        }
      }),
      false
    );

    await this.persistQueued();
    return { iteration: clone(storedIteration), worktree: clone(worktree) };
  }

  async updateWorktree(worktree: WorktreeRecord, eventType: 'WORKTREE_CREATED' | 'WORKTREE_VERIFIED' | 'WORKTREE_FAILED'): Promise<WorktreeRecord> {
    await this.init();
    const now = new Date().toISOString();
    const stored: WorktreeRecord = {
      ...worktree,
      updatedAt: now,
      lastVerifiedAt: eventType === 'WORKTREE_FAILED' ? worktree.lastVerifiedAt : now
    };

    this.state = {
      ...this.state,
      worktrees: this.state.worktrees.map((candidate) =>
        candidate.id === stored.id ? stored : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: eventType,
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.id,
        source: 'git',
        payload: {
          status: stored.status,
          branchName: stored.branchName,
          worktreePath: stored.worktreePath,
          headSha: stored.headSha,
          error: stored.error
        }
      }),
      false
    );
    await this.persistQueued();
    return clone(stored);
  }

  async recordGitSnapshot(snapshot: Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>, diffEvidence: string): Promise<GitSnapshotRecord> {
    await this.init();

    const diffArtifact = await this.writeTextArtifact(snapshot.taskId, 'diff', diffEvidence);
    const stored: GitSnapshotRecord = {
      id: randomUUID(),
      ...snapshot,
      capturedAt: new Date().toISOString(),
      diffArtifactId: diffArtifact.id
    };

    this.state = {
      ...this.state,
      gitSnapshots: [stored, ...this.state.gitSnapshots]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'DIFF_ARTIFACT_CREATED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'storage',
        payload: { artifactId: diffArtifact.id, byteCount: diffArtifact.byteCount }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'GIT_SNAPSHOT_CAPTURED',
        taskId: stored.taskId,
        iterationId: stored.iterationId,
        worktreeId: stored.worktreeId,
        source: 'git',
        payload: stored
      }),
      false
    );

    await this.markStaleTestsForSnapshot(stored, false);
    await this.persistQueued();
    return clone(stored);
  }

  async createTestRun(input: CreateTestRunInput): Promise<TestRunRecord> {
    await this.init();

    const now = new Date().toISOString();
    const testRunId = randomUUID();
    const stdoutArtifact = await this.createArtifactRecord(input.task.id, 'test-stdout', {
      testRunId
    });
    const stderrArtifact = await this.createArtifactRecord(input.task.id, 'test-stderr', {
      testRunId
    });
    await Promise.all([
      fs.writeFile(stdoutArtifact.path, '', 'utf8'),
      fs.writeFile(stderrArtifact.path, '', 'utf8')
    ]);

    const testRun: TestRunRecord = {
      id: testRunId,
      taskId: input.task.id,
      iterationId: input.worktree.iterationId,
      worktreeId: input.worktree.id,
      generationKey: input.gitSnapshot.dirtyFingerprint,
      command: input.commandLine,
      executable: input.executable,
      argv: input.argv,
      cwd: input.worktree.worktreePath,
      status: 'QUEUED',
      processStatus: 'CREATED',
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      startedAt: now,
      testedHeadSha: input.gitSnapshot.headSha,
      testedDirtyFingerprint: input.gitSnapshot.dirtyFingerprint
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((existing) =>
        existing.id === input.task.id
          ? {
              ...existing,
              workflowPhase: 'TESTING',
              currentTestRunId: testRun.id,
              updatedAt: now,
              phaseVersion: existing.phaseVersion + 1
            }
          : existing
      ),
      testRuns: [testRun, ...this.state.testRuns],
      artifacts: [stdoutArtifact, stderrArtifact, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TEST_RUN_STARTED',
        taskId: input.task.id,
        iterationId: input.worktree.iterationId,
        worktreeId: input.worktree.id,
        testRunId: testRun.id,
        source: 'test',
        payload: {
          command: input.commandLine,
          cwd: input.worktree.worktreePath,
          testedHeadSha: input.gitSnapshot.headSha,
          testedDirtyFingerprint: input.gitSnapshot.dirtyFingerprint
        }
      }),
      false
    );

    await this.persistQueued();
    return clone(testRun);
  }

  async transitionTask(taskId: string, toPhase: Task['workflowPhase'], reason: string): Promise<Task> {
    await this.init();

    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.id === taskId
          ? {
              ...candidate,
              workflowPhase: toPhase,
              phaseVersion: candidate.phaseVersion + 1,
              updatedAt: now
            }
          : candidate
      )
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_COMPLETED',
        taskId,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'ui',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      }),
      false
    );
    await this.persistQueued();

    const updated = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!updated) {
      throw new Error(`Task not found after transition: ${taskId}`);
    }
    return clone(updated);
  }

  async recordBlockedTransition(task: Task, toPhase: Task['workflowPhase'], reason: string): Promise<void> {
    await this.appendEvent(
      createDomainEvent({
        type: 'TRANSITION_BLOCKED',
        taskId: task.id,
        iterationId: task.currentIterationId,
        worktreeId: task.currentWorktreeId,
        source: 'projection',
        payload: { fromPhase: task.workflowPhase, toPhase, reason }
      })
    );
  }

  async appendEvent(event: DomainEvent, persist = true): Promise<void> {
    await this.init();
    this.state = applyEventToState(this.state, event);
    if (persist) {
      await this.persistQueued();
    }
  }

  async appendArtifact(artifactId: string, chunk: string): Promise<void> {
    await this.init();

    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    await fs.mkdir(path.dirname(artifact.path), { recursive: true });
    await fs.appendFile(artifact.path, chunk, 'utf8');

    const byteCount = Buffer.byteLength(chunk);
    const updatedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      artifacts: this.state.artifacts.map((candidate) =>
        candidate.id === artifactId
          ? { ...candidate, byteCount: candidate.byteCount + byteCount, updatedAt }
          : candidate
      )
    };
    await this.persistQueued();
  }

  async writeFinalArtifact(taskId: string, runId: string, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, 'final-message', { runId });
    await fs.writeFile(artifact.path, content, 'utf8');

    const hash = createHash('sha256').update(content).digest('hex');
    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.appendEvent(
      createDomainEvent({
        type: 'ARTIFACT_CREATED',
        taskId,
        runId,
        source: 'storage',
        payload: { artifactId: stored.id, kind: stored.kind, hash }
      }),
      false
    );

    await this.persistQueued();
    return clone(stored);
  }

  async writeTextArtifact(taskId: string, kind: ArtifactKind, content: string): Promise<ArtifactRecord> {
    await this.init();

    const artifact = await this.createArtifactRecord(taskId, kind);
    await fs.writeFile(artifact.path, content, 'utf8');

    const stored: ArtifactRecord = {
      ...artifact,
      byteCount: Buffer.byteLength(content),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      artifacts: [stored, ...this.state.artifacts]
    };

    await this.persistQueued();
    return clone(stored);
  }

  async readArtifact(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    try {
      return await fs.readFile(artifact.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async getArtifactPath(artifactId: string): Promise<string> {
    await this.init();
    const artifact = this.state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    return artifact.path;
  }

  private async createArtifactRecord(
    taskId: string,
    kind: ArtifactKind,
    ids: { runId?: string; testRunId?: string } = {}
  ): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const ownerId = ids.runId ?? ids.testRunId ?? 'task';
    const fileName = `${taskId}-${ownerId}-${kind}-${id}.log`;
    return {
      id,
      taskId,
      runId: ids.runId,
      testRunId: ids.testRunId,
      kind,
      path: path.join(this.artifactsDir, fileName),
      byteCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async markStaleTestsForSnapshot(
    snapshot: GitSnapshotRecord,
    persist: boolean
  ): Promise<void> {
    const staleRuns = this.state.testRuns.filter(
      (testRun) =>
        testRun.taskId === snapshot.taskId &&
        testRun.iterationId === snapshot.iterationId &&
        ['PASSED', 'FAILED'].includes(testRun.status) &&
        (testRun.testedHeadSha !== snapshot.headSha ||
          testRun.testedDirtyFingerprint !== snapshot.dirtyFingerprint)
    );

    for (const testRun of staleRuns) {
      const reason = 'Git generation changed after this test run completed.';
      this.state = {
        ...this.state,
        testRuns: this.state.testRuns.map((candidate) =>
          candidate.id === testRun.id
            ? {
                ...candidate,
                status: 'STALE',
                staleReason: reason
              }
            : candidate
        )
      };

      await this.appendEvent(
        createDomainEvent({
          type: 'TEST_RESULT_STALE',
          taskId: testRun.taskId,
          iterationId: testRun.iterationId,
          worktreeId: testRun.worktreeId,
          testRunId: testRun.id,
          source: 'test',
          payload: {
            reason,
            testedHeadSha: testRun.testedHeadSha,
            currentHeadSha: snapshot.headSha,
            testedDirtyFingerprint: testRun.testedDirtyFingerprint,
            currentDirtyFingerprint: snapshot.dirtyFingerprint
          }
        }),
        false
      );
    }

    if (persist && staleRuns.length > 0) {
      await this.persistQueued();
    }
  }

  private async persistQueued(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.storePath);
  }
}

function normalizeState(state: PersistedState): StoreState {
  return {
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    iterations: Array.isArray(state.iterations) ? state.iterations : [],
    worktrees: Array.isArray(state.worktrees) ? state.worktrees : [],
    gitSnapshots: Array.isArray(state.gitSnapshots) ? state.gitSnapshots : [],
    testRuns: Array.isArray(state.testRuns) ? state.testRuns : [],
    runs: Array.isArray(state.runs) ? state.runs : [],
    events: Array.isArray(state.events) ? state.events : [],
    artifacts: Array.isArray(state.artifacts) ? state.artifacts : []
  };
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
