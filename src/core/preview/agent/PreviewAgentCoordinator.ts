import { randomUUID } from 'node:crypto';
import { PreviewError } from 'previewhost';
import type { AgentRuntimeId } from '../../../shared/agent';
import type {
  AgentExecutionSettings,
  AgentSessionRecord,
  RunRecord,
  SendPreviewAgentMessageRequest,
  Task,
  TaskDetailSnapshot,
  TaskInstruction,
  TaskIteration,
  WorktreeRecord
} from '../../../shared/contracts';
import { TASK_INSTRUCTION_MAX_LENGTH, TASK_INSTRUCTION_QUEUE_LIMIT } from '../../../shared/contracts';
import { buildPreviewAgentTurnPrompt } from '../../../shared/promptTemplates';
import type { AgentOrchestrator } from '../../agent/AgentOrchestrator';
import type { AgentRuntimeAdapter } from '../../agent/AgentRuntimeAdapter';
import type { AgentRuntimeRegistry } from '../../agent/AgentRuntimeRegistry';
import type { ClientToolHandler } from '../../agent/clientTools/ClientToolBridge';
import { projectAgentExecutionSupport } from '../../../shared/agentExecutionSupport';
import { mergeRunSettings } from '../../app/AgentRunSettingsPolicy';
import { ACTIVE_AGENT_RUN_STATUSES } from '../../app/TaskTransitionPolicy';
import type { AppEventBus } from '../../runner/AppEventBus';
import type { SqliteTaskStore } from '../../storage/SqliteTaskStore';
import type { ApplicationPreviewService } from '../ApplicationPreviewService';
import type { PreviewRecipeGenerationService } from '../generation/PreviewRecipeGenerationService';
import { describePreviewState, EXPIRED_LOGS_REPORT, PREVIEW_LOG_READ_BYTES, previewLogsReport, previewStatusReport, proposalReport } from './PreviewAgentTools';
import {
  INSPECT_PREVIEW_TOOL_DEFINITION,
  PROPOSE_PREVIEW_CONFIGURATION_TOOL_DEFINITION,
  parseInspectPreviewArguments,
  parseProposePreviewConfigurationArguments
} from './PreviewClientToolContract';

export interface PreviewAgentContext {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
}

export interface PreviewAgentCoordinatorOptions {
  store: Pick<SqliteTaskStore, 'getTaskDetail' | 'getRun' | 'updateTaskInstructions' | 'getBoardSnapshot'>;
  agents: Pick<AgentOrchestrator, 'startTurn' | 'interruptRun' | 'assertPreviewRepositoryUnchanged'>;
  runtimes: Pick<AgentRuntimeRegistry, 'require'>;
  events: Pick<AppEventBus, 'emit'>;
  applications: Pick<ApplicationPreviewService, 'read' | 'readFile' | 'owner' | 'name'>;
  proposals: PreviewRecipeGenerationService;
  /** The task, iteration and verified worktree a Preview conversation runs against. */
  requireContext(taskId: string): Promise<PreviewAgentContext>;
  /** Runtime, model and provider defaults from Settings; a message may override them. */
  defaultSettings(): AgentExecutionSettings;
  assertRuntimeUsable(adapter: AgentRuntimeAdapter): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HELD_AFTER_STOP = 'Stopped. Send each message when you are ready.';
const HELD_AFTER_FAILURE = 'The message could not start. Review the remaining messages.';
const HELD_AFTER_ATTENTION = 'The agent needs attention. Send each message when you are ready.';

/**
 * The task's Preview conversation: a detached PREVIEW session per runtime and model on the task
 * worktree. Messages are durable `TaskInstruction` records with role PREVIEW: one starts a turn
 * at once when the agent is idle, otherwise it waits in the FIFO queue behind the active run and
 * is sent when that run completes. The agent reads preview state and submits proposals through
 * app-owned tools; saving, starting and approving stay with the person.
 */
export class PreviewAgentCoordinator {
  constructor(private readonly options: PreviewAgentCoordinatorOptions) {}

