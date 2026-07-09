import { useMemo } from 'react';
import type {
  AgentItemRecord,
  AgentSessionRecord,
  AgentSubagentObservationRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { buildRunActivityProjection } from '../model/runActivity';
import { RawProviderMessage } from './RawProviderMessage';
import { humanizeEnum } from './display';

interface SubagentHierarchyPanelProps {
  sessions: AgentSessionRecord[];
  runs: RunRecord[];
  items: AgentItemRecord[];
  interactions: InteractionRequestRecord[];
  observations: AgentSubagentObservationRecord[];
}

interface SubagentNodeData {
  session: AgentSessionRecord;
  children: SubagentNodeData[];
}

export function SubagentHierarchyPanel({
  sessions,
  runs,
  items,
  interactions,
  observations
}: SubagentHierarchyPanelProps) {
  const subagents = useMemo(
    () => sessions.filter((session) => session.role === 'SUBAGENT'),
    [sessions]
  );
  const forest = useMemo(() => buildSessionForest(subagents), [subagents]);
  const runsBySession = useMemo(
    () => groupBy(runs, (run) => run.sessionId),
    [runs]
  );
  const itemsByRun = useMemo(
    () => groupBy(items, (item) => item.runId),
    [items]
  );
  const interactionsBySession = useMemo(
    () => groupBy(interactions, (interaction) => interaction.sessionId),
    [interactions]
  );
  const observationsBySession = useMemo(
    () => groupBy(observations, (observation) => observation.sessionId),
    [observations]
  );

  if (subagents.length === 0) {
    return null;
  }

  const unresolvedCount = subagents.filter(
    (session) =>
      session.relationshipState === 'UNRESOLVED' ||
      session.relationshipState === 'CONTRADICTORY'
  ).length;

  return (
    <section className="card subagent-hierarchy">
      <div className="card__header">
        <div>
          <h3>Subagent hierarchy</h3>
          <p className="provider-subtitle">Observed child threads.</p>
        </div>
        <span className="count-pill">
          {subagents.length} {subagents.length === 1 ? 'child' : 'children'}
        </span>
      </div>
      {unresolvedCount > 0 ? (
        <p className="subagent-hierarchy__warning">
          {unresolvedCount} relationship{unresolvedCount === 1 ? '' : 's'} need
          review because provider identifiers were missing or contradictory.
        </p>
      ) : null}
      <div className="subagent-tree">
        {forest.map((node) => (
          <SubagentNode
            key={node.session.id}
            node={node}
            depth={0}
            runsBySession={runsBySession}
            itemsByRun={itemsByRun}
            interactionsBySession={interactionsBySession}
            observationsBySession={observationsBySession}
          />
        ))}
      </div>
    </section>
  );
}

function SubagentNode({
  node,
  depth,
  runsBySession,
  itemsByRun,
  interactionsBySession,
  observationsBySession
}: {
  node: SubagentNodeData;
  depth: number;
  runsBySession: Map<string, RunRecord[]>;
  itemsByRun: Map<string, AgentItemRecord[]>;
  interactionsBySession: Map<string, InteractionRequestRecord[]>;
  observationsBySession: Map<string, AgentSubagentObservationRecord[]>;
}) {
  const sessionRuns = [...(runsBySession.get(node.session.id) ?? [])].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  );
  const sessionInteractions = interactionsBySession.get(node.session.id) ?? [];
  const latestObservation = [...(observationsBySession.get(node.session.id) ?? [])].sort(
    (a, b) => b.observedAt.localeCompare(a.observedAt)
  )[0];
  const status = node.session.subagentStatus ?? node.session.status;
  const displayName =
    node.session.providerNickname ??
    node.session.providerRole ??
    `Child ${shortId(node.session.providerSessionId ?? node.session.id)}`;

  return (
    <article
      className={`subagent-node subagent-node--${node.session.relationshipState.toLowerCase()}`}
    >
      <details open={status === 'RUNNING' || status === 'PENDING_INIT'}>
        <summary>
          <span>
            <strong>{displayName}</strong>
            <small>
              {node.session.providerRole ?? '—'} ·{' '}
              {node.session.providerSessionId ?? '—'}
            </small>
          </span>
          <span className="subagent-node__badges">
            <span className={`relationship-badge relationship-badge--${node.session.relationshipState.toLowerCase()}`}>
              {humanizeEnum(node.session.relationshipState)}
            </span>
            <span className="provider-status">{humanizeEnum(status)}</span>
          </span>
        </summary>
        <div className="subagent-node__body">
          {node.session.relationshipDetail ? (
            <p className="subagent-node__problem">{node.session.relationshipDetail}</p>
          ) : null}
          <dl className="provider-item-kv">
            <dt>Delegated prompt</dt>
            <dd>{node.session.delegatedPrompt ?? '—'}</dd>
            <dt>Requested model / effort</dt>
            <dd>
              {node.session.requestedSettings.model ?? '—'} /{' '}
              {node.session.requestedSettings.reasoningEffort ?? '—'}
            </dd>
            <dt>Parent thread</dt>
            <dd>
              {node.session.providerParentSessionId ??
                node.session.parentSessionId ??
                '—'}
            </dd>
            <dt>Agent path</dt>
            <dd>{node.session.agentPath ?? '—'}</dd>
          </dl>
          <div className="subagent-node__activity">
            {sessionRuns.length === 0 ? (
              <p className="muted">No child turn activity has been correlated yet.</p>
            ) : (
              sessionRuns.map((run) => (
                <SubagentRunSummary
                  key={run.id}
                  run={run}
                  items={itemsByRun.get(run.id) ?? []}
                  interactions={sessionInteractions.filter(
                    (interaction) => interaction.runId === run.id
                  )}
                />
              ))
            )}
          </div>
          {latestObservation ? (
            <footer className="subagent-node__provenance">
              <span className="provenance-badge">
                Latest source: {humanizeEnum(latestObservation.source)}
              </span>
              <RawProviderMessage reference={latestObservation.rawMessage} />
            </footer>
          ) : null}
        </div>
      </details>
      {node.children.length > 0 ? (
        <div className="subagent-node__children">
          {node.children.map((child) => (
            <SubagentNode
              key={child.session.id}
              node={child}
              depth={depth + 1}
              runsBySession={runsBySession}
              itemsByRun={itemsByRun}
              interactionsBySession={interactionsBySession}
              observationsBySession={observationsBySession}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function SubagentRunSummary({
  run,
  items,
  interactions
}: {
  run: RunRecord;
  items: AgentItemRecord[];
  interactions: InteractionRequestRecord[];
}) {
  const activityRows = buildRunActivityProjection({
    run,
    items,
    interactions
  }).rows.slice(-5);
  return (
    <details className="subagent-run">
      <summary>
        <span>
          {run.providerTurnId ?? shortId(run.id)} · {humanizeEnum(run.status)}
        </span>
        <small>
          {items.length} items · {interactions.length} requests
        </small>
      </summary>
      <div>
        {activityRows.length > 0 ? (
          activityRows.map((row) => (
            <p key={row.key}>
              <strong>{row.label}:</strong>{' '}
              {[row.detail, row.metric].filter(Boolean).join(' · ') || row.status}
            </p>
          ))
        ) : (
          <p className="muted">No curated activity rows for this turn.</p>
        )}
      </div>
    </details>
  );
}

function buildSessionForest(sessions: AgentSessionRecord[]): SubagentNodeData[] {
  const nodes = new Map<string, SubagentNodeData>(
    sessions.map((session) => [session.id, { session, children: [] }])
  );
  const roots: SubagentNodeData[] = [];
  for (const node of nodes.values()) {
    const parent = node.session.parentSessionId
      ? nodes.get(node.session.parentSessionId)
      : undefined;
    if (parent && parent.session.id !== node.session.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const reachable = new Set<string>();
  const visit = (node: SubagentNodeData, lineage = new Set<string>()) => {
    if (lineage.has(node.session.id)) {
      return;
    }
    reachable.add(node.session.id);
    const nextLineage = new Set(lineage).add(node.session.id);
    node.children = node.children.filter(
      (child) => !nextLineage.has(child.session.id)
    );
    node.children.sort((a, b) => a.session.createdAt.localeCompare(b.session.createdAt));
    node.children.forEach((child) => visit(child, nextLineage));
  };
  roots.forEach((root) => visit(root));
  for (const node of nodes.values()) {
    if (!reachable.has(node.session.id)) {
      roots.push(node);
      visit(node);
    }
  }
  return roots.sort((a, b) => a.session.createdAt.localeCompare(b.session.createdAt));
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

function shortId(value: string): string {
  return value.slice(0, 8);
}
