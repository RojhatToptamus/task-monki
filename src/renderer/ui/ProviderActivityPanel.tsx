import { useMemo } from 'react';
import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentProtocolMessageReference,
  AgentSessionRecord,
  DomainEvent,
  RunRecord
} from '../../shared/contracts';
import { RawProviderMessage } from './RawProviderMessage';
import { StructuredData, humanizeEnum } from './display';

interface ProviderActivityPanelProps {
  runs: RunRecord[];
  sessions: AgentSessionRecord[];
  items: AgentItemRecord[];
  planRevisions: AgentPlanRevisionRecord[];
  events: DomainEvent[];
}

interface ProviderRunNode {
  run: RunRecord;
  children: ProviderRunNode[];
}

export function ProviderActivityPanel({
  runs,
  sessions,
  items,
  planRevisions,
  events
}: ProviderActivityPanelProps) {
  const runForest = useMemo(() => buildRunForest(runs), [runs]);
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  );
  const itemsByRun = useMemo(() => groupBy(items, (item) => item.runId), [items]);
  const plansByRun = useMemo(
    () => groupBy(planRevisions, (plan) => plan.runId),
    [planRevisions]
  );
  const eventsByRun = useMemo(
    () =>
      groupBy(
        events.filter(
          (event) =>
            event.runId &&
            event.type === 'AGENT_ACTIVITY_RECEIVED' &&
            isRichProviderEvent(asObject(event.payload).eventType)
        ),
        (event) => event.runId ?? ''
      ),
    [events]
  );
  const hasLiveRun = runs.some((run) =>
    ['STARTING', 'RUNNING', 'QUEUED'].includes(run.status)
  );

  if (runs.length === 0) {
    return null;
  }

  return (
    <section className="card provider-activity">
      <details className="provider-activity__details" open={hasLiveRun}>
        <summary className="provider-activity__summary">
          <span>
            <strong>Provider activity</strong>
          </span>
          <span className="count-pill">{runs.length} turns</span>
        </summary>
        <div className="provider-turns provider-activity__body">
          {runForest.map((node, index) => (
            <ProviderRunView
              key={node.run.id}
              node={node}
              depth={0}
              initiallyOpen={index === 0}
              sessionById={sessionById}
              itemsByRun={itemsByRun}
              plansByRun={plansByRun}
              eventsByRun={eventsByRun}
            />
          ))}
        </div>
      </details>
    </section>
  );
}

