import type { DiscourseMessageRecord, DiscourseTeamComparison, DiscourseTeamResponse } from '../../shared/discourse';
import { messageAuthorLabel } from '../model/discourse';
import { MessageMarkdown } from './MessageMarkdown';
import { DisclosureChevron } from './DisclosureChevron';

/** Read-only presentation of comparisons and responses already in user history. */
export function DiscourseHistoryContent({ result, sources, comparison, onNavigate }: {
  result: DiscourseTeamComparison | DiscourseTeamResponse;
  sources: readonly DiscourseMessageRecord[];
  comparison?: DiscourseTeamComparison;
  onNavigate(messageId: string): void;
}) {
  if (result.kind === 'RESPONSE') return <div className="tm-discourse-team">
    {result.responses.map((response) => <section key={response.pointId}>
      <h3>{comparison?.points.find((point) => point.id === response.pointId)?.question ?? responseLabel(response.stance)}</h3>
      <MessageMarkdown text={response.answer} />
      <details><summary>Reason and sources</summary>
        <MessageMarkdown text={response.reason} />
        {response.evidence.length ? <ul>{response.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul> : null}
      </details>
    </section>)}
    {result.newIssues.length ? <section><h3>New issues and corrections</h3>
      <ul>{result.newIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </section> : null}
  </div>;
  return <div className="tm-discourse-team">
    <MessageMarkdown text={result.summary} />
    <details className="tm-discourse-team__details"><summary>Comparison details</summary>
    <div className="tm-discourse-response__concerns">
      {result.points.map((point) => <details key={point.id}>
        <summary><DisclosureChevron className="tm-discourse-response__chevron" />
          {point.question}<small>{pointLabel(point.status)}</small>
        </summary>
        <MessageMarkdown text={point.explanation} />
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
    </div><MessageMarkdown text={result.reason} /></details>
    {result.actions.length ? <details><summary>Next questions</summary>
      <ul>{result.actions.map((action) => <li key={`${action.pointId}:${action.participantId}`}>{action.task}</li>)}</ul>
    </details> : null}
  </div>;
}

function pointLabel(value: DiscourseTeamComparison['points'][number]['status']): string {
  return { AGREED: 'Shared conclusion', CORRECTED: 'Corrected', DISAGREED: 'Different views',
    NEEDS_USER: 'Your decision', NEEDS_EVIDENCE: 'Missing evidence', OPEN: 'Unresolved' }[value];
}

function responseLabel(value: DiscourseTeamResponse['responses'][number]['stance']): string {
  return { AGREE: 'Agreement', REVISE: 'Revised answer', DEFEND: 'Response', CLARIFY: 'Clarification',
    UNCERTAIN: 'Uncertain', ABSTAIN: 'Unable to assess', WITHDRAW: 'Withdrawn' }[value];
}

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');
}
