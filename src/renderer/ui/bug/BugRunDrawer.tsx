import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { BugCaseView, BugReplayRunView, BugShotView } from '../../../shared/bugReplay';
import { bugRunRows, formatDuration, runStepList } from '../../model/bugReplay';
import { useDialogFocusBoundary } from '../dialogFocus';
import { useLayerProps } from '../presence';
import { PlanList } from '../Plan';
import { StatusGlyph, statusGlyphFor } from '../StatusBadge';
import { formatTaskActivityTimestamp } from '../TaskActivityPanel';
import { Tooltip } from '../Tooltip';
import { BugPicture } from './BugShots';

/**
 * One replay, opened from its row: what it ran on and how long it took, how the page ended
 * with each checked element outlined, what each expectation saw, how far the steps got, and
 * the facts about where it ran. Escape, the close button or a click beside it closes it.
 */
export function BugRunDrawer({
  taskId,
  run,
  view,
  viewport,
  onClose
}: {
  taskId: string;
  run: BugReplayRunView;
  view: BugCaseView;
  viewport: { width: number; height: number };
  onClose(): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The replay is read, not filled in: focus starts on what scrolls, so the keys read it and one
  // Escape closes it (the close button's tooltip never opens first).
  useDialogFocusBoundary({ dialogRef: panelRef, initialFocusRef: bodyRef, busy: false, onClose });
  const layer = useLayerProps();
  const row = bugRunRows([run])[0];
  const glyph = row ? statusGlyphFor(row.tone, row.inFlight) : undefined;
  const checks = view.version?.checks ?? [];
  const byId = new Map(run.observations.map((observation) => [observation.assertionId, observation]));
  const shotId = run.screenshotFileIds[run.screenshotFileIds.length - 1];
  const shot: BugShotView | undefined = shotId
    ? { fileId: shotId, runId: run.id, at: run.settledAt ?? run.queuedAt, boxes: run.observations.flatMap((observation) => (observation.box ? [{ checkId: observation.assertionId, box: observation.box }] : [])) }
    : undefined;
  const steps = runStepList(view.steps, run);
  const reached = run.state === 'SETTLED' && run.observations.length > 0;
  const quietOutcome = run.outcome === 'PASSED' || run.outcome === 'REPRODUCED' || run.outcome === 'CANCELED' || run.outcome === 'SUPERSEDED';
  const facts = [...run.facts, ...(view.scopeLine ? [view.scopeLine] : []), ...(view.boundaryLine ? [view.boundaryLine] : [])];
  if (!row) return null;
  // Fixed layers render at the document, so no size container on the page becomes their frame.
  return createPortal(
    <div {...layer} className="tm-bugdrawer">
      <div className="tm-bugdrawer__scrim" onClick={onClose} />
      <aside ref={panelRef} className="tm-bugdrawer__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="tm-bugdrawer__head">
          <h3 id={titleId} className="tm-bugdrawer__title">{row.kind === 'After' ? 'Replay after the fix' : 'Replay before the fix'}</h3>
          <span className={`tm-bugdrawer__word tm-bug__state--${row.tone}`}>
            {glyph ? <StatusGlyph kind={glyph} /> : null}
            {row.word}
          </span>
          <Tooltip label="Close">
            <button type="button" className="tm-iconbtn tm-bugdrawer__close" aria-label="Close replay" onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        <div ref={bodyRef} className="tm-bugdrawer__body" tabIndex={0}>
          <p className="tm-bugdrawer__meta">
            <time dateTime={row.at}>{formatTaskActivityTimestamp(row.at).label}</time>
            {row.durationMs !== undefined ? <span>{formatDuration(row.durationMs)}</span> : null}
            {run.treeId ? <code title={run.treeId}>{run.treeId.slice(0, 8)}</code> : null}
          </p>
          {/* A failure or a step owed is a notice in its tone; anything else is the run's own line. */}
          {row.detail && !quietOutcome ? (
            row.tone === 'error' || row.tone === 'action'
              ? <p className="tm-notice" data-tone={row.tone === 'action' ? 'waiting' : undefined}>{row.detail}</p>
              : <p className="tm-bugdrawer__detail">{row.detail}</p>
          ) : null}

          {shot ? (
            // In block flow, so the drawer's grid row takes the picture's full height.
            <div className="tm-bugdrawer__shot">
              <BugPicture taskId={taskId} shot={shot} viewport={viewport} aspect={viewport.width / viewport.height} label="The page at the end of the replay" />
            </div>
          ) : null}

          {checks.length && reached ? (
            <section className="tm-bugdrawer__section" aria-label="Expected">
              <h4 className="tm-bugdrawer__label">Expected</h4>
              <ul className="tm-bugresults">
                {checks.map((check) => {
                  const observation = byId.get(check.id);
                  if (!observation) return null;
                  return (
                    <li key={check.id} className="tm-bugresult" data-held={observation.passed ? '' : undefined}>
                      <ResultMark held={observation.passed} />
                      <span className="tm-bugresult__statement">{check.statement}</span>
                      <span className="tm-bugresult__value" title={observation.observed}>{observation.value ?? observation.observed ?? ''}</span>
                      {observation.afterReload ? (
                        <span className="tm-bugresult__reload">
                          After reload: {observation.afterReload.value ?? observation.afterReload.observed ?? (observation.afterReload.passed ? 'held' : 'did not hold')}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {view.steps.length ? (
            <section className="tm-bugdrawer__section" aria-label="Steps">
              <h4 className="tm-bugdrawer__label">Steps</h4>
              <PlanList
                steps={steps.steps}
                marker={steps.failedIndex !== undefined ? { index: steps.failedIndex, kind: 'failed' } : undefined}
              />
            </section>
          ) : null}

          {facts.length ? (
            <section className="tm-bugdrawer__section" aria-label="Where it ran">
              <h4 className="tm-bugdrawer__label">Where it ran</h4>
              <ul className="tm-bugdrawer__facts">
                {facts.map((fact) => <li key={fact}>{fact}</li>)}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body
  );
}

/** Whether an expectation held, by its shape: a check, or a cross. */
export function ResultMark({ held, quiet = false }: { held: boolean; quiet?: boolean }) {
  return (
    <span className={`tm-bugresult__mark${quiet ? ' tm-bugresult__mark--quiet' : ''}`} data-held={held ? '' : undefined}>
      <StatusGlyph kind={held ? 'verified' : 'blocked'} />
      <span className="tm-visually-hidden">{held ? 'Held' : 'Did not hold'}</span>
    </span>
  );
}
