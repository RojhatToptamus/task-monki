import type { AgentPlanStep } from '../../shared/agent';
import type { Tone } from './taskView';

export type PlanStepStatus = AgentPlanStep['status'];

export interface PlanListStep {
  step: string;
  status: PlanStepStatus;
}

/** Tone for a plan step's status dot. */
export function planStepTone(status: PlanStepStatus): Tone {
  if (status === 'COMPLETED') {
    return 'success';
  }
  if (status === 'IN_PROGRESS') {
    return 'action';
  }
  return 'neutral';
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
 * One plan rendered everywhere the same way: each step is a status dot + label,
 * with an optional per-step caption ("In progress" / "Pending"). Used by the
 * live agent-progress card and the provider plan journal so the two stop being
 * two visual dialects for one concept (audit §06 PlanList).
 */
export function PlanList({
  steps,
  showCaptions = false
}: {
  steps: PlanListStep[];
  /** Show the per-step In-progress/Pending caption (journal/history contexts). */
  showCaptions?: boolean;
}) {
  return (
    <div className="tm-plan__steps">
      {steps.map((step, index) => {
        const tone = planStepTone(step.status);
        const active = step.status === 'IN_PROGRESS';
        const caption = showCaptions ? planStepCaption(step.status) : undefined;
        return (
          <div className="tm-plan__step" key={`${step.status}:${step.step}:${index}`}>
            <span className="tm-plan__dot" style={{ background: `var(--${tone})` }} />
            <span className={`tm-plan__label ${active ? 'tm-plan__label--active' : ''}`}>
              {step.step}
            </span>
            {caption ? <span className="tm-plan__step-caption">{caption}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
