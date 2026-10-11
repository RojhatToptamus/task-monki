import { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleStop,
  CircleX,
  ListChecks
} from 'lucide-react';
import type { AgentPlanStep } from '../../shared/agent';
import { DisclosureChevron } from './DisclosureChevron';

export type PlanStepStatus = AgentPlanStep['status'];

export interface PlanListStep {
  step: string;
  status: PlanStepStatus;
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

const STEP_MARKS = {
  COMPLETED: CircleCheck,
  IN_PROGRESS: CircleDot,
  PENDING: Circle
} satisfies Record<PlanStepStatus, unknown>;

const MARKER_MARKS = {
  failed: CircleX,
  stopped: CircleStop,
  unfinished: CircleDashed
} satisfies Record<PlanStepMarker, unknown>;

/**
 * One plan rendered everywhere the same way: a checklist. Its marks are shapes,
 * not colours (a check, a dot, a ring), the way every checklist reads. The plan
 * never spins; the activity beneath it shows the work in flight. A word appears
 * only on the one step where a run stopped or failed.
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
    <ol className="tm-plan__steps">
      {steps.map((step, index) => {
        const stepMarker = marker?.index === index ? marker.kind : undefined;
        const Mark = stepMarker ? MARKER_MARKS[stepMarker] : STEP_MARKS[step.status];
        return (
          <li
            className="tm-plan__step"
            data-state={stepMarker ?? step.status.toLowerCase()}
            key={`${step.status}:${step.step}:${index}`}
          >
            <Mark
              className="tm-plan__mark"
              size={13}
              aria-hidden="true"
            />
            <span className="tm-plan__label">{step.step}</span>
            {stepMarker ? (
              <span className="tm-plan__state">{planStepStatusLabel(step, stepMarker)}</span>
            ) : (
              <span className="tm-visually-hidden">, {planStepStatusLabel(step)}</span>
            )}
          </li>
        );
      })}
    </ol>
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
      <ListChecks size={13} aria-hidden="true" />
      <span className="tm-plan-card__title">Plan</span>
      <span className="tm-plan-card__count">{done} of {steps.length} done</span>
      <DisclosureChevron />
    </Collapsible.Trigger>
    <Collapsible.Content className="tm-plan-card__body"><PlanList steps={steps} marker={marker} /></Collapsible.Content>
  </Collapsible.Root>;
}

function planStepStatusLabel(step: PlanListStep, marker?: PlanStepMarker): string {
  if (marker === 'unfinished') return 'Unfinished';
  if (marker === 'failed') {
    return 'Failed';
  }
  if (marker === 'stopped') {
    return 'Stopped here';
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
