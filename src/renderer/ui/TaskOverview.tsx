import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AgentCommandApprovalRequest,
  AgentInteractionDecision,
  AgentUserInputRequest,
  InteractionRequestRecord
} from '../../shared/contracts';
import { MoreHorizontal } from 'lucide-react';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import { displayApprovalCommand, isWithinWorktree } from '../model/approvalCommand';
import { inboxInteractionDecisions } from '../model/inboxDecisions';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { ActionMenu } from './ActionMenu';

/**
 * The Overview's one raised element: what the task needs now. Every owner —
 * an agent request, the checkout, recovery, running work, PR Status, finishing,
 * setup, or how a closed task ended — renders inside it, so the next step is
 * always in the same place (overviewDecision.ts orders them). Everything else
 * on the Overview is a flat section.
 */
export function DecisionSlot({ children }: { children: ReactNode }) {
  return (
    <section className="tm-slot" aria-label="Current step">
      {children}
    </section>
  );
}

export interface SlotAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
  /** Why the action is unavailable, shown beside it and tied with aria-describedby. */
  reason?: string;
}

/** Headline, explanation and actions for an owner that has no surface of its own. */
export function SlotContent({
  headline,
  detail,
  meta,
  reported,
  primary,
  secondary = [],
  children
}: {
  headline: string;
  detail?: ReactNode;
  /** A quiet trailing fact, such as when the step happened. */
  meta?: string;
  /**
   * Provider text, attributed so it never reads as Task Monki's verdict. Without
   * a source, the headline already names the agent and the text is its quotation.
   */
  reported?: { source?: string; text: string };
  primary?: SlotAction;
  secondary?: SlotAction[];
  children?: ReactNode;
}) {
  return (
    <>
      <h3 className="tm-slot__headline">{headline}</h3>
      {detail ? <p className="tm-slot__detail">{detail}</p> : null}
      {meta ? <p className="tm-slot__meta">{meta}</p> : null}
      {reported?.source ? (
        <figure className="tm-oresult__report">
          <figcaption>{reported.source}</figcaption>
          <blockquote>{reported.text}</blockquote>
        </figure>
      ) : reported ? (
        <blockquote className="tm-slot__quote">{reported.text}</blockquote>
      ) : null}
      {children}
      <SlotActions primary={primary} secondary={secondary} />
    </>
  );
}

