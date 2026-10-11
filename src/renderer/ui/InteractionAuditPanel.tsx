import type { ReactNode } from 'react';
import type {
  AgentSessionRecord,
  InteractionRequestRecord
} from '../../shared/contracts';
import { RawProviderMessage } from './RawProviderMessage';
import { DisclosureChevron } from './DisclosureChevron';
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
              <span className="tm-disclosure__label">
                <DisclosureChevron />
                <span className="interaction-audit__summary-copy">
                  <strong>{humanizeEnum(interaction.type)}</strong>
                  <small className="provider-meta">
                    <span>{new Date(interaction.requestedAt).toLocaleString()}</span>
                    <span>
                      request{' '}
                      <span className="provider-meta__id">{String(interaction.providerRequestId)}</span>
                    </span>
                  </small>
                </span>
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
                    : <span className="provider-kv__text">No response was sent</span>}
                </dd>
                <dt>Resolution</dt>
                <dd>
                  {interaction.resolution
                    ? <StructuredData value={interaction.resolution} />
                    : <span className="provider-kv__text">{humanizeEnum(interaction.status)}</span>}
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

/** Who sent the request, in words, then the id to copy. */
function formatSessionSource(
  session: AgentSessionRecord | undefined,
  fallbackId: string
): ReactNode {
  const label = session
    ? session.providerNickname ??
      session.providerRole ??
      (session.role === 'SUBAGENT' ? 'Subagent' : 'Primary agent')
    : 'Unknown local session';
  const id = session ? session.providerSessionId ?? session.id : fallbackId.slice(0, 8);
  return (
    <span className="provider-meta">
      <span className="provider-kv__text">{label}</span>
      <span>{id}</span>
    </span>
  );
}
