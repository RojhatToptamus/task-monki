import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { BugCaseView, BugExpectationsPreview } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import {
  expectationsDraft,
  expectationsSaveState,
  keepExpectation,
  openExpectationsEditor,
  removeExpectationRow,
  shownExpectationRows,
  updateExpectationRow,
  type ExpectationsEditor
} from '../../model/bugReplay';
import { useDialogFocusBoundary } from '../dialogFocus';
import { useLayerProps } from '../presence';
import { PendingLabel } from '../StableLabel';
import { ElementExpectation, FixedExpectation, RequestExpectation, ValueExpectation } from './BugExpectationRows';

const PREVIEW_DELAY_MS = 250;

/**
 * A saved bug's expectations, changed in place of recording it again: each row as the capture
 * panel listed it, with what the recording showed. Saving makes the bug's next version, which is
 * reproduced on the recorded code before a fix counts against it; every change is checked against
 * the recording first, and the reason a draft cannot be saved stands beside Save. Escape, Cancel
 * or a click beside it closes it and keeps nothing.
 */
export function BugExpectationsDrawer({
  taskId,
  version,
  returnFocus,
  returnFocusRef,
  onClose,
  onSaved
}: {
  taskId: string;
  version: NonNullable<BugCaseView['version']>;
  /** The control that opened the drawer, where focus returns. */
  returnFocus?: HTMLElement | null;
  /** Where focus goes instead when that control is gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  onSaved(): void;
}) {
  const layer = useLayerProps();
  const panelRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const reasonId = useId();
  const [opened] = useState(() => openExpectationsEditor(version));
  const [editor, setEditor] = useState<ExpectationsEditor>(opened);
  const [preview, setPreview] = useState<BugExpectationsPreview>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The editor is a form: focus starts on the first value to change.
  useDialogFocusBoundary({ dialogRef: panelRef, initialFocusRef: firstFieldRef, returnFocus, fallbackReturnFocusRef: returnFocusRef, busy: saving, onClose });

  const draft = expectationsDraft(editor);
  const draftKey = JSON.stringify(draft);
  const changed = draftKey !== JSON.stringify(expectationsDraft(opened));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Every pause in typing asks whether the recording still shows a bug against the draft.
  useEffect(() => {
    if (!changed) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void taskManagerApi.previewBugExpectations({ taskId, draft: draftRef.current }).then(
        (value) => {
          if (!disposed) setPreview(value);
        },
        // A preview that failed leaves the last answer; saving checks the draft again.
        () => undefined
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [taskId, draftKey, changed]);

  const state = expectationsSaveState(changed, changed ? preview : undefined);
  const reason = error ?? state.reason;
  const edit = (next: ExpectationsEditor) => {
    setEditor(next);
    setError(undefined);
  };
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await taskManagerApi.saveBugExpectations({ taskId, draft });
      onSaved();
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, ''));
    } finally {
      setSaving(false);
    }
  };
  const removed = new Set(editor.removed);
  const rows = shownExpectationRows(editor);

  // Fixed layers render at the document, so no size container on the page becomes their frame.
  return createPortal(
    <div {...layer} className="tm-bugdrawer">
      <div className="tm-bugdrawer__scrim" onClick={saving ? undefined : onClose} />
      <aside ref={panelRef} className="tm-bugdrawer__panel tm-bugdrawer__panel--form" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        data-pending={saving || undefined}>
        <header className="tm-bugdrawer__head">
          <h3 id={titleId} className="tm-bugdrawer__title">Edit expectations</h3>
        </header>
        <div className="tm-bugdrawer__body">
          {rows.length === 0 ? (
            <p className="tm-bugexpect__empty">No expectations</p>
          ) : (
            <ul className="tm-bugexpect__list"
              ref={(list) => {
                // The first row's value to type over, or its choice when it has no value.
                const controls = list?.querySelector('.tm-bugexpect__controls');
                firstFieldRef.current = controls?.querySelector<HTMLElement>('input:not([type="checkbox"])') ?? controls?.querySelector<HTMLElement>('select, input') ?? null;
              }}>
              {rows.map(({ row, index }) => {
                switch (row.kind) {
                  case 'element':
                    return (
                      <ElementExpectation key={row.id} name={row.name} shown={row.recorded} value={row} disabled={saving}
                        onChange={(next) => edit(updateExpectationRow(editor, index, { ...row, ...next }))}
                        onRemove={() => edit(removeExpectationRow(editor, row))} />
                    );
                  case 'request': {
                    const status = row.status;
                    const statusKept = Boolean(status && !removed.has(status.id));
                    return (
                      <RequestExpectation key={status?.id ?? row.sentOnceId} name={row.name} observed={row.recorded} failed={row.failed}
                        check={status ? (statusKept ? status.check : 'none') : undefined}
                        anyStatus={!row.valueIds.some((id) => !removed.has(id))}
                        sentOnce={row.sentOnceId ? !removed.has(row.sentOnceId) : undefined}
                        disabled={saving}
                        onCheck={(check) => {
                          if (!status) return;
                          const kept = keepExpectation(editor, status.id, check !== 'none');
                          edit(check === 'none' ? kept : updateExpectationRow(kept, index, { ...row, status: { ...status, check } }));
                        }}
                        onSentOnce={(sentOnce) => row.sentOnceId && edit(keepExpectation(editor, row.sentOnceId, sentOnce))}
                        onRemove={() => edit(removeExpectationRow(editor, row))} />
                    );
                  }
                  case 'value':
                    return (
                      <ValueExpectation key={row.id} name={row.name} was={row.recorded} expected={row.expected} disabled={saving}
                        onExpected={(expected) => edit(updateExpectationRow(editor, index, { ...row, expected }))}
                        onRemove={() => edit(removeExpectationRow(editor, row))} />
                    );
                  case 'pageError':
                    return (
                      <FixedExpectation key={row.id} name="No page error" was={row.recorded} removeLabel="Remove the page error expectation" disabled={saving}
                        onRemove={() => edit(removeExpectationRow(editor, row))} />
                    );
                }
              })}
            </ul>
          )}
        </div>
        {/* The reason sits beside the actions, so the actions never move when it comes or goes. */}
        <footer className="tm-bugdrawer__foot">
          <p id={reasonId} className="tm-bugdrawer__reason" data-error={error ? '' : undefined}>{reason}</p>
          <div className="tm-bugdrawer__actions">
            <button type="button" className="outline-button" disabled={saving} onClick={onClose}>Cancel</button>
            <button type="button" className="primary-button" disabled={saving || !state.canSave}
              aria-describedby={reason ? reasonId : undefined} onClick={() => void save()}>
              <PendingLabel label="Save and reproduce" pendingLabel="Saving…" pending={saving} />
            </button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body
  );
}
