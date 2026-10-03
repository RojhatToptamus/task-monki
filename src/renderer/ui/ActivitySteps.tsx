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
import { StatusGlyph } from './StatusBadge';

/**
 * Tool calls and reasoning between two messages. One step reads as itself; a
 * run of steps collapses to what it did, and stays open while it is live.
 */
export function ActivitySteps({ steps, live = false }: { steps: SessionStep[]; live?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean>();
  if (steps.length === 1) return <div className="tm-steps"><Step step={steps[0]!} /></div>;
  const failed = steps.filter((step) => step.kind === 'tool' && step.row.status === 'failed' && step.row.tone === 'error').length;
  const active = steps.some((step) => step.kind === 'reasoning' ? step.active : step.row.status === 'active');
  const open = userOpen ?? (live || active);
  return <Collapsible.Root className="tm-steps tm-steps--group" open={open} onOpenChange={setUserOpen}>
    <Collapsible.Trigger className="tm-step__row tm-step__trigger tm-steps__summary" data-disclosure="">
      <span className="tm-step__icon" aria-hidden="true"><DisclosureChevron /></span>
      <span className="tm-step__label">{stepsSummary(steps)}</span>
      {failed ? <span className="tm-step__failed">{failed} failed</span> : null}
      {active ? <StatusGlyph kind="working" /> : null}
    </Collapsible.Trigger>
    <Collapsible.Content className="tm-steps__list">
      {steps.map((step) => <Step key={step.key} step={step} />)}
    </Collapsible.Content>
  </Collapsible.Root>;
}

/** A plain list of activity rows, for surfaces whose steps are not split by messages. */
export function ActivityRows({ rows }: { rows: OverviewActivityRow[] }) {
  return <div className="tm-steps">{rows.map((row) => <ToolStep key={row.key} row={row} />)}</div>;
}

function Step({ step }: { step: SessionStep }) {
  return step.kind === 'reasoning'
    ? <ReasoningStep text={step.text} label={reasoningLabel(step.seconds, step.active)} active={step.active} />
    : <ToolStep row={step.row} />;
}

function ReasoningStep({ text, label, active }: { text: string; label: string; active: boolean }) {
  return <Disclosure icon={active ? <StatusGlyph kind="working" /> : <Brain size={13} strokeWidth={1.25} absoluteStrokeWidth />}
    label={<span className="tm-step__label">{label}</span>} open={active}>
    <div className="tm-step__reasoning"><MessageMarkdown text={text} /></div>
  </Disclosure>;
}

function ToolStep({ row }: { row: OverviewActivityRow }) {
  const execution = row.execution;
  const hasExecution = Boolean(execution?.command || execution?.output || execution?.error);
  const children = row.children?.length ? row.children : undefined;
  const icon = row.status === 'active' ? <StatusGlyph kind="working" /> : <StepIcon icon={row.icon} />;
  const copy = <StepCopy row={row} />;
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

function StepCopy({ row }: { row: OverviewActivityLeaf }) {
  return <span className="tm-step__copy">
    <span className="tm-step__label">{row.label}</span>
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
  return <Component size={13} strokeWidth={1.25} absoluteStrokeWidth />;
}
