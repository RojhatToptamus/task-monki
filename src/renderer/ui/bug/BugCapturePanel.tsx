import { useEffect, useId, useMemo, useState, type RefObject } from 'react';
import { X } from 'lucide-react';
import type { BugCaptureDraft, BugCapturePreview, BugCaptureView, BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import {
  CHECK_TEMPLATE_OPTIONS,
  REQUEST_CHECK_OPTIONS,
  captureDraft,
  captureSaveState
} from '../../model/bugReplay';
import { DisclosureChevron } from '../DisclosureChevron';
import { StableLabel } from '../StableLabel';
import { Tooltip } from '../Tooltip';

const PREVIEW_DELAY_MS = 250;

/**
 * Mark the bug: what was wrong, what should have happened, and what Task Monki checks on a
 * clean copy. Saving is the person's approval of the expectation; nothing is checked that is
 * not listed here.
 */
export function BugCapturePanel({
  taskId,
  recording,
  capture,
  picking,
  replaces,
  titleRef,
  pointRef,
  onError,
  onSaved,
  onRecordAgain,
  restarting = false
}: {
  taskId: string;
  recording: BugRecordingSessionView;
  capture: BugCaptureView;
  /** The person is pointing at an element on the page. */
  picking: boolean;
  /** The task's current bug, which saving replaces. */
  replaces?: string;
  /** The bug's name field, where focus goes when marking starts. */
  titleRef?: RefObject<HTMLInputElement | null>;
  /** Add check, which reads Stop pointing while the page waits for a pick. */
  pointRef?: RefObject<HTMLButtonElement | null>;
  onError(message: string): void;
  onSaved(withCheck: boolean): void;
  /** A stopped recording: record it again instead of keeping these steps. */
  onRecordAgain?(): void;
  restarting?: boolean;
}) {
  const sessionId = recording.sessionId;
  const interrupted = recording.phase === 'INTERRUPTED';
  const [draft, setDraft] = useState<BugCaptureDraft>(() => captureDraft(capture));
  const [preview, setPreview] = useState<BugCapturePreview>();
  const [previewPending, setPreviewPending] = useState(true);
  const [busy, setBusy] = useState<'save' | 'evidence' | 'pick'>();
  const titleId = useId();
  const statementId = useId();
  const reasonId = useId();
  const [seenRevision, setSeenRevision] = useState(capture.draftRevision);
  // Until the person names the bug, its name follows what they pointed at.
  const [titleEdited, setTitleEdited] = useState(Boolean(capture.draft));

  // A new pick joins the draft with its own check; the person's edits stay.
  if (seenRevision !== capture.draftRevision) {
    setSeenRevision(capture.draftRevision);
    setDraft((current) => {
      const next = captureDraft(capture, current);
      return titleEdited ? next : { ...next, title: capture.suggestedTitle };
    });
  }

  useEffect(() => {
    if (interrupted) return;
    let disposed = false;
    setPreviewPending(true);
    const timer = setTimeout(() => {
      void taskManagerApi.previewBugCapture({ taskId, sessionId, draft }).then(
        (value) => {
          if (disposed) return;
          setPreview(value);
          setPreviewPending(false);
        },
        () => {
          if (!disposed) setPreviewPending(false);
        }
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [taskId, sessionId, draft, capture.draftRevision, interrupted]);

  const save = useMemo(() => captureSaveState(draft, preview, capture, previewPending), [draft, preview, capture, previewPending]);
  const picks = new Map(capture.picks.map((pick) => [pick.index, pick]));
  const valueRows = preview?.valueRows ?? capture.valueRows;
  const requestRows = new Map(capture.requests.map((row) => [row.key, row]));
  const locked = Boolean(busy) || picking || recording.phase === 'SAVING';

  const update = (change: (current: BugCaptureDraft) => BugCaptureDraft) => setDraft((current) => change(current));
  const act = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const submit = (withCheck: boolean) =>
    void act(withCheck ? 'save' : 'evidence', async () => {
      await taskManagerApi.saveBugCapture({ taskId, sessionId, draftRevision: capture.draftRevision, draft, withCheck });
      onSaved(withCheck);
    });

  return (
    <aside className="tm-bugcapture" aria-label="Mark the bug">
      <div className="tm-bugcapture__body">
        {/* An interrupted recording says why beside the page; a partial one says it here. */}
        {capture.partial && recording.phase !== 'INTERRUPTED' ? <p className="tm-bugcapture__notice" role="note">{capture.partial}</p> : null}
        <label className="field">
          <span id={titleId}>Bug</span>
          <input ref={titleRef} aria-labelledby={titleId} value={draft.title} maxLength={200} disabled={locked}
            onChange={(event) => {
              setTitleEdited(true);
              update((current) => ({ ...current, title: event.target.value }));
            }} />
        </label>
        <label className="field">
          <span id={statementId}>What should happen</span>
          <textarea aria-labelledby={statementId} className="tm-bugcapture__statement" value={draft.statement ?? ''} maxLength={2000}
            disabled={locked} placeholder="Optional"
            onChange={(event) => update((current) => ({ ...current, statement: event.target.value || undefined }))} />
        </label>

        {!interrupted ? (
          <section className="tm-bugcapture__group" aria-label="Checks">
            <h3 className="tm-bugcapture__label">Checks</h3>
            {draft.checks.length === 0 ? <p className="tm-bugcapture__muted">No element picked</p> : null}
            {draft.checks.map((check, position) => {
              const pick = picks.get(check.pickIndex);
              if (!pick) return null;
              const textual = check.template === 'equals' || check.template === 'contains';
              return (
                <fieldset key={check.pickIndex} className="tm-bugcheck" disabled={locked}>
                  <legend className="tm-bugcheck__head">
                    <span className="tm-bugcheck__name" title={pick.label}>{pick.label}</span>
                    <Tooltip label="Remove check">
                      <button type="button" className="tm-iconbtn tm-bugcheck__remove" aria-label={`Remove the check on ${pick.label}`}
                        onClick={() => update((current) => ({ ...current, checks: current.checks.filter((_, index) => index !== position) }))}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </legend>
                  <p className="tm-bugcheck__observed">
                    {pick.value !== undefined ? `Holds "${pick.value}"` : pick.text ? `Shows "${pick.text}"` : pick.visible ? 'Visible, no text' : 'Not visible'}
                  </p>
                  <div className="tm-bugcheck__row">
                    <select className="tm-bugcontrol" aria-label={`Check on ${pick.label}`} value={check.template}
                      onChange={(event) => update((current) => ({
                        ...current,
                        checks: current.checks.map((item, index) => index === position ? { ...item, template: event.target.value as typeof item.template } : item)
                      }))}>
                      {CHECK_TEMPLATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {textual ? (
                      <input className="tm-bugcontrol" aria-label={`What ${pick.label} should read`} value={check.expected ?? ''} maxLength={1000}
                        onChange={(event) => update((current) => ({
                          ...current,
                          checks: current.checks.map((item, index) => index === position ? { ...item, expected: event.target.value } : item)
                        }))} />
                    ) : check.template === 'count' ? (
                      <input className="tm-bugcontrol" aria-label={`How many times ${pick.label} should appear`} type="number" min={0} max={1000} value={check.count ?? 1}
                        onChange={(event) => update((current) => ({
                          ...current,
                          checks: current.checks.map((item, index) => index === position ? { ...item, count: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) } : item)
                        }))} />
                    ) : null}
                  </div>
                  <label className="tm-bugcheck__option">
                    <input type="checkbox" checked={check.alsoAfterReload}
                      onChange={(event) => update((current) => ({
                        ...current,
                        checks: current.checks.map((item, index) => index === position ? { ...item, alsoAfterReload: event.target.checked } : item)
                      }))} />
                    <span>Also after reload</span>
                  </label>
                </fieldset>
              );
            })}
            {/* While the page waits for a click, this control stops pointing; it is never a dead end. */}
            <button ref={pointRef} type="button" className="ghost-button button--sm tm-bugcapture__add" disabled={picking ? busy === 'pick' : locked}
              onClick={() => void act('pick', () => (picking
                ? taskManagerApi.stopBugPick({ taskId, sessionId })
                : taskManagerApi.pickBugCheck({ taskId, sessionId, draft })))}>
              <StableLabel label={picking ? 'Stop pointing' : 'Add check'} reserve={['Add check', 'Stop pointing']} />
            </button>
          </section>
        ) : null}

        {!interrupted && capture.requests.length ? (
          <details className="tm-bugcapture__more">
            <summary>
              <DisclosureChevron />
              Requests
              <span className="tm-bugcapture__count">{draft.requestRules.filter((rule) => rule.check !== 'none' || rule.sentOnce).length}/{capture.requests.length}</span>
            </summary>
            <div className="tm-bugcapture__rows">
              {draft.requestRules.map((rule, position) => {
                const row = requestRows.get(rule.requestKey);
                if (!row) return null;
                const write = row.method !== 'GET' && row.method !== 'HEAD';
                return (
                  <div key={rule.requestKey} className="tm-bugreq">
                    <div className="tm-bugreq__line">
                      <code title={`${row.method} ${row.path}`}>{row.method} {row.pathTemplate}</code>
                      <span className={`tm-bugreq__observed${row.succeeded ? '' : ' tm-bugreq__observed--failed'}`}>{row.observed}{row.count > 1 ? ` ×${row.count}` : ''}</span>
                    </div>
                    <div className="tm-bugreq__controls">
                      <select className="tm-bugcontrol" aria-label={`Check on ${row.method} ${row.pathTemplate}`} value={rule.check} disabled={locked}
                        onChange={(event) => update((current) => ({
                          ...current,
                          requestRules: current.requestRules.map((item, index) => index === position ? { ...item, check: event.target.value as typeof item.check } : item)
                        }))}>
                        {REQUEST_CHECK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      {write ? (
                        <label className="tm-bugcheck__option">
                          <input type="checkbox" checked={rule.sentOnce} disabled={locked}
                            onChange={(event) => update((current) => ({
                              ...current,
                              requestRules: current.requestRules.map((item, index) => index === position ? { ...item, sentOnce: event.target.checked } : item)
                            }))} />
                          <span>Sent once</span>
                        </label>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}

        {!interrupted && valueRows.length ? (
          <details className="tm-bugcapture__more">
            <summary>
              <DisclosureChevron />
              Values
              <span className="tm-bugcapture__count">{draft.valueChecks.length}/{valueRows.length}</span>
            </summary>
            <div className="tm-bugcapture__rows">
              {valueRows.map((row) => {
                const request = requestRows.get(row.requestKey);
                const chosen = draft.valueChecks.find((item) => item.requestKey === row.requestKey && item.side === row.side && item.pointer === row.pointer);
                const field = row.pointer.slice(1).replace(/\//g, '.') || 'body';
                const name = `${request ? `${request.method} ${request.pathTemplate}` : 'Request'} ${row.side === 'request' ? 'sends' : 'returns'} ${field}`;
                return (
                  <div key={`${row.requestKey} ${row.side} ${row.pointer}`} className="tm-bugreq">
                    <div className="tm-bugreq__line">
                      <code title={name}>{name}</code>
                      <span className="tm-bugreq__observed">{row.observed}</span>
                    </div>
                    <div className="tm-bugreq__controls">
                      <label className="tm-bugcheck__option">
                        <input type="checkbox" checked={Boolean(chosen)} disabled={locked}
                          onChange={(event) => update((current) => ({
                            ...current,
                            valueChecks: event.target.checked
                              ? [...current.valueChecks, { requestKey: row.requestKey, side: row.side, pointer: row.pointer, expected: row.suggested ?? row.observed }]
                              : current.valueChecks.filter((item) => item !== chosen)
                          }))} />
                        <span>Should be</span>
                      </label>
                      <input aria-label={`Expected value of ${name}`} className="tm-bugcontrol tm-bugreq__value" disabled={locked || !chosen}
                        value={chosen?.expected ?? row.suggested ?? row.observed} maxLength={2000}
                        onChange={(event) => update((current) => ({
                          ...current,
                          valueChecks: current.valueChecks.map((item) => item === chosen ? { ...item, expected: event.target.value } : item)
                        }))} />
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}

        {capture.stepSummaries.length ? (
          <details className="tm-bugcapture__more">
            <summary>
              <DisclosureChevron />
              Steps
              <span className="tm-bugcapture__count">{capture.stepCount}</span>
            </summary>
            <ol className="tm-bugcapture__steps">
              {capture.stepSummaries.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
            </ol>
          </details>
        ) : null}
        {recording.passwordTyped ? (
          <p className="tm-bugcapture__note">The password you typed is kept with this bug so clean runs can type it again. It is hidden wherever the bug is shown.</p>
        ) : null}

        {capture.pageErrors.length ? (
          <details className="tm-bugcapture__more">
            <summary>
              <DisclosureChevron />
              Page errors
              <span className="tm-bugcapture__count">{capture.pageErrors.length}</span>
            </summary>
            <pre className="tm-bugcapture__errors">{capture.pageErrors.join('\n')}</pre>
          </details>
        ) : null}

        {!interrupted && preview?.checks.length ? (
          <section className="tm-bugcapture__group" aria-label="What a clean run checks">
            <h3 className="tm-bugcapture__label">What a clean run checks</h3>
            <ul className="tm-bugcapture__checks">
              {preview.checks.map((check) => (
                <li key={check.id}>
                  <span>{check.statement}</span>
                  {check.recorded ? <span className="tm-bugcapture__recorded">{check.recorded}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <footer className="tm-bugcapture__foot">
        <div className="tm-bugcapture__actions">
          {interrupted ? (
            <>
              {onRecordAgain ? (
                <button type="button" className="outline-button" disabled={locked || restarting} onClick={onRecordAgain}>
                  <StableLabel label={restarting ? 'Starting…' : 'Record again'} reserve={['Record again', 'Starting…']} />
                </button>
              ) : null}
              <button type="button" className="primary-button" disabled={locked || restarting || !save.canSaveEvidence} onClick={() => submit(false)}>
                <StableLabel label={busy === 'evidence' ? 'Saving…' : 'Save without a check'} reserve={['Save without a check', 'Saving…']} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="outline-button" disabled={locked || !save.canSaveEvidence} onClick={() => submit(false)}>
                <StableLabel label={busy === 'evidence' ? 'Saving…' : 'Save without a check'} reserve={['Save without a check', 'Saving…']} />
              </button>
              <button type="button" className="primary-button" disabled={locked || !save.reproducible}
                aria-describedby={save.reason ? reasonId : undefined} onClick={() => submit(true)}>
                <StableLabel label={busy === 'save' ? 'Saving…' : 'Save and reproduce'} reserve={['Save and reproduce', 'Saving…']} />
              </button>
            </>
          )}
        </div>
        {save.reason && !interrupted && !picking ? <p id={reasonId} className="tm-bugcapture__reason">{save.reason}</p> : null}
        {replaces ? <p className="tm-bugcapture__reason">Replaces "{replaces}"</p> : null}
      </footer>
    </aside>
  );
}
