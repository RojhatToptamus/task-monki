import type {
  CancelRunRequest,
  CreateTaskRequest,
  ReadArtifactRequest,
  RepositoryPreflight,
  RunRecord,
  StartRunRequest,
  Task,
  TaskSnapshot
} from '../../shared/contracts';
import { validateRepositoryPath } from '../repository/RepositoryPreflight';
import { CodexExecRunner } from '../runner/CodexExecRunner';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';

export class TaskManagerService {
  readonly events: AppEventBus;
  private readonly runner: CodexExecRunner;

  constructor(
    private readonly store: FileTaskStore,
    private readonly defaultRepositoryPath: string,
    events = new AppEventBus()
  ) {
    this.events = events;
    this.runner = new CodexExecRunner(store, events);
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

  async startRun(input: StartRunRequest): Promise<RunRecord> {
    const task = await this.store.getTask(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

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

    return this.runner.start(task);
  }

  cancelRun(input: CancelRunRequest): Promise<void> {
    return this.runner.cancel(input.runId);
  }

  readArtifact(input: ReadArtifactRequest): Promise<string> {
    return this.store.readArtifact(input.artifactId);
  }
}
