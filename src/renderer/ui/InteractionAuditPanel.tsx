import type {
  AgentSessionRecord,
  InteractionRequestRecord
} from '../../shared/contracts';
import { RawProviderMessage } from './RawProviderMessage';
import { StructuredData, humanizeEnum } from './display';

export function InteractionAuditPanel({
  interactions,
  sessions
}: {
  interactions: InteractionRequestRecord[];
  sessions: AgentSessionRecord[];
}) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const historical = interactions
    .filter((interaction) => !['PENDING', 'RESPONDING'].includes(interaction.status))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  if (historical.length === 0) {
    return null;
  }

  return (
    <section className="card interaction-audit">
      <div className="card__header">
        <div>
          <h3>Interaction audit</h3>
          <p className="provider-subtitle">Past provider requests.</p>
        </div>
        <span className="count-pill">{historical.length}</span>
      </div>
      <div className="interaction-audit__list">
        {historical.map((interaction) => (
          <details key={interaction.id}>
            <summary>
              <span>
                <strong>{humanizeEnum(interaction.type)}</strong>
                <small>
                  {new Date(interaction.requestedAt).toLocaleString()} · request{' '}
                  {String(interaction.providerRequestId)}
                </small>
              </span>
              <span className="provider-status">
                {humanizeEnum(interaction.status)}
              </span>
            </summary>
            <div className="interaction-audit__body">
              <dl className="provider-item-kv">
                <dt>Run / turn</dt>
                <dd>
                  {interaction.runId.slice(0, 8)} /{' '}
                  {interaction.providerTurnId ?? '—'}
                </dd>
                <dt>Source thread</dt>
                <dd>
                  {formatSessionSource(
                    sessionById.get(interaction.sessionId),
                    interaction.sessionId
                  )}
                </dd>
                <dt>Decision</dt>
                <dd>
                  {interaction.decision
                    ? <StructuredData value={interaction.decision} />
                    : 'No response was sent'}
                </dd>
                <dt>Resolution</dt>
                <dd>
                  {interaction.resolution
                    ? <StructuredData value={interaction.resolution} />
                    : humanizeEnum(interaction.status)}
                </dd>
              </dl>
              <RawProviderMessage reference={interaction.requestRawMessage} />
              {interaction.responseRawMessage ? (
                <RawProviderMessage reference={interaction.responseRawMessage} />
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function formatSessionSource(
  session: AgentSessionRecord | undefined,
  fallbackId: string
): string {
  if (!session) {
    return `Unknown local session ${fallbackId.slice(0, 8)}`;
  }
  const label =
    session.providerNickname ??
    session.providerRole ??
    (session.role === 'SUBAGENT' ? 'Subagent' : 'Primary agent');
  return `${label} · ${session.providerSessionId ?? session.id}`;
}
