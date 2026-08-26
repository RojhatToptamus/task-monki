import type { AgentPlanStep } from '../../shared/agent';

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
export type PlanStepMarker = 'failed' | 'stopped';

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
  showCaptions = false,
  marker,
  animate = true
}: {
  steps: PlanListStep[];
  /** Retained for caller compatibility; every collection row names its state. */
  showCaptions?: boolean;
  /** Pin a run-outcome marker (failed/stopped) to a single step. */
  marker?: PlanListMarker;
  /** Retained for caller compatibility; list state no longer animates. */
  animate?: boolean;
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

function planStepAriaLabel(step: PlanListStep, marker?: PlanStepMarker): string {
  return `${planStepStatusLabel(step, marker)}: ${step.step}`;
}

function planStepStatusLabel(step: PlanListStep, marker?: PlanStepMarker): string {
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
