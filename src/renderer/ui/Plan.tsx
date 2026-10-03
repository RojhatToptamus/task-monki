import { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ListChecks } from 'lucide-react';
import type { AgentPlanStep } from '../../shared/agent';
import { DisclosureChevron } from './DisclosureChevron';

export type PlanStepStatus = AgentPlanStep['status'];

export interface PlanListStep {
  step: string;
  status: PlanStepStatus;
  /** Marks a temporary provider-plan placeholder without changing workflow truth. */
  pending?: boolean;
}

/**
 * A terminal marker layered onto a specific plan step by the run surface: where a
 * failed run stopped (× on the failing step) or where an interrupted run was
 * stopped ("stopped here"). Kept separate from status so the plan model stays the
 * provider's plan while the card supplies run-outcome context.
 */
export type PlanStepMarker = 'failed' | 'stopped' | 'unfinished';

export interface PlanListMarker {
  /** Index of the step the marker sits on. */
  index: number;
  kind: PlanStepMarker;
}

/**
 * One plan rendered everywhere the same way. A plan is a collection, so every
 * step names its state with a right-aligned word rather than repeated glyphs.
 */
export function PlanList({
  steps,
  marker
}: {
  steps: PlanListStep[];
  /** Pin a run-outcome marker (failed/stopped) to a single step. */
  marker?: PlanListMarker;
}) {
  return (
    <div className="tm-plan__steps" role="list">
      {steps.map((step, index) => {
        const stepMarker = marker?.index === index ? marker.kind : undefined;
        const active = step.status === 'IN_PROGRESS' && !stepMarker;
        const stateLabel = planStepStatusLabel(step, stepMarker);
        const labelClass = [
          'tm-plan__label',
          active ? 'tm-plan__label--active' : '',
          stepMarker === 'stopped' ? 'tm-plan__label--stopped' : '',
          stepMarker === 'failed' ? 'tm-plan__label--failed' : ''
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            className="tm-plan__step"
            key={`${step.status}:${step.step}:${index}`}
            role="listitem"
            aria-label={planStepAriaLabel(step, stepMarker)}
          >
            <span className={labelClass}>{step.step}</span>
            <span
              className="tm-plan__state"
              data-status={stepMarker ?? step.status.toLowerCase()}
            >
              {stateLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The plan inside a conversation: open while the agent works through it or
 * when a run ended partway, otherwise one line with its progress.
 */
export function PlanCard({ steps, marker, live = false }: {
  steps: PlanListStep[];
  marker?: PlanListMarker;
  live?: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean>();
  const done = steps.filter((step) => step.status === 'COMPLETED').length;
  return <Collapsible.Root className="tm-plan-card" open={userOpen ?? (live || Boolean(marker))} onOpenChange={setUserOpen}>
    <Collapsible.Trigger className="tm-plan-card__head" data-disclosure="">
      <ListChecks size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />
      <span className="tm-plan-card__title">Plan</span>
      <span className="tm-plan-card__count">{done} of {steps.length} done</span>
      <DisclosureChevron />
    </Collapsible.Trigger>
    <Collapsible.Content className="tm-plan-card__body"><PlanList steps={steps} marker={marker} /></Collapsible.Content>
  </Collapsible.Root>;
}

function planStepAriaLabel(step: PlanListStep, marker?: PlanStepMarker): string {
  return `${planStepStatusLabel(step, marker)}: ${step.step}`;
}

function planStepStatusLabel(step: PlanListStep, marker?: PlanStepMarker): string {
  if (marker === 'unfinished') return 'Unfinished';
  if (marker === 'failed') {
    return 'Failed';
  }
  if (marker === 'stopped') {
    return 'Stopped here';
  }
  if (step.pending && step.status === 'IN_PROGRESS') {
    return 'Waiting';
  }
  switch (step.status) {
    case 'COMPLETED':
      return 'Completed';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'PENDING':
      return 'Pending';
  }
}