export function SlotActions({
  primary,
  secondary = [],
  quiet = false
}: {
  primary?: SlotAction;
  secondary?: SlotAction[];
  /** Outside the decision slot nothing competes with its primary. */
  quiet?: boolean;
}) {
  const reasonPrefix = useId();
  if (!primary && secondary.length === 0) {
    return null;
  }
  const all = [
    ...(primary ? [{ action: primary, primary: true }] : []),
    ...secondary.map((action) => ({ action, primary: false }))
  ];
  // Three actions fit beside each other; past that, the first two stay and the
  // rest, which are overrides, wait under More with their reasons inline.
  const actions = all.length > 3 ? all.slice(0, 2) : all;
  const overflow = all.length > 3 ? all.slice(2).map(({ action }) => action) : [];
  // One sentence per distinct reason: two actions paused for the same cause
  // share it instead of repeating it under each button.
  const reasons = [
    ...new Set(actions.flatMap(({ action }) => (action.disabled && action.reason ? [action.reason] : [])))
  ];
  const reasonId = (reason: string | undefined) =>
    reason && reasons.includes(reason) ? `${reasonPrefix}-${reasons.indexOf(reason)}` : undefined;
  return (
    <div className="tm-slot__footer">
      <div className="tm-slot__actions">
        {actions.map(({ action, primary: isPrimary }) => (
          <button
            key={action.label}
            type="button"
            className={isPrimary && !quiet ? 'primary-button' : 'outline-button'}
            disabled={action.disabled}
            aria-describedby={action.disabled ? reasonId(action.reason) : undefined}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
        {overflow.length > 0 ? (
          <ActionMenu
            className="tm-slot-more"
            label="More actions"
            side="bottom"
            align="start"
            trigger={<MoreHorizontal size={16} aria-hidden="true" />}
            items={overflow.map((action) => ({
              label: action.label,
              disabled: action.disabled,
              disabledReason: action.reason,
              onSelect: action.onClick
            }))}
          />
        ) : null}
      </div>
      {reasons.map((reason) => (
        <p key={reason} id={reasonId(reason)} className="tm-slot__reason">
          {reason}
        </p>
      ))}
    </div>
  );
}

/**
 * A pending agent request. A plain command is answerable here exactly as in the
 * Inbox (the same decision model, the same order as the Agent tab); anything
 * else is answered in the conversation, where the full request is shown.
 */
export function InteractionDecision({
  interaction,
  worktreePath,
  agentName = 'The agent',
  onRespond,
  onOpenConversation
}: {
  interaction: InteractionRequestRecord;
  worktreePath?: string;
  /** The runtime's name, so the request reads as the agent's own. */
  agentName?: string;
  onRespond(interaction: InteractionRequestRecord, decision: AgentInteractionDecision): Promise<void>;
  onOpenConversation(): void;
}) {
  const [busy, setBusy] = useState(false);
  const subjectId = useId();
  const inline = inboxInteractionDecisions(interaction);
  const responding = interaction.status === 'RESPONDING';
  const respond = async (decision: AgentInteractionDecision) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onRespond(interaction, decision);
    } catch {
      // The app shell reports the error; the request stays here for another try.
    } finally {
      setBusy(false);
    }
  };
  // A command is shown whatever happens next, so a warning is never about
  // something the user cannot see; the directory is named when it is outside
  // the task worktree.
  const command =
    interaction.type === 'COMMAND_APPROVAL'
      ? (interaction.request as AgentCommandApprovalRequest)
      : undefined;
  const subject = inline.subject ?? displayApprovalCommand(command?.command);
  const outsideDirectory =
    command?.cwd && !isWithinWorktree(command.cwd, worktreePath) ? command.cwd : undefined;

  return (
    <DecisionSlot>
      <h3 className="tm-slot__headline">{interactionHeadline(interaction, agentName)}</h3>
      {subject ? (
        <code id={subjectId} className="tm-slot__subject">
          {subject}
        </code>
      ) : null}
      {outsideDirectory ? (
        <p className="tm-slot__reported">
          <span>Runs in</span> <code className="tm-slot__code">{outsideDirectory}</code>
        </p>
      ) : null}
      {responding ? (
        <p className="tm-slot__detail">Your answer was sent. Waiting for the agent to confirm it.</p>
      ) : (
        interaction.policyWarnings.map((warning) => (
          <p key={warning} className="tm-slot__detail tm-slot__detail--warning">
            {warning}
          </p>
        ))
      )}
      {responding ? null : (
        <div className="tm-slot__actions">
          {inline.deny ? (
            <button
              type="button"
              className="outline-button"
              disabled={busy}
              aria-describedby={subject ? subjectId : undefined}
              onClick={() => void respond(inline.deny!.decision)}
            >
              {inline.deny.label}
            </button>
          ) : null}
          {inline.approve ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              aria-describedby={subject ? subjectId : undefined}
              onClick={() => void respond(inline.approve!.decision)}
            >
              {inline.approve.label}
            </button>
          ) : null}
          <button
            type="button"
            className={inline.approve ? 'outline-button' : 'primary-button'}
            onClick={onOpenConversation}
          >
            {inline.approve
              ? 'Open conversation'
              : interaction.type === 'USER_INPUT'
                ? 'Answer in conversation'
                : 'Review in conversation'}
          </button>
        </div>
      )}
    </DecisionSlot>
  );
}

function interactionHeadline(interaction: InteractionRequestRecord, agent: string): string {
  switch (interaction.type) {
    case 'COMMAND_APPROVAL':
      return `${agent} wants to run a command`;
    case 'FILE_CHANGE_APPROVAL':
      return `${agent} wants to change files`;
    case 'PERMISSION_APPROVAL':
      return `${agent} asks for more access`;
    case 'USER_INPUT': {
      const count = (interaction.request as AgentUserInputRequest).questions?.length ?? 0;
      return count > 1 ? `${agent} asked ${count} questions` : `${agent} asked a question`;
    }
    case 'MCP_ELICITATION':
      return 'A tool needs your input';
    case 'DYNAMIC_TOOL':
      return `${agent} called a tool Task Monki does not provide`;
  }
}

/** A flat Overview section: one header style, no card. */
export function OverviewSection({
  title,
  aside,
  className = '',
  children
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`tm-osection ${className}`.trim()}>
      <div className="tm-osection__head">
        <h3 className="tm-osection__title">
          {title}
        </h3>
        {aside ? <div className="tm-osection__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The request as written: prose first, collapsed past a few lines. */
export function OverviewRequest({
  prompt,
  attachments
}: {
  prompt: string;
  attachments: TaskAttachmentRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyId = useId();
  const body = useRef<HTMLParagraphElement>(null);
  // Whether the clamp hides anything depends on the width the text gets, so it
  // is measured, and measured again when the column resizes.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt, expanded]);
  const long = overflowing || expanded;
  return (
    <OverviewSection
      title="Request"
      aside={
        long ? (
          <button
            type="button"
            className="tm-osection__link"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Show less' : 'Show full request'}
          </button>
        ) : undefined
      }
    >
      <p
        ref={body}
        id={bodyId}
        className={`tm-orequest__prompt${expanded ? '' : ' tm-orequest__prompt--clamped'}`}
      >
        {prompt}
      </p>
      {attachments.length > 0 ? (
        <ul className="tm-orequest__attachments" aria-label="Task attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span title={attachment.displayName}>{attachment.displayName}</span>
              <span className="tm-orequest__attachment-meta">
                <span>{attachment.kind === 'image' ? 'Image' : 'Text'}</span>
                <span>{formatAttachmentBytes(attachment.byteCount)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </OverviewSection>
  );
}
