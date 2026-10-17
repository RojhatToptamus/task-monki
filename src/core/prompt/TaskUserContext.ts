import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import type { AgentUserInputRequest } from '../../shared/agent';
import type { Task } from '../../shared/contracts';
import { buildRemoteWorkContext } from '../../shared/promptTemplates';
import { REMOTE_WORK_SNAPSHOT_SCHEMA, type RemoteWorkSnapshot } from '../../shared/remoteWork';

// Bound prompt growth without silently forgetting a user decision.
const MAX_USER_CONTEXT_LENGTH = 131_072;

/** Rebuild authored context from its existing owners, independently of provider session memory. */
export async function readTaskUserContext(
  store: SqliteTaskStore,
  taskId: string,
  options: { throughRunId?: string; beforeDesignTurnOrder?: number } = {}
): Promise<string> {
  const detail = await store.getTaskDetail(taskId);
  // Reviews and questions in Ask are separate from the task's conversation, not task intent.
  const runs = detail.runs.filter((run) => run.mode !== 'REVIEW' && run.mode !== 'SIDE_QUESTION');
  const sourceRun = options.throughRunId ? runs.find((run) => run.id === options.throughRunId) : undefined;
  if (options.throughRunId && !sourceRun) throw new Error('User context source run is unavailable.');
  // Runtime projections can reload in a different order. The source run owns the cutoff.
  const includedRuns = new Set(runs.filter((run) => !sourceRun || run.startedAt <= sourceRun.startedAt).map((run) => run.id));
  const cutoff = sourceRun?.endedAt;
  const messages: Array<{ at: string; text: string }> = [];
  let length = 0;
  const append = (at: string, text: string) => {
    length += text.length;
    if (length > MAX_USER_CONTEXT_LENGTH) {
      throw new Error('The user history is too long to send in full. Start a new task with a complete brief; no earlier decisions were dropped.');
    }
    messages.push({ at, text });
  };

  if (detail.task.kind === 'DESIGN') {
    includedRuns.clear();
    let beforeCursor: string | undefined;
    do {
      const page = await store.listDesignConversation({ designId: taskId, beforeCursor });
      for (const entry of page.entries) {
        if (options.beforeDesignTurnOrder !== undefined && entry.turn.order >= options.beforeDesignTurnOrder) continue;
        if (!entry.turn.runId) continue; // Queued messages are not admitted intent yet.
        includedRuns.add(entry.turn.runId);
        if (entry.turn.messageSource !== 'TASK_PROMPT') append(entry.turn.createdAt, `User request:\n${entry.userMessage}`);
      }
      beforeCursor = page.previousCursor;
    } while (beforeCursor);
  } else {
    for (const instruction of detail.taskInstructions) {
      if (!instruction.runId || !includedRuns.has(instruction.runId)) continue;
      if (!['SUBMITTED', 'UNCERTAIN', 'SENDING'].includes(instruction.status)) continue;
      if (cutoff && instruction.createdAt > cutoff) continue;
      const delivery = instruction.status === 'SUBMITTED' ? '' : ' (prior delivery unconfirmed)';
      append(instruction.createdAt, `User instruction${delivery}:\n${instruction.text}`);
    }
  }
  for (const interaction of detail.interactionRequests) {
    if (!includedRuns.has(interaction.runId) || interaction.type !== 'USER_INPUT' || interaction.decision?.interactionType !== 'USER_INPUT') continue;
    const at = interaction.respondedAt ?? interaction.requestedAt;
    if (cutoff && at > cutoff) continue;
    const delivery = interaction.status === 'RESOLVED' ? '' : ' (prior delivery unconfirmed; retained user intent)';
    const answers = interaction.decision.answers;
    append(at, `User answers${delivery}:\n${(interaction.request as AgentUserInputRequest).questions.map((question) =>
      `Question: ${question.question}\nAnswer: ${(answers[question.id] ?? []).join('; ')}`
    ).join('\n\n')}`);
  }
  const remote = await readTaskRemoteContext(store, detail.task);
  if (!messages.length) return remote;
  messages.sort((a, b) => a.at.localeCompare(b.at));
  return [
    remote,
    `Earlier user instructions and answers, in order (user intent, not evidence of execution):\n${messages.map((message) => message.text).join('\n\n')}`
  ].filter(Boolean).join('\n\n');
}

/**
 * The issue or pull request the task was opened from, as captured then. Later
 * edits on the platform do not change what the agent reads.
 */
export async function readTaskRemoteContext(store: SqliteTaskStore, task: Task): Promise<string> {
  const source = task.remoteSource;
  if (!source) return '';
  let snapshot: RemoteWorkSnapshot | undefined;
  try {
    const parsed = JSON.parse(await store.readArtifact(source.snapshotArtifactId)) as RemoteWorkSnapshot;
    if (parsed?.schema === REMOTE_WORK_SNAPSHOT_SCHEMA && parsed.number === source.number) snapshot = parsed;
  } catch {
    // The identity still names the item; the captured text is reported as unavailable.
  }
  return buildRemoteWorkContext(source, snapshot);
}
