import type { DiscourseMessageRecord, DiscourseTeamComparison, DiscourseTeamResponse } from '../../shared/discourse';
import { messageAuthorLabel } from '../model/discourse';
import { DiscourseMarkdown } from './DiscourseMarkdown';
import { DisclosureChevron } from './DisclosureChevron';

/** A comparison is an attributed reading of source messages, not a verdict. */
export function DiscourseTeamContent({ result, sources, onNavigate }: {
  result: DiscourseTeamComparison | DiscourseTeamResponse;
  sources: readonly DiscourseMessageRecord[];
  onNavigate(messageId: string): void;
}) {
  if (result.kind === 'RESPONSE') return <div className="tm-discourse-team">
    {result.responses.map((response) => <section key={response.pointId}>
      <DiscourseMarkdown text={`### ${response.pointId} · ${label(response.stance)}`} />
      <DiscourseMarkdown text={response.answer} />
      <DiscourseMarkdown text={response.reason} />
      {response.evidence.length ? <details><summary>Evidence cited</summary>
        <ul>{response.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>
      </details> : null}
    </section>)}
    {result.newIssues.length ? <section><h3>New issues and corrections</h3>
      <ul>{result.newIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </section> : null}
  </div>;
  return <div className="tm-discourse-team">
    <DiscourseMarkdown text={result.summary} />
    <div className="tm-discourse-response__concerns">
      {result.points.map((point) => <details key={point.id} open={point.status === 'OPEN' || point.status === 'DISAGREED' || point.status.startsWith('NEEDS_')}>
        <summary><DisclosureChevron className="tm-discourse-response__chevron" />
          <span>{point.id}</span>{point.question}<small>{label(point.status)}</small>
        </summary>
        <DiscourseMarkdown text={point.explanation} />
        <div className="tm-discourse-message__context" aria-label={`Sources for ${point.id}`}>
          {point.sourceMessageIds.map((id) => {
            const source = sources.find((message) => message.id === id);
            return <button type="button" className="tm-discourse-message-action" key={id} onClick={() => onNavigate(id)}>
              {source ? `${messageAuthorLabel(source)} · ${source.ordinal}` : 'View source'}
            </button>;
          })}
        </div>
        {point.evidence.length ? <p><strong>Evidence cited by C</strong>{point.evidence.join('; ')}</p> : null}
        <small>{label(point.confidence)} confidence · C’s assessment</small>
      </details>)}
    </div>
    <DiscourseMarkdown text={result.reason} />
    {result.actions.length ? <details><summary>Next questions</summary>
      <ul>{result.actions.map((action) => <li key={`${action.pointId}:${action.participantId}`}>{action.pointId}: {action.task} {action.expectedBenefit}</li>)}</ul>
    </details> : null}
  </div>;
}

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');
}
