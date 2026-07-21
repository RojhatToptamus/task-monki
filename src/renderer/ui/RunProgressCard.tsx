import type { ReactNode } from 'react';
import type { RunProgressStep, RunProgressViewModel } from '../model/runProgress';
import { PlanList, type PlanListMarker, type PlanStepMarker } from './Plan';
import { RunActivityTimeline } from './RunActivityTimeline';
import { RunHeader } from './RunHeader';
import { dotStyle } from './StatusBadge';
import type { Tone } from '../model/viewTypes';

export function RunProgressCard({
  progress,
  runStartedAt,
  scope,
  onShowDebug,
  onStop,
  stopDisabled,
  stopTitle,
  completedChangeSummary,
  animate = true
}: {
  progress: RunProgressViewModel;
  runStartedAt?: string;
  scope?: string;
  onShowDebug?: () => void;
  onStop?: () => void;
  stopDisabled?: boolean;
  stopTitle?: string;
  completedChangeSummary?: ReactNode;
  /** Run the live header pulse and active-ring spin. Off for reduced motion. */
  animate?: boolean;
}) {
  const steps = progress.steps;
  const running = progress.state === 'RUNNING';
  const liveMotion = animate && running;
  const marker = planMarkerForState(progress.state, steps);
  return (
    <div className="tm-panel">
      <RunHeader
        running={running}
        tone={runProgressHeaderTone(progress.state)}
        pulse={liveMotion}
        operationName="Agent progress"
        scope={scope}
        startedAt={runStartedAt}
        onStop={onStop}
        stopDisabled={stopDisabled}
        stopTitle={stopTitle}
        trailingLabel={running ? undefined : progress.headerLabel}
      />
      <PlanList steps={steps} marker={marker} animate={liveMotion} />
      {running ? (
        <RunActivityTimeline
          rows={progress.activityTail}
          outputSummary={progress.activityOutputSummary}
          onShowDebug={onShowDebug}
        />
      ) : null}
      {!running ? completedChangeSummary : null}
      {progress.footer ? <ProgressFooter footer={progress.footer} /> : null}
    </div>
  );
}

function ProgressFooter({ footer }: { footer: NonNullable<RunProgressViewModel['footer']> }) {
  if (footer.tone === 'success') {
    const detail = footer.detail ? `${footer.title}: ${footer.detail}` : footer.title;
    return (
      <div className="tm-run-progress__footer tm-run-progress__footer--success tm-run-progress__footer--quiet">
        <span className="tm-run-progress__footer-detail">{detail}</span>
      </div>
    );
  }
  return (
    <div className={`tm-run-progress__footer tm-run-progress__footer--${footer.tone}`}>
      <span className="tm-plan__dot" style={dotStyle(footer.tone)} />
      <span className="tm-run-progress__footer-copy">
        <span className="tm-run-progress__footer-title">{footer.title}</span>
        {footer.detail ? (
          <span className="tm-run-progress__footer-detail">{footer.detail}</span>
        ) : null}
      </span>
    </div>
  );
}

function runProgressHeaderTone(state: RunProgressViewModel['state']): Tone {
  switch (state) {
    case 'RUNNING':
      return 'info';
    case 'COMPLETED':
      return 'success';
    case 'INTERRUPTED':
      return 'neutral';
    default:
      return 'error';
  }
}

function planMarkerForState(
  state: RunProgressViewModel['state'],
  steps: RunProgressStep[]
): PlanListMarker | undefined {
  const kind: PlanStepMarker | undefined =
    state === 'FAILED' || state === 'RECOVERY_REQUIRED'
      ? 'failed'
      : state === 'INTERRUPTED'
        ? 'stopped'
        : undefined;
  if (!kind) {
    return undefined;
  }
  const inProgress = steps.map((step) => step.status).lastIndexOf('IN_PROGRESS');
  const index = inProgress >= 0 ? inProgress : steps.findIndex((step) => step.status === 'PENDING');
  if (index < 0) {
    return undefined;
  }
  return { index, kind };
}