function ProviderRunView({
  node,
  depth,
  initiallyOpen,
  sessionById,
  itemsByRun,
  plansByRun,
  eventsByRun
}: {
  node: ProviderRunNode;
  depth: number;
  initiallyOpen: boolean;
  sessionById: Map<string, AgentSessionRecord>;
  itemsByRun: Map<string, AgentItemRecord[]>;
  plansByRun: Map<string, AgentPlanRevisionRecord[]>;
  eventsByRun: Map<string, DomainEvent[]>;
}) {
  const run = node.run;
  const session = sessionById.get(run.sessionId);
  const runItems = [...(itemsByRun.get(run.id) ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  const plans = [...(plansByRun.get(run.id) ?? [])].sort(
    (a, b) => a.revision - b.revision
  );
  const providerEvents = eventsByRun.get(run.id) ?? [];
  const childLabel =
    session?.role === 'SUBAGENT'
      ? session.providerNickname ?? session.providerRole ?? 'Subagent'
      : undefined;

  return (
    <div className="provider-run-node" data-depth={depth}>
      <details
        className="provider-turn"
        open={
          initiallyOpen ||
          ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status)
        }
      >
        <summary>
          <span>
            <strong>
              {childLabel ? `${childLabel} · ` : ''}
              {humanizeEnum(run.mode)} turn
            </strong>
            <small>
              {new Date(run.startedAt).toLocaleString()} ·{' '}
              {run.providerTurnId ?? '—'}
            </small>
          </span>
          <span className={`provider-status provider-status--${run.status.toLowerCase()}`}>
            {humanizeEnum(run.status)}
          </span>
        </summary>
        <div className="provider-turn__body">
          {session?.role === 'SUBAGENT' ? (
            <div className="provider-turn__child-context">
              <strong>
                Child thread {session.providerSessionId ?? session.id}
              </strong>
              <span>
                {session.providerRole ?? 'role unreported'} · parent{' '}
                {session.providerParentSessionId ?? session.parentSessionId ?? 'unresolved'}
              </span>
            </div>
          ) : null}
          <div className="provider-turn__provenance">
            <span className="provenance-badge">
              Status source:{' '}
              {run.providerTerminalSource
                ? humanizeEnum(run.providerTerminalSource)
                : run.origin === 'PROVIDER_SUBAGENT'
                  ? 'Observed provider child lifecycle'
                  : 'Task Monki lifecycle'}
            </span>
            {run.providerTerminalRawMessage ? (
              <RawProviderMessage reference={run.providerTerminalRawMessage} />
            ) : null}
          </div>
          {plans.length > 0 ? <PlanHistory plans={plans} /> : null}
          {runItems.map((item) => (
            <ProviderItem key={item.id} item={item} />
          ))}
          {providerEvents.map((event) => (
            <ProviderLifecycleEvent key={event.id} event={event} />
          ))}
          {runItems.length === 0 && plans.length === 0 ? (
            <p className="muted">No materialized provider items for this turn.</p>
          ) : null}
        </div>
      </details>
      {node.children.length > 0 ? (
        <div className="provider-run-node__children">
          {node.children.map((child) => (
            <ProviderRunView
              key={child.run.id}
              node={child}
              depth={depth + 1}
              initiallyOpen={false}
              sessionById={sessionById}
              itemsByRun={itemsByRun}
              plansByRun={plansByRun}
              eventsByRun={eventsByRun}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProviderLifecycleEvent({ event }: { event: DomainEvent }) {
  const payload = asObject(event.payload);
  const eventType = stringValue(payload.eventType) ?? 'provider/event';
  const provenance = asProtocolReference(payload.provenance);
  return (
    <article className="provider-item provider-item--event">
      <header>
        <strong>{providerEventTitle(eventType)}</strong>
        <span>{new Date(event.receivedAt).toLocaleTimeString()}</span>
      </header>
      {eventType === 'error' ? (
        <StructuredData value={payload.error ?? {}} />
      ) : eventType === 'model/rerouted' ? (
        <p>
          {stringValue(payload.fromModel) ?? 'unknown'} →{' '}
          {stringValue(payload.model) ?? 'unknown'} · {String(payload.reason ?? '')}
        </p>
      ) : eventType === 'turn/diff/updated' ? (
        <p>
          Provider aggregate diff updated ({Number(payload.byteCount ?? 0).toLocaleString()}{' '}
          bytes).
        </p>
      ) : eventType === 'thread/compacted' ? (
        <p>Codex reported automatic context compaction.</p>
      ) : (
        <p>{stringValue(payload.message) ?? eventType}</p>
      )}
      <footer>
        <RawProviderMessage reference={provenance} />
      </footer>
    </article>
  );
}

function PlanHistory({ plans }: { plans: AgentPlanRevisionRecord[] }) {
  const latest = plans.at(-1);
  if (!latest) {
    return null;
  }
  return (
    <div className="provider-item provider-item--plan">
      <header>
        <strong>Provider plan</strong>
        <span>
          Revision {latest.revision} of {plans.length}
        </span>
      </header>
      {latest.explanation ? <p>{latest.explanation}</p> : null}
      <ol className="provider-plan">
        {latest.steps.map((step, index) => (
          <li key={`${index}:${step.step}`} data-status={step.status}>
            <span aria-hidden="true" />
            <strong>{step.step}</strong>
            <small>{humanizeEnum(step.status)}</small>
          </li>
        ))}
      </ol>
      {plans.length > 1 ? (
        <details className="provider-revisions">
          <summary>{plans.length - 1} earlier revisions</summary>
          {plans.slice(0, -1).reverse().map((plan) => (
            <div key={plan.id}>
              <strong>Revision {plan.revision}</strong>
              <span>{plan.steps.map((step) => step.step).join(' → ')}</span>
            </div>
          ))}
        </details>
      ) : null}
      <RawProviderMessage reference={latest.rawMessage} />
    </div>
  );
}

function ProviderItem({ item }: { item: AgentItemRecord }) {
  const payload = asObject(item.payload);
  return (
    <article className={`provider-item provider-item--${item.type.toLowerCase()}`}>
      <header>
        <strong>{itemTitle(item.type, payload)}</strong>
        <span>
          {humanizeEnum(item.status)} · {humanizeEnum(item.type)}
        </span>
      </header>
      <ItemBody type={item.type} payload={payload} />
      <footer>
        <RawProviderMessage reference={item.rawMessage} />
      </footer>
    </article>
  );
}

function ItemBody({
  type,
  payload
}: {
  type: AgentItemRecord['type'];
  payload: Record<string, unknown>;
}) {
  if (type === 'USER_MESSAGE') {
    return <p className="provider-message">{extractUserText(payload) || 'User input'}</p>;
  }
  if (type === 'AGENT_MESSAGE') {
    return <p className="provider-message">{stringValue(payload.text) || 'No text'}</p>;
  }
  if (type === 'REASONING_SUMMARY') {
    const summaries = stringArray(payload.summary);
    return (
      <>
        <p className="provider-label-warning">
          Provider reasoning summary — not hidden chain-of-thought.
        </p>
        {summaries.length > 0 ? (
          summaries.map((summary, index) => <p key={index}>{summary}</p>)
        ) : (
          <p className="muted">No readable summary was included.</p>
        )}
      </>
    );
  }
  if (type === 'COMMAND_EXECUTION') {
    return (
      <dl className="provider-item-kv">
        <dt>Command</dt>
        <dd><code>{stringValue(payload.command) || 'unknown'}</code></dd>
        <dt>Working directory</dt>
        <dd>{stringValue(payload.cwd) || 'unknown'}</dd>
        <dt>Exit / duration</dt>
        <dd>
          {formatNullable(payload.exitCode)} / {formatDuration(payload.durationMs)}
        </dd>
        {Array.isArray(payload.commandActions) && payload.commandActions.length > 0 ? (
          <>
            <dt>Parsed actions</dt>
            <dd>
              <StructuredData value={payload.commandActions} />
            </dd>
          </>
        ) : null}
        {stringValue(payload.aggregatedOutput) ? (
          <>
            <dt>Output</dt>
            <dd>
              <details>
                <summary>Show provider-reported command output</summary>
                <pre>{stringValue(payload.aggregatedOutput)}</pre>
              </details>
            </dd>
          </>
        ) : null}
      </dl>
    );
  }
  if (type === 'FILE_CHANGE') {
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    return (
      <div className="provider-files">
        {changes.map((change, index) => {
          const value = asObject(change);
          return (
            <details key={`${stringValue(value.path)}:${index}`}>
              <summary>
                {stringValue(value.kind) || 'change'} · {stringValue(value.path) || 'unknown'}
              </summary>
              <pre>{stringValue(value.diff) || 'No provider diff.'}</pre>
            </details>
          );
        })}
      </div>
    );
  }
  if (type === 'MCP_TOOL_CALL' || type === 'DYNAMIC_TOOL_CALL') {
    return (
      <dl className="provider-item-kv">
        <dt>Tool</dt>
        <dd>
          {[stringValue(payload.server), stringValue(payload.namespace), stringValue(payload.tool)]
            .filter(Boolean)
            .join(' / ')}
        </dd>
        <dt>Arguments</dt>
        <dd>
          <StructuredData value={payload.arguments ?? {}} />
        </dd>
        {payload.result || payload.contentItems || payload.error ? (
          <>
            <dt>Result</dt>
            <dd>
              <StructuredData value={payload.result ?? payload.contentItems ?? payload.error} />
            </dd>
          </>
        ) : null}
      </dl>
    );
  }
  if (type === 'WEB_SEARCH') {
    return (
      <dl className="provider-item-kv">
        <dt>Query</dt>
        <dd>{stringValue(payload.query) || 'unknown'}</dd>
        {payload.action ? (
          <>
            <dt>Action</dt>
            <dd>
              <StructuredData value={payload.action} />
            </dd>
          </>
        ) : null}
      </dl>
    );
  }
  if (type === 'CONTEXT_COMPACTION') {
    return <p>Codex reported conversation context compaction.</p>;
  }
  if (type === 'REVIEW') {
    return <p className="provider-message">{stringValue(payload.review) || 'Review mode event'}</p>;
  }
  if (type === 'PLAN') {
    return <p className="provider-message">{stringValue(payload.text) || 'Plan item'}</p>;
  }
  if (type === 'SUBAGENT') {
    if (stringValue(payload.type) === 'collabAgentToolCall') {
      const receivers = stringArray(payload.receiverThreadIds);
      return (
        <dl className="provider-item-kv">
          <dt>Collaboration tool</dt>
          <dd>{humanizeEnum(stringValue(payload.tool) ?? 'unknown')}</dd>
          <dt>Sender thread</dt>
          <dd>{stringValue(payload.senderThreadId) ?? 'unknown'}</dd>
          <dt>Receiver threads</dt>
          <dd>{receivers.length > 0 ? receivers.join(', ') : 'none reported'}</dd>
          <dt>Delegated prompt</dt>
          <dd>{stringValue(payload.prompt) ?? 'not supplied'}</dd>
          <dt>Requested model / effort</dt>
          <dd>
            {stringValue(payload.model) ?? 'inherited or unknown'} /{' '}
            {stringValue(payload.reasoningEffort) ?? 'inherited or unknown'}
          </dd>
          <dt>Reported agent states</dt>
          <dd>
            <StructuredData value={payload.agentsStates ?? {}} />
          </dd>
        </dl>
      );
    }
    return (
      <dl className="provider-item-kv">
        <dt>Activity</dt>
        <dd>{humanizeEnum(stringValue(payload.kind) ?? 'unknown')}</dd>
        <dt>Child thread</dt>
        <dd>{stringValue(payload.agentThreadId) ?? 'unknown'}</dd>
        <dt>Agent path</dt>
        <dd>{stringValue(payload.agentPath) ?? 'not reported'}</dd>
      </dl>
    );
  }
  return <p className="muted">Provider item type: {stringValue(payload.type) || type}</p>;
}

function itemTitle(
  type: AgentItemRecord['type'],
  payload: Record<string, unknown>
): string {
  if (type === 'COMMAND_EXECUTION') {
    return stringValue(payload.command) || 'Command';
  }
  if (type === 'MCP_TOOL_CALL' || type === 'DYNAMIC_TOOL_CALL') {
    return stringValue(payload.tool) || 'Tool call';
  }
  if (type === 'WEB_SEARCH') {
    return 'Web search';
  }
  if (type === 'REASONING_SUMMARY') {
    return 'Provider reasoning summary';
  }
  if (type === 'REVIEW') {
    return stringValue(payload.type) === 'enteredReviewMode'
      ? 'Review started'
      : 'Review completed';
  }
  if (type === 'SUBAGENT') {
    return stringValue(payload.tool)
      ? `Subagent ${humanizeEnum(stringValue(payload.tool) ?? '')}`
      : 'Subagent activity';
  }
  return humanizeEnum(type);
}

function buildRunForest(runs: RunRecord[]): ProviderRunNode[] {
  const nodes = new Map<string, ProviderRunNode>(
    runs.map((run) => [run.id, { run, children: [] }])
  );
  const roots: ProviderRunNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.run.parentRunId
      ? nodes.get(node.run.parentRunId)
      : undefined;
    if (parent && parent.run.id !== node.run.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const reachable = new Set<string>();
  const visit = (node: ProviderRunNode, lineage = new Set<string>()) => {
    if (lineage.has(node.run.id)) {
      return;
    }
    reachable.add(node.run.id);
    const nextLineage = new Set(lineage).add(node.run.id);
    node.children = node.children.filter((child) => !nextLineage.has(child.run.id));
    node.children.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
    node.children.forEach((child) => visit(child, nextLineage));
  };
  roots.forEach((root) => visit(root));
  for (const node of nodes.values()) {
    if (!reachable.has(node.run.id)) {
      roots.push(node);
      visit(node);
    }
  }
  return roots.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
}

function groupBy<T>(
  values: T[],
  key: (value: T) => string
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = grouped.get(groupKey);
    if (group) {
      group.push(value);
    } else {
      grouped.set(groupKey, [value]);
    }
  }
  return grouped;
}

function extractUserText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) {
    return '';
  }
  return payload.content
    .map((entry) => {
      const value = asObject(entry);
      return stringValue(value.text);
    })
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function formatNullable(value: unknown): string {
  return typeof value === 'number' ? String(value) : '—';
}

function formatDuration(value: unknown): string {
  return typeof value === 'number' ? `${value} ms` : '—';
}

function isRichProviderEvent(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'error',
      'warning',
      'model/rerouted',
      'turn/diff/updated',
      'thread/compacted'
    ].includes(value)
  );
}

function providerEventTitle(eventType: string): string {
  switch (eventType) {
    case 'error':
      return 'Provider error';
    case 'warning':
      return 'Provider warning';
    case 'model/rerouted':
      return 'Model rerouted';
    case 'turn/diff/updated':
      return 'Provider aggregate diff';
    case 'thread/compacted':
      return 'Context compacted';
    default:
      return eventType;
  }
}

function asProtocolReference(
  value: unknown
): AgentProtocolMessageReference | undefined {
  const record = asObject(value);
  return typeof record.serverInstanceId === 'string' &&
    typeof record.sequence === 'number' &&
    record.direction === 'INBOUND' &&
    typeof record.recordedAt === 'string' &&
    typeof record.byteOffset === 'number' &&
    typeof record.byteLength === 'number' &&
    typeof record.sha256 === 'string'
    ? {
        serverInstanceId: record.serverInstanceId,
        sequence: record.sequence,
        direction: 'INBOUND',
        recordedAt: record.recordedAt,
        byteOffset: record.byteOffset,
        byteLength: record.byteLength,
        sha256: record.sha256
      }
    : undefined;
}
