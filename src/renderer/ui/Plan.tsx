import type { AgentPlanStep } from '../../shared/agent';

export type PlanStepStatus = AgentPlanStep['status'];

export interface PlanListStep {
  step: string;
  status: PlanStepStatus;
  /** A "waiting for the provider plan" placeholder — its label shimmers. */
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

function planStepCaption(status: PlanStepStatus): string | undefined {
  switch (status) {
    case 'IN_PROGRESS':
      return 'In progress';
    case 'PENDING':
      return 'Pending';
    default:
      return undefined;
  }
}

/**
 * One plan rendered everywhere the same way (audit §06 PlanList). The plan owns
 * the card: done steps recede to muted with a green check, the single active step
 * carries weight with a spinning ring, pending steps stay faint behind a hollow
 * dot. A run-outcome marker (× "failed" / "stopped here") can pin the exact step
 * a terminal run left off on. Optional per-step captions serve journal/history
 * contexts where every step's status is spelled out.
 */
export function PlanList({
  steps,
  showCaptions = false,
  marker,
  animate = true
}: {
  steps: PlanListStep[];
  /** Show the per-step In-progress/Pending caption (journal/history contexts). */
  showCaptions?: boolean;
  /** Pin a run-outcome marker (failed/stopped) to a single step. */
  marker?: PlanListMarker;
  /** Spin the active-step ring. Off for reduced motion / resting cards. */
  animate?: boolean;
}) {
  return (
    <div className="tm-plan__steps" role="list">
      {steps.map((step, index) => {
        const stepMarker = marker?.index === index ? marker.kind : undefined;
        const active = step.status === 'IN_PROGRESS' && !stepMarker;
        // A placeholder waiting-step shimmers while live; a real active step just
        // carries weight (spec §Waiting vs §Running).
        const shimmer = Boolean(step.pending) && active && animate;
        const caption = showCaptions ? planStepCaption(step.status) : undefined;
        const labelClass = [
          'tm-plan__label',
          active ? 'tm-plan__label--active' : '',
          shimmer ? 'tm-plan__label--shimmer' : '',
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
            <PlanStepGlyph status={step.status} marker={stepMarker} animate={animate} />
            <span className={labelClass}>{step.step}</span>
            {stepMarker === 'failed' ? (
              <span className="tm-plan__marker tm-plan__marker--failed">failed</span>
            ) : null}
            {stepMarker === 'stopped' ? (
              <span className="tm-plan__marker tm-plan__marker--stopped">stopped here</span>
            ) : null}
            {caption ? <span className="tm-plan__step-caption">{caption}</span> : null}
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

/**
 * The status glyph in the plan's icon gutter: a green check for done, a spinning
 * ring for the active step, a hollow ring for pending, and run-outcome overrides
 * (× for the failed step, a filled neutral dot for the stopped step).
 */
function PlanStepGlyph({
  status,
  marker,
  animate
}: {
  status: PlanStepStatus;
  marker?: PlanStepMarker;
  animate: boolean;
}) {
  if (marker === 'failed') {
    return (
      <span className="tm-plan__glyph" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" className="tm-plan__x">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      </span>
    );
  }
  if (marker === 'stopped') {
    return (
      <span className="tm-plan__glyph" aria-hidden="true">
        <span className="tm-plan__stopdot" />
      </span>
    );
  }
  if (status === 'COMPLETED') {
    return (
      <span className="tm-plan__glyph" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" className="tm-plan__check">
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      </span>
    );
  }
  if (status === 'IN_PROGRESS') {
    return (
      <span className="tm-plan__glyph" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className={`tm-plan__ring ${animate ? 'tm-plan__ring--spin' : ''}`}
        >
          <circle cx="8" cy="8" r="6" className="tm-plan__ring-track" />
          <path d="M8 2a6 6 0 0 1 6 6" className="tm-plan__ring-arc" />
        </svg>
      </span>
    );
  }
  return (
    <span className="tm-plan__glyph" aria-hidden="true">
      <span className="tm-plan__pending" />
    </span>
  );
}