  /** Sends a message now, queues it behind the active turn, or sends an earlier queued one on request. */
  async send(input: SendPreviewAgentMessageRequest): Promise<TaskInstruction> {
    if (!UUID.test(input.id)) throw new Error('A valid message ID is required.');
    const text = messageText(input.text);
    const context = await this.options.requireContext(input.taskId);
    const detail = await this.options.store.getTaskDetail(input.taskId);
    const existing = detail.taskInstructions.find((record) => record.id === input.id);
    if (existing && (existing.role !== 'PREVIEW' || existing.text !== text)) {
      throw new Error('This message ID has already been used for different content.');
    }
    if (existing && !this.isPending(existing, detail)) return existing;
    const active = activePreviewRun(detail);
    if (active) return this.enqueue(input.id, text, existing, active);
    const execution = await this.resolveExecution(context, input.settings);
    const session = conversationSession(detail, context, execution);
    const sessionId = session?.id ?? randomUUID();
    const runId = existing?.runId ?? randomUUID();
    const record = await this.update(input.taskId, (records) => {
      if (existing) {
        const current = records.find((item) => item.id === existing.id)!;
        return Object.assign(current, { status: 'SENDING', runId, sourceRunId: runId, sessionId, detail: undefined, updatedAt: now() });
      }
      return append(records, { id: input.id, task: context.task, iteration: context.iteration, worktree: context.worktree, text, mode: 'FOLLOW_UP', status: 'SENDING', runId, sourceRunId: runId, sessionId });
    });
    await this.startTurn(record, context, execution.settings, session ? { sessionId: session.id } : { createSessionId: sessionId });
    return (await this.options.store.getTaskDetail(input.taskId)).taskInstructions.find((item) => item.id === record.id)!;
  }

  /** Interrupts the active turn; queued messages are held until the person sends them again. */
  async stop(taskId: string): Promise<void> {
    const detail = await this.options.store.getTaskDetail(taskId);
    const active = activePreviewRun(detail);
    if (!active) return;
    await this.hold(taskId, HELD_AFTER_STOP);
    await this.options.agents.interruptRun(active.id);
  }

  /** After a Preview turn ends, sends the next queued message in the same session or holds the queue. */
  async dispatch(runId: string): Promise<void> {
    const run = await this.options.store.getRun(runId);
    if (!run || run.mode !== 'PREVIEW') return;
    const detail = await this.options.store.getTaskDetail(run.taskId);
    const next = detail.taskInstructions
      .filter((item) => item.role === 'PREVIEW' && item.status === 'QUEUED' && item.sourceRunId === runId)
      .sort((left, right) => left.order - right.order)[0];
    if (!next) return;
    const attention = run.status !== 'COMPLETED' || activePreviewRun(detail) ||
      detail.interactionRequests.some((item) => item.sessionId === run.sessionId && ['PENDING', 'RESPONDING'].includes(item.status));
    if (attention) {
      await this.hold(run.taskId, run.status === 'INTERRUPTED' ? HELD_AFTER_STOP : HELD_AFTER_ATTENTION);
      return;
    }
    let context: PreviewAgentContext;
    try {
      context = await this.options.requireContext(run.taskId);
      if (context.iteration.id !== run.iterationId || context.worktree.id !== run.worktreeId) throw new Error('The task worktree changed.');
    } catch (error) {
      await this.hold(run.taskId, `${messageOf(error)} Send each message when you are ready.`);
      return;
    }
    const nextRunId = randomUUID();
    const record = await this.update(run.taskId, (records) => {
      const current = records.find((item) => item.id === next.id);
      if (current?.status !== 'QUEUED') throw new Error('The message is no longer waiting to send.');
      Object.assign(current, { status: 'SENDING', runId: nextRunId, sourceRunId: nextRunId, detail: undefined, updatedAt: now() });
      // The rest of the chain now waits behind the turn this message starts.
      for (const item of records) {
        if (item.role === 'PREVIEW' && item.status === 'QUEUED' && item.sourceRunId === runId) item.sourceRunId = nextRunId;
      }
      return current;
    });
    try {
      await this.startTurn(record, context, run.requestedSettings, { sessionId: run.sessionId });
    } catch {
      // The receipt already records the failure; the queue is held.
    }
  }

