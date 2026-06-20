import { randomUUID } from 'node:crypto';
import { buildCodexExecCommand } from '../codex/commandBuilder';
import { parseCodexJsonLine, type ParsedJsonLine } from '../codex/jsonlParser';
import { ProcessSupervisor, type SupervisedProcess } from '../process/ProcessSupervisor';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import type { AppUpdateEvent, RunRecord, Task } from '../../shared/contracts';
import { AppEventBus } from './AppEventBus';

interface ActiveRun {
  taskId: string;
  runId: string;
  process: SupervisedProcess;
}

interface StdoutParseState {
  lineBuffer: string;
  pendingJsonText: string;
  terminalCodexEvent?: ParsedJsonLine;
  lastMessage?: string;
}

export class CodexExecRunner {
  private readonly supervisor = new ProcessSupervisor();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly store: FileTaskStore,
    private readonly events: AppEventBus
  ) {}

  async start(task: Task): Promise<RunRecord> {
    if (this.activeRuns.has(task.id)) {
      throw new Error('A run is already active for this task.');
    }

    const command = buildCodexExecCommand({
      repositoryPath: task.repositoryPath,
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    });

    const run = await this.store.createRun(task, command);
    this.emitUpdate('run.started', task.id, run.id, run);

    const process = this.supervisor.start({
      executable: command.executable,
      argv: command.argv,
      cwd: task.repositoryPath,
      stdin: `${task.prompt}\n\nRemember: this is a read-only analysis run. Do not modify files.\n`
    });

    this.activeRuns.set(task.id, { taskId: task.id, runId: run.id, process });

    const stdoutState: StdoutParseState = {
      lineBuffer: '',
      pendingJsonText: ''
    };
    let stdoutQueue = Promise.resolve();

    process.events.on('started', async ({ pid }) => {
      await this.store.appendEvent(
        createDomainEvent({
          type: 'PROCESS_STARTED',
          taskId: task.id,
          runId: run.id,
          source: 'process',
          payload: { pid }
        })
      );
      this.emitUpdate('projection.updated', task.id, run.id, { pid });
    });

    process.events.on('stdout', (chunk) => {
      stdoutQueue = stdoutQueue
        .then(() => this.handleStdoutChunk(task, run, chunk, stdoutState))
        .catch((error: unknown) =>
          this.handleProcessError(
            task,
            run,
            error instanceof Error ? error : new Error(String(error))
          )
        );
    });

    process.events.on('stderr', (chunk) => {
      void this.handleStderrChunk(task, run, chunk);
    });

    process.events.on('error', (error) => {
      void this.handleProcessError(task, run, error);
    });

    process.events.on('close', ({ exitCode, signal }) => {
      void stdoutQueue.then(() =>
        this.handleClose(task, run, {
          exitCode,
          signal,
          stdoutState
        })
      );
    });

    return run;
  }

  async cancel(runId: string): Promise<void> {
    const active = [...this.activeRuns.values()].find((candidate) => candidate.runId === runId);
    if (!active) {
      return;
    }

    await this.store.appendEvent(
      createDomainEvent({
        type: 'CANCEL_REQUESTED',
        taskId: active.taskId,
        runId,
        source: 'ui',
        payload: {}
      })
    );
    this.emitUpdate('projection.updated', active.taskId, runId, { status: 'CANCEL_REQUESTED' });
    await active.process.cancel();
  }

  private async handleStdoutChunk(
    task: Task,
    run: RunRecord,
    chunk: Buffer,
    state: StdoutParseState
  ): Promise<void> {
    const text = chunk.toString('utf8');
    await this.store.appendArtifact(run.stdoutArtifactId, text);
    this.emitUpdate('run.output', task.id, run.id, { text });

    state.lineBuffer += text;
    const lines = state.lineBuffer.split(/\r?\n/);
    state.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      await this.handleStdoutSegment(task, run, line, state);
    }
  }

  private async handleStdoutSegment(
    task: Task,
    run: RunRecord,
    segment: string,
    state: StdoutParseState
  ): Promise<void> {
    if (!segment.trim()) {
      return;
    }

    if (state.pendingJsonText && segment.trimStart().startsWith('{')) {
      await this.emitUnparsedStdout(task, run, state.pendingJsonText, {
        parseError: 'New JSON object started before the pending payload became parseable.'
      });
      state.pendingJsonText = '';
    }

    const candidate = state.pendingJsonText
      ? `${state.pendingJsonText}\n${segment}`
      : segment;

    if (!candidate.trimStart().startsWith('{')) {
      await this.emitUnparsedStdout(task, run, segment);
      return;
    }

    const parsed = parseCodexJsonLine(candidate);
    if (!parsed.ok) {
      if (looksCompleteObject(candidate)) {
        await this.emitUnparsedStdout(task, run, candidate, { parseError: parsed.error });
        state.pendingJsonText = '';
        return;
      }
      state.pendingJsonText = candidate;
      return;
    }

    state.pendingJsonText = '';
    await this.store.appendArtifact(run.jsonlArtifactId, `${candidate}\n`);
    await this.store.appendEvent(
      createDomainEvent({
        type: 'CODEX_STDOUT_LINE',
        taskId: task.id,
        runId: run.id,
        source: 'codex',
        payload: { line: candidate, parseable: true }
      })
    );

    if (parsed.isTerminal) {
      state.terminalCodexEvent = parsed;
    }
    if (parsed.messageText) {
      state.lastMessage = parsed.messageText;
    }

    await this.store.appendEvent(
      createDomainEvent({
        type: 'CODEX_EVENT_PARSED',
        taskId: task.id,
        runId: run.id,
        source: 'codex',
        sourceEventId: `${run.id}:${parsed.eventType}:${randomUUID()}`,
        payload: {
          eventType: parsed.eventType,
          terminalStatus: parsed.terminalStatus,
          messageText: parsed.messageText,
          raw: parsed.raw
        }
      })
    );
    this.emitUpdate('run.eventParsed', task.id, run.id, parsed);
  }

  private async handleStderrChunk(task: Task, run: RunRecord, chunk: Buffer): Promise<void> {
    const text = chunk.toString('utf8');
    await this.store.appendArtifact(run.stderrArtifactId, text);
    await this.store.appendEvent(
      createDomainEvent({
        type: 'CODEX_STDERR_CHUNK',
        taskId: task.id,
        runId: run.id,
        source: 'process',
        payload: { text }
      })
    );
    this.emitUpdate('run.stderr', task.id, run.id, { text });
  }

  private async handleProcessError(task: Task, run: RunRecord, error: Error): Promise<void> {
    const finalArtifact = await this.store.writeFinalArtifact(
      task.id,
      run.id,
      `# Codex run failed\n\n${error.message}\n`
    );
    await this.store.appendEvent(
      createDomainEvent({
        type: 'CODEX_RUN_FAILED',
        taskId: task.id,
        runId: run.id,
        source: 'process',
        payload: { error: error.message, finalArtifactId: finalArtifact.id }
      })
    );
    this.emitUpdate('run.terminal', task.id, run.id, { error: error.message });
  }

  private async handleClose(
    task: Task,
    run: RunRecord,
    details: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdoutState: StdoutParseState;
    }
  ): Promise<void> {
    if (details.stdoutState.lineBuffer.trim()) {
      await this.handleStdoutSegment(task, run, details.stdoutState.lineBuffer, details.stdoutState);
      details.stdoutState.lineBuffer = '';
    }

    if (details.stdoutState.pendingJsonText.trim()) {
      await this.emitUnparsedStdout(task, run, details.stdoutState.pendingJsonText, {
        parseError: 'Incomplete or non-JSON stdout payload.'
      });
      details.stdoutState.pendingJsonText = '';
    }

    await this.store.appendEvent(
      createDomainEvent({
        type: details.signal ? 'PROCESS_SIGNALED' : 'PROCESS_EXITED',
        taskId: task.id,
        runId: run.id,
        source: 'process',
        payload: { exitCode: details.exitCode, signal: details.signal }
      })
    );

    const isSuccess =
      details.exitCode === 0 && details.stdoutState.terminalCodexEvent?.terminalStatus !== 'failed';
    const content = formatFinalArtifact({
      task,
      run,
      exitCode: details.exitCode,
      signal: details.signal,
      terminalCodexEvent: details.stdoutState.terminalCodexEvent,
      lastMessage: details.stdoutState.lastMessage,
      isSuccess
    });
    const finalArtifact = await this.store.writeFinalArtifact(task.id, run.id, content);

    await this.store.appendEvent(
      createDomainEvent({
        type: isSuccess ? 'CODEX_RUN_COMPLETED' : 'CODEX_RUN_FAILED',
        taskId: task.id,
        runId: run.id,
        source: 'codex',
        payload: {
          exitCode: details.exitCode,
          signal: details.signal,
          terminalStatus: details.stdoutState.terminalCodexEvent?.terminalStatus,
          finalArtifactId: finalArtifact.id
        }
      })
    );

    this.activeRuns.delete(task.id);
    this.emitUpdate('run.terminal', task.id, run.id, {
      exitCode: details.exitCode,
      signal: details.signal,
      finalArtifactId: finalArtifact.id
    });
  }

  private emitUpdate(
    type: AppUpdateEvent['type'],
    taskId: string,
    runId: string | undefined,
    payload: unknown
  ): void {
    this.events.emit({
      type,
      taskId,
      runId,
      payload,
      at: new Date().toISOString()
    });
  }

  private async emitUnparsedStdout(
    task: Task,
    run: RunRecord,
    line: string,
    extraPayload: Record<string, unknown> = {}
  ): Promise<void> {
    await this.store.appendEvent(
      createDomainEvent({
        type: 'CODEX_STDOUT_LINE',
        taskId: task.id,
        runId: run.id,
        source: 'codex',
        payload: { line, parseable: false, ...extraPayload }
      })
    );
  }
}

function looksCompleteObject(value: string): boolean {
  return value.trimEnd().endsWith('}');
}

function formatFinalArtifact(input: {
  task: Task;
  run: RunRecord;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminalCodexEvent?: ParsedJsonLine;
  lastMessage?: string;
  isSuccess: boolean;
}): string {
  const status = input.isSuccess ? 'completed' : 'failed';
  return [
    `# Read-only Codex run ${status}`,
    '',
    `Task: ${input.task.title}`,
    `Run: ${input.run.id}`,
    `Repository: ${input.task.repositoryPath}`,
    `Exit code: ${input.exitCode ?? 'null'}`,
    `Signal: ${input.signal ?? 'null'}`,
    `Terminal Codex status: ${input.terminalCodexEvent?.terminalStatus ?? 'unknown'}`,
    '',
    '## Final message',
    '',
    input.lastMessage?.trim() || 'No final message text was extracted from the JSONL stream.',
    ''
  ].join('\n');
}
