import { useState, type ReactNode } from 'react';
import { Undo2 } from 'lucide-react';
import {
  remoteProviderName,
  type ReviewRequestItem,
  type ReviewRequestItemDecisionKind,
  type ReviewRequestRecord,
  type ReviewResponseAnswer,
  type ReviewResponseOutcome
} from '../../shared/contracts';
import { findingLevel } from '../model/findings';
import { REVIEW_OUTCOME_LABELS, requestItemLocation, requestItemText } from '../model/reviewRounds';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';
import { AgentMark } from './UiIcons';

/** A request sent from the Review tab, as it reads in the conversation: item by item, then the note. */
export function ReviewRequestCard({ request, time }: { request: ReviewRequestRecord; time: string }) {
  return (
    <Message from="user" label="Your review request">
      <MessageContent user className="tm-round">
        <p className="tm-round__lead">Requested changes</p>
        <ol className="tm-round__items">
          {request.items.map((item) => (
            <RoundItem key={item.number} item={item}
              lead={item.kind === 'FINDING'
                ? <span className="tm-review__severity" data-severity={item.severity}>{findingLevel(item.severity).label}</span>
                : <span className="tm-round__kind">{item.kind === 'DISCUSSION' ? item.author ?? remoteProviderName(item.provider) : 'Comment'}</span>} />
          ))}
        </ol>
        {request.note ? <p className="tm-round__note">{request.note}</p> : null}
      </MessageContent>
      <MessageMeta><MessageTime value={time} /></MessageMeta>
    </Message>
  );
}

/**
 * The agent's answer to each item of a request; an item it left out reads as
 * unanswered, and one whose answer the person accepted reads as accepted.
 */
export function ReviewAnswers({ request, answers, accepted, onShowItem }: {
  request: ReviewRequestRecord;
  answers: readonly ReviewResponseAnswer[];
  /** Items whose answer the person accepted. */
  accepted?: ReadonlySet<number>;
  /** Shows the item where it is in the diff, on the Review tab. */
  onShowItem?(item: ReviewRequestItem): void;
}) {
  const byItem = new Map(answers.map((answer) => [answer.item, answer]));
  return (
    <ol className="tm-round__items tm-round__answers" aria-label="Answers to the review request">
      {request.items.map((item) => {
        const answer = byItem.get(item.number);
        const settled = Boolean(answer && accepted?.has(item.number));
        return (
          <RoundItem key={item.number} item={item} outcome={settled ? 'ACCEPTED' : answer?.outcome ?? 'NONE'} onShow={onShowItem}
            lead={<span className="tm-round__outcome">{settled ? 'Accepted' : answer ? REVIEW_OUTCOME_LABELS[answer.outcome] : 'No answer'}</span>}>
            {answer?.note ? <span className="tm-round__answer">{answer.note}</span> : null}
          </RoundItem>
        );
      })}
    </ol>
  );
}

function RoundItem({ item, lead, outcome, onShow, children }: {
  item: ReviewRequestItem;
  lead: ReactNode;
  outcome?: string;
  onShow?(item: ReviewRequestItem): void;
  children?: ReactNode;
}) {
  const location = requestItemLocation(item);
  return (
    <li data-outcome={outcome}>
      <span className="tm-round__num">{item.number}</span>
      <span className="tm-round__body">
        <span className="tm-round__head">{lead}<span className="tm-round__text">{requestItemText(item)}</span></span>
        {location ? onShow && item.path
          ? <button type="button" className="tm-round__where tm-round__where--link" onClick={() => onShow(item)}>{location}</button>
          : <span className="tm-round__where">{location}</span> : null}
        {children}
      </span>
    </li>
  );
}

/** The agent's answer to an item of the person's request, as the item's band shows it. */
export interface ItemAnswer {
  outcome: ReviewResponseOutcome;
  note?: string;
  /** Who answered, and when its reply finished. */
  agent?: string;
  at?: string;
  /** The person accepted it, which settles the item. */
  accepted: boolean;
  /** Records the person's decision; absent when the answer takes none, such as one to an earlier request. */
  onDecide?(kind: ReviewRequestItemDecisionKind): Promise<void>;
  /** Puts the item in the person's request again, in their own words. */
  onRequestAgain?(): void;
}

/** An item's state on its band's head: the agent's answer under its mark, or Accepted once the person settled it. */
export function AnswerState({ answer }: { answer: Pick<ItemAnswer, 'outcome' | 'accepted'> }) {
  return answer.accepted
    ? <span className="tm-review-thread__round">Accepted</span>
    : <span className="tm-review-thread__round tm-review-answer__state"><AgentMark />{REVIEW_OUTCOME_LABELS[answer.outcome]}</span>;
}

/** The agent's own words on an answer, quoted under its name and the time it answered. */
export function AnswerQuote({ agent, at, note }: Pick<ItemAnswer, 'agent' | 'at'> & { note: string }) {
  return (
    <figure className="tm-review-answer__quote">
      {agent || at ? (
        <figcaption className="tm-review-answer__by">
          {agent ? <span className="tm-review-answer__agent">{agent}</span> : null}
          {at ? <MessageTime value={at} /> : null}
        </figcaption>
      ) : null}
      <blockquote>{note}</blockquote>
    </figure>
  );
}

/** The person's decision on an answer: pending on its own control until it lands; the shell reports a failure. */
function useAnswerDecision(answer: ItemAnswer) {
  const [pending, setPending] = useState(false);
  const decide = async (kind: ReviewRequestItemDecisionKind) => {
    if (!answer.onDecide || pending) return;
    setPending(true);
    try {
      await answer.onDecide(kind);
    } catch {
      // The choice stays for another try.
    } finally {
      setPending(false);
    }
  };
  return { pending, decide };
}

/**
 * Under the item on its band: the agent's note, quoted, then the person's
 * choices. The agent's word never settles an item, even Fixed: Accept answer
 * does, and Reopen at the row's end takes it back. Add to request sends the
 * item again.
 */
export function RequestItemAnswer({ answer }: { answer: ItemAnswer }) {
  const { pending, decide } = useAnswerDecision(answer);
  const choices = answer.accepted ? Boolean(answer.onDecide) : Boolean(answer.onDecide || answer.onRequestAgain);
  if (!answer.note && !choices) return null;
  return (
    <div className="tm-review-answer">
      {answer.note ? <AnswerQuote agent={answer.agent} at={answer.at} note={answer.note} /> : null}
      {choices ? (
        <div className="tm-review-answer__actions">
          {answer.accepted ? <ReopenAnswer answer={answer} /> : (
            <>
              {answer.onDecide ? (
                <button type="button" className="ghost-button button--sm" disabled={pending} onClick={() => void decide('ACCEPT')}>Accept answer</button>
              ) : null}
              {answer.onRequestAgain ? (
                <button type="button" className="ghost-button button--sm" onClick={answer.onRequestAgain}>Add to request</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A settled item's way back, at the end of its row, where Restore sits on a dismissed finding. */
export function ReopenAnswer({ answer }: { answer: ItemAnswer }) {
  const { pending, decide } = useAnswerDecision(answer);
  if (!answer.onDecide) return null;
  return (
    <button type="button" className="ghost-button tm-review-thread__undo" disabled={pending} onClick={() => void decide('REOPEN')}>
      <Undo2 size={13} aria-hidden="true" />Reopen
    </button>
  );
}