  /** The app-owned tools a Preview run may call. */
  handlers(): ClientToolHandler[] {
    return [
      {
        definition: INSPECT_PREVIEW_TOOL_DEFINITION,
        call: async ({ runId, arguments: value }) => {
          const request = parseInspectPreviewArguments(value);
          const { context, snapshot } = await this.previewFor(runId);
          if (request.what === 'status') {
            const file = await this.options.applications.readFile(context.worktree);
            const { repositories } = await this.options.store.getBoardSnapshot();
            const projectRepositoryPath = repositories.find((repository) => repository.id === context.task.repositoryId)?.path;
            return { text: previewStatusReport({ snapshot, repositories, projectRepositoryPath, configurationFile: file.file?.name, proposal: this.options.proposals.get(context.task.id).draft }) };
          }
          const attempt = snapshot.status?.candidate ?? snapshot.status?.latest ?? snapshot.status?.active;
          if (!attempt) return { text: 'There are no runs yet, so there are no logs. Read the configuration and project files instead.' };
          const logs = await this.options.applications
            .owner()
            .logs(this.options.applications.name(context.worktree), attempt.id, { source: request.source, maxBytes: PREVIEW_LOG_READ_BYTES })
            .catch((error: unknown) => {
              // Run logs live only as long as the runtime that captured them; the state and configuration remain.
              if (error instanceof PreviewError && error.code === 'ATTEMPT_EXPIRED') return undefined;
              throw error;
            });
          if (!logs) return { text: EXPIRED_LOGS_REPORT };
          return { text: previewLogsReport({ attempt, source: request.source, text: logs.text, truncated: logs.truncated, lines: request.lines }) };
        }
      },
      {
        definition: PROPOSE_PREVIEW_CONFIGURATION_TOOL_DEFINITION,
        call: async ({ runId, arguments: value }) => {
          const proposal = parseProposePreviewConfigurationArguments(value);
          const { context } = await this.previewFor(runId);
          await this.options.agents.assertPreviewRepositoryUnchanged(runId);
          const result = await this.options.proposals.propose({ taskId: context.task.id, worktreePath: context.worktree.worktreePath, ...proposal });
          if (result.status === 'READY') this.publishProposals(context);
          return { text: proposalReport(result) };
        }
      }
    ];
  }

  /** Tells the renderer the proposal state of a task changed. */
  publishProposals(context: PreviewAgentContext): void {
    this.options.events.emit({
      type: 'preview.recipe-generation.updated',
      taskId: context.task.id,
      iterationId: context.iteration.id,
      worktreeId: context.worktree.id,
      payload: this.options.proposals.get(context.task.id),
      at: now()
    });
  }

  private async previewFor(runId: string) {
    const run = await this.options.store.getRun(runId);
    if (!run || run.mode !== 'PREVIEW') throw new Error('This tool is available only to the Preview agent.');
    const context = await this.options.requireContext(run.taskId);
    if (context.worktree.id !== run.worktreeId) throw new Error('The task worktree changed. Ask the person to start a new conversation.');
    return { run, context, snapshot: await this.options.applications.read(context.worktree) };
  }

  private async resolveExecution(context: PreviewAgentContext, overrides: AgentExecutionSettings | undefined) {
    const requested: AgentExecutionSettings = { ...this.options.defaultSettings(), ...overrides };
    const adapter = this.options.runtimes.require(requested.runtimeId ?? context.task.runtimeId);
    await this.options.assertRuntimeUsable(adapter);
    const settings = await resolvePreviewAgentExecution(adapter, { ...requested, runtimeId: adapter.descriptor.id });
    return { runtimeId: adapter.descriptor.id, settings };
  }

