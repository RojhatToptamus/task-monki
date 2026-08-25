import type { DiscourseConversationAggregateRecord } from '../../shared/discourse';
import {
  discourseConcernResolutionLabel,
  discourseJobStatusLabel,
  discourseResponsePolicyLabel,
  discourseResponseTone,
  discourseReviewResultLabel,
  discourseTeamCompletionSummary,
  discourseTerminalJobDetail
} from '../model/discourse';
import { StatusGlyph } from './StatusBadge';
import { DisclosureChevron } from './DisclosureChevron';

interface DiscourseResponseGroupProps {
  aggregate: DiscourseConversationAggregateRecord;
  wave: DiscourseConversationAggregateRecord['waves'][number];
  streamDrafts: Record<string, string>;
  onStop(waveId: string): void;
  onConfirm(waveId: string): void;
  onRetry(waveId: string): void;
}

/** One wave's live, recovery, review, and terminal presentation. */
export function DiscourseResponseGroup({
  aggregate,
  wave,
  streamDrafts,
  onStop,
  onConfirm,
  onRetry
}: DiscourseResponseGroupProps) {
  const queuedAfterCurrent = wave.status === 'SETTLED'
    ? 0
    : aggregate.waves.filter(
        (candidate) => candidate.status !== 'SETTLED' && candidate.id !== wave.id
      ).length;
  const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
  const reviews = jobs.filter((job) => job.role === 'CRITIQUE');
  const reviewGroups = reviews.reduce<Array<{ label: string; names: string[] }>>((groups, review) => {
    const label = discourseReviewResultLabel(review);
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.names.push(review.assignment.displayNameSnapshot);
    } else {
      groups.push({ label, names: [review.assignment.displayNameSnapshot] });
    }
    return groups;
  }, []);
  const concerns = aggregate.concerns.filter((concern) => concern.waveId === wave.id);
  const activeJobs = jobs.filter(
    (job) => !['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)
  );
  const active = activeJobs[0];
  const activelyWorking = active && active.status !== 'RECOVERY_REQUIRED';
  const streamingJobs = jobs.filter(
    (job) => job.role === 'ANSWER' && Boolean(streamDrafts[job.id])
  );
  const completedTeam =
    wave.policy === 'TEAM' && wave.status === 'SETTLED' && wave.outcome === 'COMPLETE';
  const teamSummary = completedTeam
    ? discourseTeamCompletionSummary({ jobs, concerns })
    : undefined;
  const terminalDetail = discourseTerminalJobDetail(jobs);
  const stopPending = wave.status === 'STOP_REQUESTED' || wave.status === 'STOPPING';
  const label = stopPending
    ? 'Stopping response'
    : wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED'
    ? 'Context changed before dispatch'
    : teamSummary
      ? teamSummary.label
      : active
        ? active.role === 'CRITIQUE'
          ? 'Reviewing the lead answer'
          : active.role === 'CORRECT'
            ? 'Preparing a correction'
            : wave.policy === 'PANEL'
              ? 'Panel responding'
              : discourseJobStatusLabel(active.status)
        : wave.outcome === 'CANCELED'
          ? 'Response stopped'
          : wave.outcome === 'STALE'
            ? 'Context changed'
            : wave.outcome === 'FAILED' || wave.outcome === 'NO_RESPONSE'
              ? 'Response failed'
              : 'Partial response';
  const detail = stopPending
    ? 'Finishing the current agent step and preserving completed work.'
    : wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED'
    ? 'Review the latest context before asking the agent again.'
    : teamSummary
      ? teamSummary.detail
      : active?.status === 'RECOVERY_REQUIRED'
        ? 'Task Monki could not confirm whether this response started. Stop it before trying again.'
        : active
          ? activeJobs.length > 1
            ? `${activeJobs.length} agents are working independently.`
            : `${active.assignment.displayNameSnapshot} · ${active.assignment.model}`
          : terminalDetail ?? waveTerminalDetail(wave.outcome);
  const stoppable = [
    'PLANNED',
    'SNAPSHOTTING',
    'QUEUED',
    'RUNNING',
    'STOP_REQUESTED',
    'STOPPING',
    'RECOVERY_REQUIRED'
  ].includes(wave.status);
  const retryable =
    wave.status === 'SETTLED' && wave.outcome !== 'COMPLETE' && wave.outcome !== 'CANCELED';
  const tone = discourseResponseTone({
    wave,
    activeJobStatus: active?.status
  });

  return (
    <li
      className={`tm-discourse-response tm-discourse-response--${tone} ${tone !== 'verified' && tone !== 'idle' ? 'tm-discourse-response--marked' : ''}`}
      aria-label="Agent response status"
    >
      <header>
        {tone !== 'verified' && tone !== 'idle' ? (
          <StatusGlyph kind={tone} animate={Boolean(activelyWorking)} />
        ) : null}
        <span className="tm-discourse-response__copy" role="status" aria-live="polite" aria-atomic="true">
          <strong>{label}</strong><small>{detail}</small>
        </span>
        {wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED' ? (
          <span className="tm-discourse-response__actions">
            <button type="button" onClick={() => onConfirm(wave.id)}>Continue</button>
            <button type="button" onClick={() => onStop(wave.id)}>Cancel</button>
          </span>
        ) : stoppable ? (
          <button
            type="button"
            disabled={stopPending}
            onClick={() => onStop(wave.id)}
          >
            {stopPending ? 'Stopping…' : 'Stop'}
          </button>
        ) : retryable ? (
          <button type="button" onClick={() => onRetry(wave.id)}>Try again</button>
        ) : null}
      </header>
      {streamingJobs.length > 0 ? (
        <div className="tm-discourse-response__streams">
          {streamingJobs.map((job) => (
            <div key={job.id}>
              <strong>{job.assignment.displayNameSnapshot}</strong>
              <p>{streamDrafts[job.id]}</p>
            </div>
          ))}
        </div>
      ) : null}
      {reviewGroups.length > 0 ? (
        <ul className="tm-discourse-response__reviews" aria-label="Team review results">
          {reviewGroups.map((group) => (
            <li key={group.label}>
              <span>{group.names.join(' · ')}</span>
              <strong>{group.label}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {concerns.length > 0 ? (
        <div className="tm-discourse-response__concerns">
          {concerns.map((concern) => (
            <details key={concern.id}>
              <summary>
                <DisclosureChevron className="tm-discourse-response__chevron" />
                <span>{capitalize(concern.severity)}</span>
                {concern.targetClaim}
                {concern.redundantOfConcernId ? (
                  <small>Duplicate signal</small>
                ) : discourseConcernResolutionLabel(concern) ? (
                  <small>{discourseConcernResolutionLabel(concern)}</small>
                ) : null}
              </summary>
              <div className="tm-discourse-response__concern-meta">
                <span>{capitalize(concern.category)}</span>
                <span>{capitalize(concern.evidenceStatus.replaceAll('_', ' '))}</span>
                <span>{capitalize(concern.confidence)} confidence</span>
              </div>
              <p><strong>Why it matters</strong>{concern.reason}</p>
              <p><strong>Evidence</strong>{concern.evidence}</p>
              <p><strong>Suggested resolution</strong>{concern.suggestedResolution}</p>
            </details>
          ))}
        </div>
      ) : null}
      <footer>
        {discourseResponsePolicyLabel(wave.policy)} · up to {wave.policy === 'TEAM' ? 4 : wave.assignments.length} agent turn{wave.policy === 'DIRECT' ? '' : 's'}
        {queuedAfterCurrent > 0
          ? ` · ${queuedAfterCurrent} follow-up${queuedAfterCurrent === 1 ? '' : 's'} queued`
          : ''}
      </footer>
    </li>
  );
}

function waveTerminalDetail(
  outcome: DiscourseConversationAggregateRecord['waves'][number]['outcome']
): string {
  switch (outcome) {
    case 'CANCELED': return 'The response was stopped before all agent work completed.';
    case 'STALE': return 'Changed context prevented this response from being accepted.';
    case 'FAILED': return 'The agents did not complete this response.';
    case 'NO_RESPONSE': return 'No agent completed an answer.';
    case 'PARTIAL': return 'Some agent work completed; incomplete results remain visible.';
    case 'COMPLETE': return 'The response completed.';
    default: return 'Response status is unavailable.';
  }
}

function capitalize(value: string): string {
  return value.charAt(0) + value.slice(1).toLocaleLowerCase();
}
