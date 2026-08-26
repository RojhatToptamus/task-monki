import { useEffect, useState } from 'react';
import { ActionButtonTitle } from './ActionButtonTitle';
import type { Tone } from '../model/viewTypes';
import { StatusGlyph, statusKindForTone } from './StatusBadge';

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
  trailingLabel,
  pulse
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
  /** Animate the working mark. Defaults to `running`; pass false to hold it still. */
  pulse?: boolean;
}) {
  const elapsed = useElapsed(startedAt, running);
  const animate = pulse ?? running;
  return (
    <div className="tm-runheader">
      <StatusGlyph
        kind={statusKindForTone(tone, running)}
        animate={animate}
      />
      <h3 className="tm-runheader__name">{operationName}</h3>
      {scope ? <span className="tm-runheader__scope">{scope}</span> : null}
      <span className="tm-runheader__spacer" />
      {running && elapsed !== undefined ? (
        <span
          className="tm-runheader__elapsed"
          aria-label={`Elapsed ${formatElapsed(elapsed)}`}
        >
          {formatElapsed(elapsed)}
        </span>
      ) : null}
      {running && onStop ? (
        <ActionButtonTitle disabled={stopDisabled} title={stopTitle}>
          <button
            type="button"
            className="outline-button outline-button--danger tm-runheader__stop"
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

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