  private async startTurn(
    record: TaskInstruction,
    context: PreviewAgentContext,
    settings: AgentExecutionSettings,
    session: { sessionId: string } | { createSessionId: string }
  ): Promise<void> {
    try {
      const snapshot = await this.options.applications.read(context.worktree);
      const run = await this.options.agents.startTurn({
        runId: record.runId,
        task: context.task,
        iteration: context.iteration,
        worktree: context.worktree,
        mode: 'PREVIEW',
        instructionProfile: 'PREVIEW',
        role: 'PREVIEW',
        prompt: buildPreviewAgentTurnPrompt({
          message: record.text,
          state: describePreviewState(snapshot, this.options.proposals.get(context.task.id).draft)
        }),
        settings,
        ...session
      });
      await this.receipt(record, { status: 'SUBMITTED', runId: run.id, sessionId: run.sessionId });
    } catch (error) {
      const admitted = record.runId ? await this.options.store.getRun(record.runId) : undefined;
      await this.receipt(record, admitted ? { status: 'SUBMITTED' } : { status: 'FAILED', detail: messageOf(error) });
      await this.hold(record.taskId, HELD_AFTER_FAILURE);
      throw error;
    }
  }

  private async enqueue(id: string, text: string, existing: TaskInstruction | undefined, active: RunRecord): Promise<TaskInstruction> {
    return this.update(active.taskId, (records) => {
      if (existing) {
        const current = records.find((item) => item.id === existing.id)!;
        return Object.assign(current, { status: 'QUEUED', sourceRunId: active.id, sessionId: active.sessionId, detail: undefined, updatedAt: now() });
      }
      if (records.filter((item) => item.role === 'PREVIEW' && ['QUEUED', 'HELD'].includes(item.status)).length >= TASK_INSTRUCTION_QUEUE_LIMIT) {
        throw new Error(`Keep at most ${TASK_INSTRUCTION_QUEUE_LIMIT} pending messages.`);
      }
      return append(records, {
        id, task: { id: active.taskId }, iteration: { id: active.iterationId }, worktree: { id: active.worktreeId },
        text, mode: 'QUEUE', status: 'QUEUED', sourceRunId: active.id, sessionId: active.sessionId
      });
    });
  }

  private isPending(record: TaskInstruction, detail: TaskDetailSnapshot): boolean {
    return ['QUEUED', 'HELD'].includes(record.status) ||
      (record.status === 'FAILED' && !!record.runId && !detail.runs.some((run) => run.id === record.runId));
  }

  private receipt(record: TaskInstruction, update: Partial<Pick<TaskInstruction, 'status' | 'runId' | 'sessionId' | 'detail'>>): Promise<TaskInstruction> {
    return this.update(record.taskId, (records) => {
      const current = records.find((item) => item.id === record.id);
      if (!current) throw new Error('The message receipt is missing.');
      return Object.assign(current, { detail: undefined, ...update, updatedAt: now() });
    });
  }

  private async hold(taskId: string, detail: string): Promise<void> {
    const pending = (await this.options.store.getTaskDetail(taskId)).taskInstructions.some((item) => item.role === 'PREVIEW' && item.status === 'QUEUED');
    if (!pending) return;
    await this.update(taskId, (records) => {
      for (const item of records) {
        if (item.role === 'PREVIEW' && item.status === 'QUEUED') Object.assign(item, { status: 'HELD', detail, updatedAt: now() });
      }
    });
  }

