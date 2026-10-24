import { useEffect, useState } from 'react';
import { ActionButtonTitle } from './ActionButtonTitle';
import { formatClock } from '../model/timeAgo';
import type { Tone } from '../model/viewTypes';
import { StatusGlyph, statusGlyphFor } from './StatusBadge';

/**
 * Shared header for long-running agent operations: one semantic status mark,
 * the operation name, optional scope, elapsed time, and an optional stop action.
 */
export function RunHeader({
  running,
  tone,
  operationName,
  scope,
  startedAt,
  onStop,
  stopDisabled,
  stopTitle,
  trailingLabel
}: {
  running: boolean;
  tone: Tone;
  operationName: string;
  scope?: string;
  startedAt?: string;
  onStop?: () => void;
  stopDisabled?: boolean;
  stopTitle?: string;
  trailingLabel?: string;
}) {
  const elapsed = useElapsed(startedAt, running);
  return (
    <div className="tm-runheader">
      <StatusGlyph kind={statusGlyphFor(tone, running) ?? 'idle'} />
      <h3 className={`tm-runheader__name${running ? ' tm-shimmer' : ''}`}>{operationName}</h3>
      {scope ? <span className="tm-runheader__scope">{scope}</span> : null}
      <span className="tm-runheader__spacer" />
      {running && elapsed !== undefined ? (
        <span
          className="tm-runheader__elapsed"
          aria-label={`Elapsed ${formatClock(elapsed)}`}
        >
          {formatClock(elapsed)}
        </span>
      ) : null}
      {running && onStop ? (
        <ActionButtonTitle disabled={stopDisabled} title={stopTitle}>
          <button
            type="button"
            className="danger-button button--sm tm-runheader__stop"
            disabled={stopDisabled}
            onClick={onStop}
          >
            Stop
          </button>
        </ActionButtonTitle>
      ) : null}
      {!running && trailingLabel ? (
        <span className="tm-runheader__trailing">{trailingLabel}</span>
      ) : null}
    </div>
  );
}

function useElapsed(startedAt: string | undefined, active: boolean): number | undefined {
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const hasStart = Number.isFinite(startMs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !hasStart) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, hasStart, startMs]);

  if (!hasStart) {
    return undefined;
  }
  return Math.max(0, now - startMs);
}
