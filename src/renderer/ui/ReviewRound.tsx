import type { ReactNode } from 'react';
import type { ReviewRequestItem, ReviewRequestRecord, ReviewResponseAnswer } from '../../shared/contracts';
import { findingLevel } from '../model/findings';
import { REVIEW_OUTCOME_LABELS, requestItemLocation, requestItemText } from '../model/reviewRounds';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';

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
                : <span className="tm-round__kind">Comment</span>} />
          ))}
        </ol>
        {request.note ? <p className="tm-round__note">{request.note}</p> : null}
      </MessageContent>
      <MessageMeta><MessageTime value={time} /></MessageMeta>
    </Message>
  );
}

/** The agent's answer to each item of a request; an item it left out reads as unanswered. */
export function ReviewAnswers({ request, answers, onShowItem }: {
  request: ReviewRequestRecord;
  answers: readonly ReviewResponseAnswer[];
  /** Shows the item where it is in the diff, on the Review tab. */
  onShowItem?(item: ReviewRequestItem): void;
}) {
  const byItem = new Map(answers.map((answer) => [answer.item, answer]));
  return (
    <ol className="tm-round__items tm-round__answers" aria-label="Answers to the review request">
      {request.items.map((item) => {
        const answer = byItem.get(item.number);
        return (
          <RoundItem key={item.number} item={item} outcome={answer?.outcome ?? 'NONE'} onShow={onShowItem}
            lead={<span className="tm-round__outcome">{answer ? REVIEW_OUTCOME_LABELS[answer.outcome] : 'No answer'}</span>}>
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
