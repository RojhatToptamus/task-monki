import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Plus } from 'lucide-react';
import type { BugCaptureDraft, BugCapturePreview, BugCaptureView, BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { captureDraft, captureSaveState, suggestedCaptureTitle } from '../../model/bugReplay';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { useArrivals } from '../arrivals';
import { DisclosureChevron } from '../DisclosureChevron';
import { StableLabel } from '../StableLabel';
import { BugStepIcon } from './BugStepIcon';
import { ElementExpectation, FixedExpectation, RequestExpectation, ValueExpectation } from './BugExpectationRows';

const PREVIEW_DELAY_MS = 250;
const MAX_PICKS = 5;

/**
 * Mark the bug: its name, then what should be true, one row per expectation (an element on the
 * page, a request the action sent, a page error), then the steps a replay takes. Saving is the
 * person's approval of the expectations; nothing is checked that is not listed here.
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
  /** Stop pointing, which takes Add expectation's place while the page waits for a pick. */
  pointRef?: RefObject<HTMLButtonElement | null>;
  onError(message: string): void;
  onSaved(withCheck: boolean): void;
  /** A stopped recording: record it again instead of keeping these steps. */
  onRecordAgain?(): void;
  restarting?: boolean;
}) {
  const sessionId = recording.sessionId;
  const interrupted = recording.phase === 'INTERRUPTED';
  // Until the person names the bug, its name follows the first expectation. A stored draft says
  // nothing on its own (pointing at an element stores one): only a name that is not the one its
  // expectations suggest is the person's, so the name keeps following after a remount.
  const [titleEdited, setTitleEdited] = useState(() => namedByPerson(capture));
  const [draft, setDraft] = useState<BugCaptureDraft>(() => {
    const initial = captureDraft(capture);
    return namedByPerson(capture) ? initial : { ...initial, title: suggestedCaptureTitle(capture, initial) };
  });
  const [preview, setPreview] = useState<BugCapturePreview>();
  const [busy, setBusy] = useState<'save' | 'evidence' | 'pick'>();
  const titleId = useId();
  const notesId = useId();
  const expectedId = useId();
  const reasonId = useId();
  const [seenRevision, setSeenRevision] = useState(capture.draftRevision);
  const valueRefs = useRef(new Map<number, HTMLInputElement>());
  const [focusPick, setFocusPick] = useState<number>();

  // A new pick joins the draft with its own expectation; the person's edits stay, and the
  // new row's value takes focus with its text selected, ready to be typed over.
  if (seenRevision !== capture.draftRevision) {
    setSeenRevision(capture.draftRevision);
    const known = new Set(draft.checks.map((check) => check.pickIndex));
    const next = captureDraft(capture, draft);
    const added = next.checks.find((check) => !known.has(check.pickIndex));
    setDraft(titleEdited ? next : { ...next, title: suggestedCaptureTitle(capture, next) });
    if (added) setFocusPick(added.pickIndex);
  }

  useLayoutEffect(() => {
    if (focusPick === undefined) return;
    const input = valueRefs.current.get(focusPick);
    if (!input) return;
    input.focus();
    input.select();
    setFocusPick(undefined);
  }, [focusPick]);

  // Stop pointing and Add expectation take each other's place; focus moves to the one that is
  // there now, unless a new expectation's value took it.
  const addRef = useRef<HTMLButtonElement>(null);
  const wasPicking = useRef(picking);
  useLayoutEffect(() => {
    const before = wasPicking.current;
    wasPicking.current = picking;
    if (before === picking) return;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (picking && (lost || active === addRef.current)) pointRef?.current?.focus({ preventScroll: true });
    else if (!picking && lost) addRef.current?.focus({ preventScroll: true });
  }, [picking, pointRef]);

  // Every pause in typing sends the draft, so the service keeps the name and notes too and a
  // remount finds them. The verdict stands while the next one is on its way (captureSaveState),
  // so naming the bug never changes the foot.
  const draftKey = JSON.stringify(draft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (interrupted) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void taskManagerApi.previewBugCapture({ taskId, sessionId, draft: draftRef.current }).then(
        (value) => {
          if (!disposed) setPreview(value);
        },
        // A preview that failed leaves the last verdict; saving checks the draft again.
        () => undefined
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [taskId, sessionId, draftKey, capture.draftRevision, interrupted]);

  const save = useMemo(() => captureSaveState(draft, preview, capture), [draft, preview, capture]);
  const picks = new Map(capture.picks.map((pick) => [pick.index, pick]));
  const valueRows = preview?.valueRows ?? capture.valueRows;
  const requestRows = new Map(capture.requests.map((row) => [row.key, row]));
  const saving = Boolean(busy && busy !== 'pick') || recording.phase === 'SAVING';

  // Every edit to the expectations keeps the name in step until the person names the bug.
  const update = (change: (current: BugCaptureDraft) => BugCaptureDraft) =>
    setDraft((current) => {
      const next = change(current);
      return titleEdited ? next : { ...next, title: suggestedCaptureTitle(capture, next) };
    });
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
  const point = () => void act('pick', () => taskManagerApi.pickBugCheck({ taskId, sessionId, draft }));

  const shownRules = draft.requestRules
    .map((rule, position) => ({ rule, position, row: requestRows.get(rule.requestKey) }))
    .filter((entry) => entry.row && (entry.rule.check !== 'none' || entry.rule.sentOnce));
  const unusedRules = draft.requestRules
    .map((rule, position) => ({ rule, position, row: requestRows.get(rule.requestKey) }))
    .filter((entry) => entry.row && entry.rule.check === 'none' && !entry.rule.sentOnce);
  const unusedValues = valueRows
    .filter((row) => !draft.valueChecks.some((item) => item.requestKey === row.requestKey && item.side === row.side && item.pointer === row.pointer))
    .slice(0, 12);
  const addItems: ActionMenuItem[] = [
    {
      label: 'Point at an element',
      disabled: capture.picks.length >= MAX_PICKS,
      ...(capture.picks.length >= MAX_PICKS ? { disabledReason: `${MAX_PICKS} elements at most` } : {}),
      onSelect: point
    },
    ...(capture.pageErrors.length && !draft.noPageError
      ? [{ label: 'No page error', separated: true, onSelect: () => update((current) => ({ ...current, noPageError: true })) }]
      : []),
    ...unusedRules.map((entry, index) => ({
      label: `${entry.row!.method} ${entry.row!.pathTemplate}`,
      meta: entry.row!.observed,
      separated: index === 0,
      onSelect: () => update((current) => ({
        ...current,
        requestRules: current.requestRules.map((item, position) => (position === entry.position ? { ...item, check: 'answered' as const } : item))
      }))
    })),
    ...unusedValues.map((row, index) => ({
      label: valueName(row, requestRows.get(row.requestKey)),
      meta: row.observed,
      separated: index === 0,
      onSelect: () => update((current) => ({
        ...current,
        valueChecks: [...current.valueChecks, { requestKey: row.requestKey, side: row.side, pointer: row.pointer, expected: row.suggested ?? row.observed }]
      }))
    }))
  ];
  const expectationCount = draft.checks.length + shownRules.length + draft.valueChecks.length + (draft.noPageError ? 1 : 0);
  const arrived = useArrivals([
    ...draft.checks.map((check) => `pick:${check.pickIndex}`),
    ...(draft.noPageError ? ['console'] : []),
    ...shownRules.map(({ rule }) => `request:${rule.requestKey}`),
    ...draft.valueChecks.map((chosen) => `value:${chosen.requestKey} ${chosen.side} ${chosen.pointer}`)
  ]);

  return (
    <aside className="tm-bugcapture" aria-label="Mark the bug">
      <div className="tm-bugcapture__body">
        {/* An interrupted recording says why in the page's place; a partial one says it here. */}
        {capture.partial && !interrupted ? <p className="tm-bugcapture__notice" role="note">{capture.partial}</p> : null}
        <label className="field">
          <span id={titleId}>Bug</span>
          <input ref={titleRef} aria-labelledby={titleId} value={draft.title} maxLength={200} disabled={saving} placeholder="Name the bug"
            onChange={(event) => {
              setTitleEdited(true);
              setDraft((current) => ({ ...current, title: event.target.value }));
            }} />
        </label>
        <label className="field">
          <span id={notesId}>Notes</span>
          <textarea aria-labelledby={notesId} className="tm-bugcapture__notes" value={draft.statement ?? ''} maxLength={2000}
            disabled={saving} placeholder="Optional"
            onChange={(event) => setDraft((current) => ({ ...current, statement: event.target.value || undefined }))} />
        </label>

        {!interrupted ? (
          <section className="tm-bugexpect" aria-labelledby={expectedId}>
            <div className="tm-bugexpect__head">
              <h3 id={expectedId} className="tm-bugexpect__title">Expected</h3>
              {picking ? (
                // While the page waits for a click, this control stops pointing; it is never a dead end.
                <button ref={pointRef} type="button" className="ghost-button button--sm tm-bugexpect__stop" disabled={busy === 'pick'}
                  onClick={() => void act('pick', () => taskManagerApi.stopBugPick({ taskId, sessionId }))}>
                  <StableLabel label="Stop pointing" reserve={['Stop pointing', 'Add expectation']} />
                </button>
              ) : (
                <ActionMenu className="tm-bugexpect__add" label="Add expectation" side="bottom" align="end" disabled={saving} triggerRef={addRef}
                  trigger={<><Plus size={13} aria-hidden="true" /><span>Add expectation</span></>}
                  items={addItems} />
              )}
            </div>
            {expectationCount === 0 ? (
              <p className="tm-bugexpect__empty">{picking ? 'Pick the part of the page that is wrong' : 'No expectations'}</p>
            ) : (
              <ul className="tm-bugexpect__list">
                {draft.checks.map((check, position) => {
                  const pick = picks.get(check.pickIndex);
                  if (!pick) return null;
                  const shown = pick.value !== undefined ? `Held "${pick.value}"` : pick.text ? `Showed "${pick.text}"` : pick.visible ? 'Visible, no text' : 'Not visible';
                  return (
                    <ElementExpectation key={check.pickIndex} badge={check.pickIndex + 1} name={pick.label} shown={shown} value={check}
                      disabled={saving} arrived={arrived(`pick:${check.pickIndex}`)}
                      valueRef={(element) => {
                        if (element) valueRefs.current.set(check.pickIndex, element);
                        else valueRefs.current.delete(check.pickIndex);
                      }}
                      onChange={(next) => update((current) => ({
                        ...current,
                        checks: current.checks.map((item, index) => (index === position ? { ...item, ...next } : item))
                      }))}
                      onRemove={() => update((current) => ({ ...current, checks: current.checks.filter((_, index) => index !== position) }))} />
                  );
                })}

                {draft.noPageError ? (
                  <FixedExpectation name="No page error" removeLabel="Remove the page error expectation" disabled={saving} arrived={arrived('console')}
                    was={capture.uncaughtError ? 'The last step raised an error' : 'The last step raised no error'}
                    onRemove={() => update((current) => ({ ...current, noPageError: false }))} />
                ) : null}

                {shownRules.map(({ rule, position, row }) => {
                  const request = row!;
                  const write = request.method !== 'GET' && request.method !== 'HEAD';
                  const setRule = (change: Partial<typeof rule>) => update((current) => ({
                    ...current,
                    requestRules: current.requestRules.map((item, index) => (index === position ? { ...item, ...change } : item))
                  }));
                  const answered = request.observed === 'no response' ? 'Got no response' : `Returned ${request.observed}`;
                  return (
                    <RequestExpectation key={rule.requestKey} name={`${request.method} ${request.pathTemplate}`} title={`${request.method} ${request.path}`}
                      observed={`${answered}${request.count > 1 ? ` ×${request.count}` : ''}`} failed={!request.succeeded}
                      check={rule.check} sentOnce={write ? rule.sentOnce : undefined} disabled={saving} arrived={arrived(`request:${rule.requestKey}`)}
                      onCheck={(check) => setRule({ check })}
                      onSentOnce={(sentOnce) => setRule({ sentOnce })}
                      onRemove={() => setRule({ check: 'none', sentOnce: false })} />
                  );
                })}

                {draft.valueChecks.map((chosen) => {
                  const row = valueRows.find((candidate) => candidate.requestKey === chosen.requestKey && candidate.side === chosen.side && candidate.pointer === chosen.pointer);
                  const name = row ? valueName(row, requestRows.get(row.requestKey)) : chosen.pointer;
                  return (
                    <ValueExpectation key={`${chosen.requestKey} ${chosen.side} ${chosen.pointer}`} name={name} was={row ? `Was ${row.observed}` : undefined}
                      expected={chosen.expected} disabled={saving} arrived={arrived(`value:${chosen.requestKey} ${chosen.side} ${chosen.pointer}`)}
                      onExpected={(expected) => update((current) => ({
                        ...current,
                        valueChecks: current.valueChecks.map((item) => (item === chosen ? { ...item, expected } : item))
                      }))}
                      onRemove={() => update((current) => ({ ...current, valueChecks: current.valueChecks.filter((item) => item !== chosen) }))} />
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {capture.steps.length ? (
          <details className="tm-bugcapture__more" open={interrupted || undefined}>
            <summary>
              <DisclosureChevron />
              Steps
              <span className="tm-bugcapture__count">{capture.stepCount}</span>
            </summary>
            <ol className="tm-bugsteps">
              {capture.steps.map((step, index) => (
                <li key={`${index}:${step.text}`} className="tm-bugstep" data-kind={step.kind}>
                  <span className="tm-bugstep__number" aria-hidden="true">{index + 1}</span>
                  <BugStepIcon kind={step.kind} />
                  <span className="tm-bugstep__text" title={step.text}>{step.text}</span>
                </li>
              ))}
            </ol>
          </details>
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

        {recording.passwordTyped ? <p className="tm-bugcapture__note">Replays type the password you entered. It is never shown.</p> : null}
      </div>
      <footer className="tm-bugcapture__foot">
        {/* Its own line: beside the buttons the panel's width would leave it a few letters. */}
        {replaces ? <p className="tm-bugcapture__replaces" title={replaces}>Replaces “{replaces}”</p> : null}
        <div className="tm-bugcapture__actions">
          {interrupted ? (
            <>
              {onRecordAgain ? (
                <button type="button" className="outline-button" disabled={saving || restarting} onClick={onRecordAgain}>
                  <StableLabel label={restarting ? 'Starting…' : 'Record again'} reserve={['Record again', 'Starting…']} />
                </button>
              ) : null}
              <button type="button" className="primary-button" disabled={saving || restarting || !save.canSaveEvidence} onClick={() => submit(false)}>
                <StableLabel label={busy === 'evidence' ? 'Saving…' : 'Save steps only'} reserve={['Save steps only', 'Saving…']} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="outline-button" disabled={saving || picking || !save.canSaveEvidence} onClick={() => submit(false)}>
                <StableLabel label={busy === 'evidence' ? 'Saving…' : 'Save steps only'} reserve={['Save steps only', 'Saving…']} />
              </button>
              <button type="button" className="primary-button" disabled={saving || picking || !save.reproducible}
                aria-describedby={save.reason ? reasonId : undefined} onClick={() => submit(true)}>
                <StableLabel label={busy === 'save' ? 'Saving…' : 'Save and reproduce'} reserve={['Save and reproduce', 'Saving…']} />
              </button>
            </>
          )}
        </div>
        {save.reason && !interrupted && !picking ? <p id={reasonId} className="tm-bugcapture__reason">{save.reason}</p> : null}
      </footer>
    </aside>
  );
}

/** The stored draft's name is the person's: written, and not the one its expectations suggest. */
function namedByPerson(capture: BugCaptureView): boolean {
  const stored = capture.draft;
  return Boolean(stored?.title.trim() && stored.title !== suggestedCaptureTitle(capture, stored));
}

/** A JSON value a request sent or got back, by its request and field: "POST /api/cart returns total". */
function valueName(row: { side: 'request' | 'response'; pointer: string }, request: { method: string; pathTemplate: string } | undefined): string {
  const field = row.pointer.slice(1).replace(/\//g, '.') || 'body';
  return `${request ? `${request.method} ${request.pathTemplate}` : 'The request'} ${row.side === 'request' ? 'sends' : 'returns'} ${field}`;
}
