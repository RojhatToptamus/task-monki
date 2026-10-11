import { ChevronRight } from 'lucide-react';
import type { TaskLifecycleStep } from '../model/taskLifecycle';
import { StatusGlyph, taskStatusGlyph } from './StatusBadge';

/**
 * The task's path through the board's lanes, always in the same four words.
 * The current stage takes a glyph only when the task needs the user, has
 * failed, or has work in flight; its exact status is announced, not repeated.
 */
export function TaskLifecycleTrack({ steps }: { steps: TaskLifecycleStep[] }) {
  return (
    <ol className="tm-lifecycle" aria-label="Lifecycle">
      {steps.map((step, index) => {
        const glyph = step.status ? taskStatusGlyph(step.status.tone, Boolean(step.inFlight)) : undefined;
        return (
          <li
            key={step.key}
            className={`tm-lifecycle__step tm-lifecycle__step--${step.state}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
            title={step.status?.label}
          >
            {index > 0 ? (
              <ChevronRight className="tm-lifecycle__sep" size={13} aria-hidden="true" />
            ) : null}
            {glyph ? <StatusGlyph kind={glyph} /> : null}
            <span className="tm-lifecycle__label">{step.label}</span>
            {step.status && step.status.label !== step.label ? (
              <span className="tm-visually-hidden">, {step.status.label}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
