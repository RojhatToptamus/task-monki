import type {
  AgentProtocolMessageReference,
  AgentServerInstance
} from '../../shared/agent';
import type {
  AgentProviderRuntimeStore,
  CreateAgentRuntimeServerInput
} from '../../core/agent/AgentRuntimeStore';
import { FileAgentRuntimeStore } from '../../core/storage/FileAgentRuntimeStore';

const OMITTED_REASONING = '[OMITTED: private model reasoning is not a lab artifact]';

/**
 * Narrow provider-lifecycle store for the lab. It cannot create Task Monki
 * Tasks, discourse waves, reviews, Git records, or delivery evidence.
 */
export class LabProviderRuntimeStore implements AgentProviderRuntimeStore {
  private readonly delegate: FileAgentRuntimeStore;

  constructor(rootDirectory: string) {
    this.delegate = new FileAgentRuntimeStore(rootDirectory);
  }

  init(): Promise<void> {
    return this.delegate.init();
  }

  close(): Promise<void> {
    return this.delegate.close();
  }

  async assertProviderOnlyState(): Promise<void> {
    const state = await this.delegate.snapshot();
    if (
      state.sessions.length > 0 ||
      state.runs.length > 0 ||
      state.queueEntries.length > 0 ||
      state.artifacts.length > 0 ||
      state.telemetryRecords.length > 0
    ) {
      throw new Error('Discourse Lab runtime store contains non-provider execution state.');
    }
  }

  createAgentServer(input: CreateAgentRuntimeServerInput): Promise<AgentServerInstance> {
    return this.delegate.createAgentServer(input);
  }

  listAgentServers(): Promise<AgentServerInstance[]> {
    return this.delegate.listAgentServers();
  }

  getAgentServer(serverInstanceId: string): Promise<AgentServerInstance | undefined> {
    return this.delegate.getAgentServer(serverInstanceId);
  }

  updateAgentServer(
    serverInstanceId: string,
    update: Parameters<AgentProviderRuntimeStore['updateAgentServer']>[1]
  ): Promise<AgentServerInstance> {
    return this.delegate.updateAgentServer(serverInstanceId, update);
  }

  appendProtocolMessage(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    return this.delegate.appendProtocolMessage(
      serverInstanceId,
      direction,
      sanitizeLabProtocolRecord(raw),
      metadata
    );
  }

  readProtocolMessage(reference: AgentProtocolMessageReference): Promise<{
    raw: string;
    metadata?: Record<string, unknown>;
  }> {
    return this.delegate.readProtocolMessage(reference);
  }
}

/** Keeps lifecycle and public answers while discarding any completed private reasoning. */
export function sanitizeLabProtocolRecord(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
  const message = value as Record<string, unknown>;
  if (
    (message.method === 'item/started' || message.method === 'item/completed') &&
    message.params &&
    typeof message.params === 'object' &&
    !Array.isArray(message.params)
  ) {
    const params = message.params as Record<string, unknown>;
    if (isReasoningItem(params.item)) {
      return JSON.stringify({
        ...message,
        params: {
          ...params,
          item: { ...(params.item as Record<string, unknown>), summary: [], content: [] }
        }
      });
    }
  }
  if (
    message.method === 'rawResponseItem/completed' &&
    message.params &&
    typeof message.params === 'object' &&
    !Array.isArray(message.params)
  ) {
    const params = message.params as Record<string, unknown>;
    if (
      params.item &&
      typeof params.item === 'object' &&
      !Array.isArray(params.item) &&
      (params.item as Record<string, unknown>).type === 'reasoning'
    ) {
      return JSON.stringify({
        ...message,
        params: { ...params, item: { type: 'reasoning', content: OMITTED_REASONING } }
      });
    }
  }
  const forkOrReadResponse = sanitizeThreadResponseReasoning(message);
  if (forkOrReadResponse) return JSON.stringify(forkOrReadResponse);
  return raw;
}

/**
 * `thread/fork` and `thread/read` RPC responses can embed completed turns.
 * Their reasoning items arrive inside an ordinary id/result response rather
 * than an item notification, so they need their own structural redaction.
 */
function sanitizeThreadResponseReasoning(
  message: Record<string, unknown>
): Record<string, unknown> | undefined {
  const result = recordValue(message.result);
  const thread = recordValue(result?.thread);
  const turns = thread?.turns;
  if (!Array.isArray(turns)) return undefined;
  let changed = false;
  const sanitizedTurns = turns.map((turn) => {
    const turnRecord = recordValue(turn);
    if (!turnRecord || !Array.isArray(turnRecord.items)) return turn;
    let turnChanged = false;
    const items = turnRecord.items.map((item) => {
      if (!isReasoningItem(item)) return item;
      changed = true;
      turnChanged = true;
      return {
        ...(item as Record<string, unknown>),
        summary: [],
        content: []
      };
    });
    return turnChanged ? { ...turnRecord, items } : turn;
  });
  if (!changed) return undefined;
  return {
    ...message,
    result: {
      ...result!,
      thread: { ...thread!, turns: sanitizedTurns }
    }
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isReasoningItem(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'reasoning'
  );
}
