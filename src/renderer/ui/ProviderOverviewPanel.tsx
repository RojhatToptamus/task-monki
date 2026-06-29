import { useMemo, useState } from 'react';
import type {
  AgentGoalSnapshotRecord,
  AgentProviderState,
  AgentServerInstance,
  AgentSessionRecord,
  AgentSettingsObservationRecord,
  AgentUsageSnapshotRecord,
  RunRecord,
  Task
} from '../../shared/contracts';
import {
  PROVIDER_SETTING_FIELDS
} from '../model/providerSettings';
import { shouldShowProviderGoalDiagnostics } from '../model/debugDiagnostics';
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
  const showGoalDiagnostics = shouldShowProviderGoalDiagnostics(goal, Boolean(session));
  const hasProviderSignal = Boolean(
    run || session || usage || observations.length > 0 || showGoalDiagnostics
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
          </dd>
          <dt>Account</dt>
          <dd>
            <span>{providerState?.preflight.accountLabel ?? '—'}</span>
          </dd>
          <dt>Runtime</dt>
          <dd>
            <span>{providerState?.preflight.runtimeVersion ?? '—'}</span>
          </dd>
          <dt>Thread</dt>
          <dd>
            <span>{session?.providerSessionId ?? '—'}</span>
          </dd>
          <dt>Raw journal</dt>
          <dd>
            <span>{server?.protocolJournalPath ?? '—'}</span>
          </dd>
        </dl>
      </div>

      {showGoalDiagnostics ? (
        <div className="provider-section">
          <div className="provider-section__heading">
            <h4>Provider goal</h4>
            {session ? (
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
            <dt>Sync state</dt>
            <dd>
              <span>{goal ? humanizeEnum(goal.syncState) : '—'}</span>
              <small>{goal?.source ? humanizeEnum(goal.source) : '—'}</small>
            </dd>
            <dt>Expected goal</dt>
            <dd>
              <span>{task.prompt}</span>
              <small>Authoritative task goal</small>
            </dd>
            <dt>Provider goal</dt>
            <dd>
              <span>{goal?.providerObjective ?? '—'}</span>
              <small>
                {goal?.providerObjective === task.prompt
                  ? 'Matches the Task Monki goal'
                  : 'Differs from the Task Monki goal'}
              </small>
            </dd>
            <dt>Provider status</dt>
            <dd>
              <span>{goal?.providerStatus ?? '—'}</span>
            </dd>
          </dl>
          {goal?.detail ? <p className="provider-warning">{goal.detail}</p> : null}
          {goal ? <RawProviderMessage reference={goal.rawMessage} /> : null}
        </div>
      ) : null}

      <div className="provider-section">
        <h4>Current settings</h4>
        <div className="settings-table">
          {PROVIDER_SETTING_FIELDS.map(({ key, label }) => {
            const observation = observations.find(
              (candidate) => candidate.settings[key] !== undefined
            );
            const current =
              observation?.settings[key] ??
              run?.observedSettings?.[key] ??
              run?.requestedSettings[key];
            return (
              <div className="settings-table__row" key={key}>
                <strong>{label}</strong>
                <span>{formatSetting(current)}</span>
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
