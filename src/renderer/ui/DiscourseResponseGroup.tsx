import type { DiscourseConversationAggregateRecord } from '../../shared/discourse';
import { discourseTerminalJobDetail } from '../model/discourse';
import { StatusGlyph } from './StatusBadge';
import { DiscourseMarkdown } from './DiscourseMarkdown';

interface DiscourseResponseGroupProps {
  aggregate: DiscourseConversationAggregateRecord;
  wave: DiscourseConversationAggregateRecord['waves'][number];
  streamDrafts: Record<string, string>;
  onStop(waveId: string): void;
  onConfirm(waveId: string): void;
  onRetry(waveId: string, question?: string): void;
}

/** Runtime state only. A finished turn does not declare the user's question resolved. */
export function DiscourseResponseGroup({ aggregate, wave, streamDrafts, onStop, onConfirm, onRetry }: DiscourseResponseGroupProps) {
  const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
  const active = jobs.find((job) => !['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status));
  const stopping = wave.status === 'STOP_REQUESTED' || wave.status === 'STOPPING';
  const settled = wave.status === 'SETTLED';
  const reconfirm = wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED';
  const recovery = wave.status === 'RECOVERY_REQUIRED' || active?.status === 'RECOVERY_REQUIRED';
  const legacyConcerns = aggregate.concerns.filter((concern) => concern.waveId === wave.id);
  const stream = active?.assignment.assignmentRole !== 'REVIEWER' && active?.role === 'ANSWER' ? streamDrafts[active.id] : undefined;
  const label = stopping ? 'Stopping…' : reconfirm ? 'Context changed' : recovery ? 'Response interrupted'
    : active ? `${active.assignment.displayNameSnapshot} ${active.assignment.assignmentRole === 'REVIEWER' ? 'is checking the answer' : 'is responding'}`
    : wave.settlementReason === 'TIME_LIMIT' ? 'Time limit reached'
    : wave.outcome === 'STALE' ? 'Context changed'
    : wave.outcome === 'CANCELED' || wave.settlementReason === 'STOPPED' ? 'Stopped'
    : wave.outcome === 'COMPLETE' ? '' : 'Response incomplete';
  const detail = reconfirm ? 'Use the updated context for this response?'
    : recovery ? 'The previous response may have started. Stop it before sending again.'
    : settled && wave.outcome !== 'COMPLETE'
      ? discourseTerminalJobDetail(jobs) ?? (wave.settlementReason === 'TIME_LIMIT'
        ? 'The 20-minute allowance ended. Completed messages are kept.'
        : wave.outcome === 'STALE' ? 'The selected sources changed. Ask again with current context.'
        : jobs.some((job) => job.result) ? 'Completed messages are kept.' : undefined)
      : undefined;
  const tone = stopping || (!settled && !reconfirm && !recovery) ? 'working' : reconfirm || recovery || wave.outcome === 'STALE' ? 'waiting' : settled && ['FAILED', 'NO_RESPONSE'].includes(wave.outcome ?? '') ? 'blocked' : 'idle';
  if (!label && !legacyConcerns.length) return null;
  return <li className={`tm-discourse-response tm-discourse-response--${tone}`} aria-label="Agent response status">
    {label ? <header>
      {tone !== 'idle' ? <StatusGlyph kind={tone} animate={tone === 'working'} /> : null}
      <span className="tm-discourse-response__copy" role="status">
        <strong>{label}</strong>{detail ? <small>{detail}</small> : null}
      </span>
      {reconfirm ? <span className="tm-discourse-response__actions">
        <button type="button" onClick={() => onConfirm(wave.id)}>Use updated context</button>
        <button type="button" onClick={() => onStop(wave.id)}>Cancel</button>
      </span> : !settled ? <button type="button" disabled={stopping} onClick={() => onStop(wave.id)}>Stop</button>
        : wave.outcome !== 'COMPLETE' && wave.outcome !== 'CANCELED'
          ? <button type="button" onClick={() => onRetry(wave.id)}>Ask again</button> : null}
    </header> : null}
    {stream ? <div className="tm-discourse-response__streams"><DiscourseMarkdown text={stream} /></div> : null}
    {legacyConcerns.length ? <details className="tm-discourse-response__details">
      <summary>Earlier review notes</summary>
      {legacyConcerns.map((concern) => <section key={concern.id}>
        <strong>{concern.targetClaim}</strong><p>{concern.reason}</p><p>{concern.evidence}</p>
        <p>{concern.suggestedResolution}</p>
      </section>)}
    </details> : null}
  </li>;
}
