import { useMemo, useState } from 'react';
import type {
  AgentExecutionSettings,
  AgentGoalSnapshotRecord,
  AgentProviderState,
  AgentServerInstance,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentUsageSnapshotRecord,
  RunRecord,
  Task
} from '../../shared/contracts';
import { RawProviderMessage } from './RawProviderMessage';
import { humanizeEnum } from './display';

interface ProviderOverviewPanelProps {
  task: Task;
  run?: RunRecord;
  session?: AgentSessionRecord;
  goalSnapshots: AgentGoalSnapshotRecord[];
  usageSnapshots: AgentUsageSnapshotRecord[];
  settingsObservations: AgentSettingsObservationRecord[];
  providerState?: AgentProviderState;
  server?: AgentServerInstance;
  onSyncGoal(taskId: string, sessionId: string): Promise<void>;
}

const SETTING_FIELDS: Array<{
  key: keyof AgentExecutionSettings;
  label: string;
}> = [
  { key: 'model', label: 'Model' },
  { key: 'modelProvider', label: 'Model provider' },
  { key: 'reasoningEffort', label: 'Reasoning effort' },
  { key: 'serviceTier', label: 'Service tier' },
  { key: 'sandbox', label: 'Sandbox' },
  { key: 'networkAccess', label: 'Network' },
  { key: 'approvalPolicy', label: 'Approval policy' }
];

export function ProviderOverviewPanel({
  task,
  run,
  session,
  goalSnapshots,
  usageSnapshots,
  settingsObservations,
  providerState,
  server,
  onSyncGoal
}: ProviderOverviewPanelProps) {
  const [syncing, setSyncing] = useState(false);
  const goal = latestForSession(goalSnapshots, session?.id);
  const usage = latestForSession(usageSnapshots, session?.id);
  const observations = useMemo(
    () =>
      settingsObservations
        .filter((record) => record.sessionId === session?.id)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    [session?.id, settingsObservations]
  );
  const hasProviderSignal = Boolean(
    run || session || goal || usage || observations.length > 0
  );

  const sync = async () => {
    if (!session) {
      return;
    }
    setSyncing(true);
    try {
      await onSyncGoal(task.id, session.id);
    } finally {
      setSyncing(false);
    }
  };

  if (!hasProviderSignal) {
    return null;
  }

  return (
    <section className="card provider-overview">
      <div className="card__header">
        <div>
          <h3>Reported by Codex</h3>
          <p className="provider-subtitle">
            Provider-derived state; it does not replace local evidence.
          </p>
        </div>
        <span className="provenance-badge">Provider: Codex</span>
      </div>

      <div className="provider-section">
        <h4>Runtime</h4>
        <dl className="provider-kv">
          <dt>App Server</dt>
          <dd>
            <span>
              {humanizeEnum(
                server?.status ?? (providerState?.preflight.ready ? 'READY' : 'NOT_READY')
              )}
            </span>
            <small>Observed by Task Monki process supervision</small>
          </dd>
          <dt>Account</dt>
          <dd>
            <span>{providerState?.preflight.accountLabel ?? 'Not observed'}</span>
            <small>Reported by Codex account/read</small>
          </dd>
          <dt>Runtime</dt>
          <dd>
            <span>{providerState?.preflight.runtimeVersion ?? 'unknown'}</span>
            <small>Reported by installed Codex CLI</small>
          </dd>
          <dt>Thread</dt>
          <dd>
            <span>{session?.providerSessionId ?? 'Not materialized'}</span>
            <small>Opaque provider identifier</small>
          </dd>
          <dt>Raw journal</dt>
          <dd>
            <span>{server?.protocolJournalPath ?? 'Not created'}</span>
            <small>Task Monki append-only local audit journal</small>
          </dd>
        </dl>
      </div>

      <div className="provider-section">
        <div className="provider-section__heading">
          <h4>Goal mirror</h4>
          {session && (!goal || goal.syncState !== 'IN_SYNC') ? (
            <button
              type="button"
              className="outline-button provider-small-button"
              disabled={syncing || !session.materialized}
              onClick={() => void sync()}
            >
              {syncing ? 'Syncing…' : 'Resync provider goal'}
            </button>
          ) : null}
        </div>
        <dl className="provider-kv">
          <dt>Task Monki goal</dt>
          <dd>
            <span>{task.prompt}</span>
            <small>Authoritative · Task Monki</small>
          </dd>
          <dt>Provider goal</dt>
          <dd>
            <span>{goal?.providerObjective ?? 'Not observed'}</span>
            <small>
              {goal
                ? `${humanizeEnum(goal.syncState)} · ${goal.source}`
                : 'No provider observation'}
            </small>
          </dd>
          <dt>Provider status</dt>
          <dd>
            <span>{goal?.providerStatus ?? 'unknown'}</span>
            <small>Reported by Codex; not a paused model turn</small>
          </dd>
        </dl>
        {goal?.detail ? <p className="provider-warning">{goal.detail}</p> : null}
        {goal ? <RawProviderMessage reference={goal.rawMessage} /> : null}
      </div>

      <div className="provider-section">
        <h4>Requested versus observed settings</h4>
        <div className="settings-table">
          <div className="settings-table__header">
            <span>Setting</span>
            <span>Requested</span>
            <span>Observed</span>
          </div>
          {SETTING_FIELDS.map(({ key, label }) => {
            const observation = observations.find(
              (candidate) => candidate.settings[key] !== undefined
            );
            return (
              <div className="settings-table__row" key={key}>
                <strong>{label}</strong>
                <span>
                  {formatSetting(run?.requestedSettings[key])}
                  <small>Requested by Task Monki</small>
                </span>
                <span>
                  {formatSetting(observation?.settings[key])}
                  <small>
                    {observation
                      ? `Observed · ${humanizeEnum(observation.source)}`
                      : 'Not independently observed'}
                  </small>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="provider-section">
        <h4>Token usage</h4>
        {usage ? (
          <>
            <div className="usage-grid">
              <UsageMetric label="Total" value={usage.total.totalTokens} />
              <UsageMetric label="Input" value={usage.total.inputTokens} />
              <UsageMetric label="Cached input" value={usage.total.cachedInputTokens} />
              <UsageMetric label="Output" value={usage.total.outputTokens} />
              <UsageMetric
                label="Reasoning output"
                value={usage.total.reasoningOutputTokens}
              />
              <UsageMetric
                label="Context window"
                value={usage.modelContextWindow}
              />
            </div>
            <RawProviderMessage reference={usage.rawMessage} />
          </>
        ) : (
          <p className="muted">No provider usage notification observed.</p>
        )}
      </div>
    </section>
  );
}

function UsageMetric({ label, value }: { label: string; value?: number }) {
  return (
    <span className="usage-metric">
      <strong>{value === undefined ? '—' : value.toLocaleString()}</strong>
      <small>{label}</small>
    </span>
  );
}

function latestForSession<T extends { sessionId: string; observedAt: string }>(
  records: T[],
  sessionId?: string
): T | undefined {
  return records
    .filter((record) => record.sessionId === sessionId)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
}

function formatSetting(value: unknown): string {
  if (value === undefined) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled';
  }
  return String(value);
}
