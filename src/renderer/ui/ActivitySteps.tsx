import { useState, type ReactNode } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  Brain,
  CircleAlert,
  Clock3,
  FileText,
  MessageSquareText,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import type { OverviewActivityLeaf, OverviewActivityRow } from '../model/overviewRunActivity';
import { reasoningLabel, stepsSummary, type SessionStep } from '../model/agentSession';
import { DisclosureChevron } from './DisclosureChevron';
import { MessageMarkdown } from './MessageMarkdown';

/**
 * Tool calls and reasoning between two messages. One step reads as itself; a
 * run of steps collapses to what it did, and stays open while it is live.
 * Only the last live group's running words shimmer; anything after it, such
 * as the conversation's working line, carries the motion instead.
 */
export function ActivitySteps({ steps, live = false }: { steps: SessionStep[]; live?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean>();
  if (steps.length === 1) return <div className="tm-steps"><Step step={steps[0]!} live={live} /></div>;
  const failed = steps.filter((step) => step.kind === 'tool' && step.row.status === 'failed' && step.row.tone === 'error').length;
  const active = steps.some((step) => step.kind === 'reasoning' ? step.active : step.row.status === 'active');
  const open = userOpen ?? (live || active);
  return <Collapsible.Root className="tm-steps tm-steps--group" open={open} onOpenChange={setUserOpen}>
    <Collapsible.Trigger className="tm-step__row tm-step__trigger tm-steps__summary" data-disclosure="">
      <span className="tm-step__icon" aria-hidden="true"><DisclosureChevron /></span>
      {/* Open, the running step's words are live; collapsed, the group's are. */}
      <span className={`tm-step__label${live && active && !open ? ' tm-shimmer' : ''}`}>{stepsSummary(steps)}</span>
      {failed ? <span className="tm-step__failed">{failed} failed</span> : null}
    </Collapsible.Trigger>
    <Collapsible.Content className="tm-steps__list">
      {steps.map((step) => <Step key={step.key} step={step} live={live} />)}
    </Collapsible.Content>
  </Collapsible.Root>;
}

/** A plain list of activity rows, for surfaces whose steps are not split by messages. */
export function ActivityRows({ rows }: { rows: OverviewActivityRow[] }) {
  return <div className="tm-steps">{rows.map((row) => <ToolStep key={row.key} row={row} />)}</div>;
}

function Step({ step, live }: { step: SessionStep; live: boolean }) {
  return step.kind === 'reasoning'
    ? <ReasoningStep text={step.text} label={reasoningLabel(step.seconds, step.active)} active={step.active} live={live} />
    : <ToolStep row={step.row} live={live} />;
}

function ReasoningStep({ text, label, active, live }: { text: string; label: string; active: boolean; live: boolean }) {
  return <Disclosure icon={<Brain size={13} />}
    label={<span className={`tm-step__label${live && active ? ' tm-shimmer' : ''}`}>{label}</span>} open={active}>
    <div className="tm-step__reasoning"><MessageMarkdown text={text} /></div>
  </Disclosure>;
}

function ToolStep({ row, live = false }: { row: OverviewActivityRow; live?: boolean }) {
  const execution = row.execution;
  const hasExecution = Boolean(execution?.command || execution?.output || execution?.error);
  const children = row.children?.length ? row.children : undefined;
  const icon = <StepIcon icon={row.icon} />;
  const copy = <StepCopy row={row} live={live && row.status === 'active'} />;
  const className = `tm-step tm-step--${row.kind}${row.status === 'failed' && row.tone === 'error' ? ' tm-step--failed' : ''}`;
  if (!hasExecution && !children) {
    return <div className={className}><div className="tm-step__row"><span className="tm-step__icon" aria-hidden="true">{icon}</span>{copy}</div></div>;
  }
  return <Disclosure className={className} icon={icon} label={copy}>
    {children ? <div className="tm-step__children">
      {children.map((child) => <div key={child.key} className="tm-step__child"><StepCopy row={child} /></div>)}
    </div> : null}
    {hasExecution ? <div className="tm-step__execution">
      {execution?.command ? <pre className="tm-step__command">{execution.command}</pre> : null}
      {execution?.error ? <p className="tm-step__error">{execution.error}</p> : null}
      {execution?.output ? <pre>{execution.output}</pre> : null}
    </div> : null}
  </Disclosure>;
}

function Disclosure({ icon, label, className = 'tm-step', open: liveOpen = false, children }: {
  icon: ReactNode; label: ReactNode; className?: string; open?: boolean; children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<boolean>();
  return <Collapsible.Root className={className} open={userOpen ?? liveOpen} onOpenChange={setUserOpen}>
    <Collapsible.Trigger className="tm-step__row tm-step__trigger" data-disclosure="">
      <span className="tm-step__icon" aria-hidden="true">{icon}</span>
      {label}
      <DisclosureChevron />
    </Collapsible.Trigger>
    <Collapsible.Content className="tm-step__body">{children}</Collapsible.Content>
  </Collapsible.Root>;
}

function StepCopy({ row, live = false }: { row: OverviewActivityLeaf; live?: boolean }) {
  return <span className="tm-step__copy">
    <span className={`tm-step__label${live ? ' tm-shimmer' : ''}`}>{row.label}</span>
    {row.detail ? <span className={`tm-step__detail${row.detailKind === 'command' || row.detailKind === 'path' ? ' tm-step__detail--mono' : ''}`}
      title={row.detail}>{row.detail}</span> : null}
    {row.metric ? <span className="tm-step__metric">{row.metric}</span> : null}
  </span>;
}

const STEP_ICONS: Partial<Record<OverviewActivityLeaf['icon'], LucideIcon>> = {
  edit: Pencil,
  error: CircleAlert,
  message: MessageSquareText,
  search: Search,
  terminal: SquareTerminal,
  tool: Wrench,
  wait: Clock3
};

function StepIcon({ icon }: { icon: OverviewActivityLeaf['icon'] }) {
  const Component = STEP_ICONS[icon] ?? FileText;
  return <Component size={13} />;
}
