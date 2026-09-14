import { useEffect, useState } from 'react';
import type { DiscourseConversationAggregateRecord } from '../../shared/discourse';
import { taskManagerApi } from '../api/taskManagerClient';
import { messageModelName } from '../model/messageIdentity';
import { discourseTerminalJobDetail } from '../model/discourse';
import { MessageHeader } from './MessageHeader';
import { MessageMarkdown } from './MessageMarkdown';
import type { AgentModel } from '../../shared/contracts';

interface DiscourseResponseGroupProps {
  aggregate: DiscourseConversationAggregateRecord;
  wave: DiscourseConversationAggregateRecord['waves'][number];
  streamDrafts: Record<string, string>;
  models?: readonly AgentModel[];
  onStop(waveId: string): void;
  onConfirm(waveId: string): void;
  onRetry(waveId: string): void;
}

/** A pending or incomplete message, not another participant or a decision verdict. */
export function DiscourseResponseGroup({ aggregate, wave, streamDrafts, models, onStop, onConfirm, onRetry }: DiscourseResponseGroupProps) {
  const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
  const unfinished = jobs.filter((job) => job.status !== 'COMPLETED');
  const job = unfinished.find((candidate) => !['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(candidate.status))
    ?? unfinished.find((candidate) => candidate.outputArtifactId && candidate.role === 'ANSWER' && candidate.assignment.assignmentRole !== 'REVIEWER')
    ?? unfinished.at(-1);
  const stopping = ['STOP_REQUESTED', 'STOPPING'].includes(wave.status);
  const settled = wave.status === 'SETTLED';
  const reconfirm = wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED';
  const recovery = wave.status === 'RECOVERY_REQUIRED' || job?.status === 'RECOVERY_REQUIRED';
  const legacyConcerns = aggregate.concerns.filter((concern) => concern.waveId === wave.id);
  const author = messageModelName(job?.assignment.model, job?.assignment.displayNameSnapshot, models, job?.assignment.runtimeId);
  // A peer's structured control fields are never presented as partial prose.
  const plain = job?.role === 'ANSWER' && job.assignment.assignmentRole !== 'REVIEWER';
  const artifactId = plain && settled ? job?.outputArtifactId : undefined;
  const [savedOutput, setSavedOutput] = useState<{ id: string; text?: string; error?: boolean }>();
  useEffect(() => {
    if (!artifactId) return;
    let current = true;
    void taskManagerApi.readArtifact({ artifactId }).then((text) => {
      if (current) setSavedOutput({ id: artifactId, text: text.slice(0, 64 * 1024) });
    }, () => { if (current) setSavedOutput({ id: artifactId, error: true }); });
    return () => { current = false; };
  }, [artifactId]);
  const output = plain ? (savedOutput?.id === artifactId ? savedOutput?.text : undefined) ?? (job ? streamDrafts[job.id] : undefined) : undefined;
  const failed = wave.settlementReason === 'FAILED';
  const changed = reconfirm || wave.outcome === 'STALE';
  const status = stopping ? 'Stopping…' : reconfirm ? 'Context changed' : recovery ? 'Response interrupted'
    : !settled ? job?.status === 'QUEUED' || !job ? 'Waiting to start' : job.assignment.assignmentRole === 'REVIEWER' ? 'Checking answer' : 'Responding'
    : wave.settlementReason === 'TIME_LIMIT' ? 'Time limit reached'
    : changed ? 'Context changed'
    : failed ? 'Response failed' : wave.outcome !== 'COMPLETE'
      ? unfinished.length ? `Stopped before ${author} finished` : 'Discussion paused' : undefined;
  const detail = reconfirm ? 'Use the updated context for this response?'
    : recovery ? 'Delivery is uncertain. Stop this response before asking again.'
    : changed ? 'The selected sources changed. Ask again with current context.'
    : wave.settlementReason === 'TIME_LIMIT' ? 'The 20-minute allowance ended. Completed answers are kept.'
    : failed ? discourseTerminalJobDetail(jobs) ?? 'This response did not finish. You can ask again.'
    : settled && status ? output ? 'Partial text is kept here; it is not a completed answer.'
      : jobs.some((candidate) => candidate.status === 'COMPLETED') ? 'Completed responses are kept above.' : 'No completed answer was recorded.' : undefined;
  const tone = stopping || (!settled && job?.status === 'RUNNING' && !recovery && !reconfirm) ? 'working'
    : changed || recovery ? 'waiting' : failed ? 'blocked' : 'idle';
  if (!status && !legacyConcerns.length) return null;
  return <li className={`tm-discourse-message tm-discourse-message--pending ${job?.assignment.assignmentRole === 'REVIEWER' ? 'tm-discourse-message--peer' : ''}`} aria-label="Agent response status">
    <article>
      {status ? <>
        <MessageHeader author={author} model={settled ? job?.assignment.model : undefined}
          time={settled ? job?.finishedAt : undefined} status={!settled ? status : undefined} tone={tone} />
        {output ? <div className="tm-discourse-message__content"><MessageMarkdown text={output} /></div> : null}
        {settled || reconfirm || recovery ? <div className="tm-discourse-message-notice" role="status">
          <div>{settled ? <strong>{status}</strong> : null}{detail ? <p>{detail}</p> : null}</div>
          {reconfirm ? <button type="button" className="outline-button" onClick={() => onConfirm(wave.id)}>Use updated context</button>
            : settled ? <button type="button" className="outline-button" onClick={() => onRetry(wave.id)}>Ask again</button> : null}
          {reconfirm ? <button type="button" className="ghost-button" onClick={() => onStop(wave.id)}>Cancel</button> : null}
        </div> : null}
        {savedOutput?.id === artifactId && savedOutput?.error ? <p className="tm-discourse-message-notice">Saved partial output could not be loaded.</p> : null}
        {job?.error?.message && settled ? <details className="tm-discourse-message-details"><summary>Details</summary><p>{job.error.message}</p></details> : null}
      </> : null}
      {legacyConcerns.length ? <details className="tm-discourse-message-details">
        <summary>Earlier review notes</summary>
        {legacyConcerns.map((concern) => <section key={concern.id}><strong>{concern.targetClaim}</strong><p>{concern.reason}</p><p>{concern.evidence}</p><p>{concern.suggestedResolution}</p></section>)}
      </details> : null}
    </article>
  </li>;
}
