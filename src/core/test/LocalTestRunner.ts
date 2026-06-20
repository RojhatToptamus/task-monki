import type { AppUpdateEvent, GitSnapshotRecord, Task, TestRunRecord, WorktreeRecord } from '../../shared/contracts';
import { parseCommandLine } from '../git/commandLine';
import { ProcessSupervisor, type SupervisedProcess } from '../process/ProcessSupervisor';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';

interface ActiveTestRun {
  taskId: string;
  testRunId: string;
  process: SupervisedProcess;
}

export class LocalTestRunner {
  private readonly supervisor = new ProcessSupervisor();
  private readonly active = new Map<string, ActiveTestRun>();

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus
  ) {}

  async start(
    task: Task,
    worktree: WorktreeRecord,
    gitSnapshot: GitSnapshotRecord
  ): Promise<TestRunRecord> {
    if (this.active.has(task.id)) {
      throw new Error('A test run is already active for this task.');
    }

    const commandLine = task.testCommand?.trim() || 'npm test';
    const command = parseCommandLine(commandLine);
    const testRun = await this.store.createTestRun({
      task,
      worktree,
      gitSnapshot,
      commandLine,
      executable: command.executable,
      argv: command.argv
    });

    this.emitUpdate('test.started', task.id, testRun.id, worktree.id, testRun);

    const process = this.supervisor.start({
      executable: command.executable,
      argv: command.argv,
      cwd: worktree.worktreePath
    });
    this.active.set(task.id, { taskId: task.id, testRunId: testRun.id, process });

    process.events.on('started', async ({ pid }) => {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'TEST_PROCESS_STARTED',
          taskId: task.id,
          testRunId: testRun.id,
          worktreeId: worktree.id,
          iterationId: worktree.iterationId,
          source: 'test',
          payload: { pid }
        })
      );
      this.emitUpdate('projection.updated', task.id, testRun.id, worktree.id, { pid });
    });

    process.events.on('stdout', (chunk) => {
      void this.handleOutput(task, worktree, testRun, chunk, 'stdout');
    });

    process.events.on('stderr', (chunk) => {
      void this.handleOutput(task, worktree, testRun, chunk, 'stderr');
    });

    process.events.on('error', (error) => {
      void this.complete(task, worktree, testRun, {
        exitCode: null,
        signal: null,
        error: error.message
      });
    });

    process.events.on('close', ({ exitCode, signal }) => {
      void this.complete(task, worktree, testRun, { exitCode, signal });
    });

    return testRun;
  }

  private async handleOutput(
    task: Task,
    worktree: WorktreeRecord,
    testRun: TestRunRecord,
    chunk: Buffer,
    stream: 'stdout' | 'stderr'
  ): Promise<void> {
    const text = chunk.toString('utf8');
    await this.store.appendArtifact(
      stream === 'stdout' ? testRun.stdoutArtifactId : testRun.stderrArtifactId,
      text
    );
    await this.store.appendEvent(
      createDomainEvent({
        type: stream === 'stdout' ? 'TEST_STDOUT_CHUNK' : 'TEST_STDERR_CHUNK',
        taskId: task.id,
        testRunId: testRun.id,
        worktreeId: worktree.id,
        iterationId: worktree.iterationId,
        source: 'test',
        payload: { text }
      })
    );
    this.emitUpdate('test.output', task.id, testRun.id, worktree.id, { stream, text });
  }

  private async complete(
    task: Task,
    worktree: WorktreeRecord,
    testRun: TestRunRecord,
    result: { exitCode: number | null; signal: NodeJS.Signals | null; error?: string }
  ): Promise<void> {
    await this.store.appendEvent(
      createDomainEvent({
        type: 'TEST_RUN_COMPLETED',
        taskId: task.id,
        testRunId: testRun.id,
        worktreeId: worktree.id,
        iterationId: worktree.iterationId,
        source: 'test',
        payload: result
      })
    );
    this.active.delete(task.id);
    this.emitUpdate('test.terminal', task.id, testRun.id, worktree.id, result);
  }

  private emitUpdate(
    type: AppUpdateEvent['type'],
    taskId: string,
    testRunId: string,
    worktreeId: string,
    payload: unknown
  ): void {
    this.events.emit({
      type,
      taskId,
      testRunId,
      worktreeId,
      payload,
      at: new Date().toISOString()
    });
  }
}