  private async update<T>(taskId: string, mutate: (records: TaskInstruction[]) => T): Promise<T> {
    const result = await this.options.store.updateTaskInstructions(taskId, (records) => mutate(records));
    this.options.events.emit({ type: 'task.updated', taskId, payload: { instructionsChanged: true }, at: now() });
    return structuredClone(result);
  }
}

/** The run the conversation is working on, if any. */
export function activePreviewRun(detail: Pick<TaskDetailSnapshot, 'runs'>): RunRecord | undefined {
  return detail.runs.find((run) => run.mode === 'PREVIEW' && ACTIVE_AGENT_RUN_STATUSES.has(run.status));
}

/** The conversation for this runtime and model on the current worktree, if one exists. */
function conversationSession(
  detail: Pick<TaskDetailSnapshot, 'agentSessions'>,
  context: PreviewAgentContext,
  execution: { runtimeId: AgentRuntimeId; settings: AgentExecutionSettings }
): AgentSessionRecord | undefined {
  return detail.agentSessions
    .filter(
      (session) =>
        session.role === 'PREVIEW' &&
        session.taskId === context.task.id &&
        session.iterationId === context.iteration.id &&
        session.worktreeId === context.worktree.id &&
        session.worktreePath === context.worktree.worktreePath &&
        session.runtimeId === execution.runtimeId &&
        session.requestedSettings.model === execution.settings.model &&
        session.requestedSettings.modelProvider === execution.settings.modelProvider
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
}

function append(
  records: TaskInstruction[],
  input: {
    id: string;
    task: Pick<Task, 'id'>;
    iteration: Pick<TaskIteration, 'id'>;
    worktree: Pick<WorktreeRecord, 'id'>;
    text: string;
    mode: TaskInstruction['mode'];
    status: TaskInstruction['status'];
    runId?: string;
    sourceRunId: string;
    sessionId: string;
  }
): TaskInstruction {
  if (records.some((item) => item.id === input.id)) throw new Error('Message already exists.');
  if (records.length >= 1000) throw new Error('This task has reached its message history limit. Start a new task.');
  const at = now();
  const record: TaskInstruction = {
    id: input.id,
    taskId: input.task.id,
    iterationId: input.iteration.id,
    worktreeId: input.worktree.id,
    sourceRunId: input.sourceRunId,
    sessionId: input.sessionId,
    order: Math.max(0, ...records.map((item) => item.order)) + 1,
    text: input.text,
    mode: input.mode,
    status: input.status,
    role: 'PREVIEW',
    ...(input.runId ? { runId: input.runId } : {}),
    createdAt: at,
    updatedAt: at
  };
  records.push(record);
  return record;
}

function messageText(text: string): string {
  if (typeof text !== 'string' || !text.trim() || text.length > TASK_INSTRUCTION_MAX_LENGTH) {
    throw new Error(`Write a message of at most ${TASK_INSTRUCTION_MAX_LENGTH.toLocaleString()} characters.`);
  }
  return text.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Resolves read-only analysis execution, allowing explicit folder inspection requests,
 * and never a silently substituted model. Settings validation and every turn use the same rule.
 */
export async function resolvePreviewAgentExecution(
  adapter: AgentRuntimeAdapter,
  requested: AgentExecutionSettings
): Promise<AgentExecutionSettings> {
  if (requested.runtimeId !== undefined && requested.runtimeId !== adapter.descriptor.id) {
    throw new Error('Agent runtime and execution settings runtime must match.');
  }
  const support = projectAgentExecutionSupport(await adapter.capabilities(), 'PREVIEW_AGENT');
  if (!support.supported) throw new Error(`${adapter.descriptor.displayName}: ${support.reason}`);
  const resolved = await adapter.resolveExecution({
    settings: {
      ...mergeRunSettings({ readOnly: true, settings: [{ ...requested, runtimeId: adapter.descriptor.id }] }),
      approvalPolicy: 'on-request'
    },
    attachments: []
  });
  if (resolved.settings.runtimeId !== adapter.descriptor.id || resolved.model.runtimeId !== adapter.descriptor.id) {
    throw new Error(`${adapter.descriptor.displayName} returned execution settings for another runtime.`);
  }
  const model = requested.model?.trim();
  if (model && (resolved.model.model !== model || resolved.settings.model !== model)) {
    throw new Error(`${adapter.descriptor.displayName} did not resolve the selected Preview model.`);
  }
  const provider = requested.modelProvider?.trim();
  if (provider && (resolved.model.modelProvider !== provider || resolved.settings.modelProvider !== provider)) {
    throw new Error(`${adapter.descriptor.displayName} did not resolve the selected Preview model provider.`);
  }
  return resolved.settings;
}
