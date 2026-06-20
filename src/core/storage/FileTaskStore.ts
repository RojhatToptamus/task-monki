import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactKind,
  ArtifactRecord,
  CreateTaskRequest,
  DomainEvent,
  RunRecord,
  Task,
  TaskSnapshot
} from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';
import { applyEventToState, createEmptyState, type StoreState } from '../projection/reducer';
import type { CodexCommand } from '../codex/commandBuilder';
import { createDomainEvent } from './domainEvent';

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
      completionPolicy: 'ARTIFACT_ACCEPTANCE',
      phaseVersion: 1,
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
        payload: { title: task.title, repositoryPath: task.repositoryPath }
      })
    );

    await this.persistQueued();
    return clone(task);
  }

  async createRun(task: Task, command: CodexCommand): Promise<RunRecord> {
    await this.init();

    const now = new Date().toISOString();
    const runId = randomUUID();
    const stdoutArtifact = await this.createArtifactRecord(task.id, runId, 'stdout');
    const stderrArtifact = await this.createArtifactRecord(task.id, runId, 'stderr');
    const jsonlArtifact = await this.createArtifactRecord(task.id, runId, 'jsonl');
    await Promise.all([
      fs.writeFile(stdoutArtifact.path, '', 'utf8'),
      fs.writeFile(stderrArtifact.path, '', 'utf8'),
      fs.writeFile(jsonlArtifact.path, '', 'utf8')
    ]);

    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      status: 'QUEUED',
      processStatus: 'CREATED',
      executable: command.executable,
      argv: command.argv,
      cwd: task.repositoryPath,
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
        runId: run.id,
        source: 'ui',
        payload: { fromPhase: task.workflowPhase, toPhase: 'IN_PROGRESS' }
      }),
      false
    );

    await this.appendEvent(
      createDomainEvent({
        type: 'ACTION_ATTEMPT_STARTED',
        taskId: task.id,
        runId: run.id,
        source: 'process',
        payload: { executable: command.executable, argv: command.argv, cwd: task.repositoryPath }
      }),
      false
    );

    await this.persistQueued();
    return clone(run);
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

    const artifact = await this.createArtifactRecord(taskId, runId, 'final-message');
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
    runId: string,
    kind: ArtifactKind
  ): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const fileName = `${taskId}-${runId}-${kind}-${id}.log`;
    return {
      id,
      taskId,
      runId,
      kind,
      path: path.join(this.artifactsDir, fileName),
      byteCount: 0,
      createdAt: now,
      updatedAt: now
    };
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
    runs: Array.isArray(state.runs) ? state.runs : [],
    events: Array.isArray(state.events) ? state.events : [],
    artifacts: Array.isArray(state.artifacts) ? state.artifacts : []
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
