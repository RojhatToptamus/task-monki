import type { AgentUserInputRequest, InteractionRequestRecord } from '../../shared/contracts';

/** The interaction owns this answer; provider tool output is not a second conversation entry. */
export function UserInputSummary({ interaction }: { interaction: InteractionRequestRecord }) {
  if (interaction.type !== 'USER_INPUT') return null;
  const answers = interaction.decision?.interactionType === 'USER_INPUT' ? interaction.decision.answers : undefined;
  const status = interaction.status === 'RESOLVED' ? undefined
    : interaction.status === 'RESPONDING' ? 'Confirmation pending'
    : answers ? 'Delivery unconfirmed' : 'Not answered';
  return <div className="interaction-answer" aria-label="Your answers">
    <dl>
      {(interaction.request as AgentUserInputRequest).questions.map((question) => <div key={question.id}>
        <dt>{question.question}</dt>
        <dd>{answers?.[question.id]?.join('; ') || 'Not answered'}</dd>
      </div>)}
    </dl>
    {status ? <p className="interaction-answer__status" role="status">{status}</p> : null}
  </div>;
}
