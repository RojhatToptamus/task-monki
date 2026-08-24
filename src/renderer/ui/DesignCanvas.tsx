import { useLayoutEffect, useRef, useState } from 'react';
import type {
  HideDesignCanvasRequest,
  RefreshDesignCanvasRequest,
  ShowDesignCanvasRequest
} from '../../shared/designCanvas';
import {
  designCanvasPresentation,
  finiteDesignCanvasBounds,
  type DesignProjectDetail
} from '../model/designs';

export type DesignCanvasShowRequest = ShowDesignCanvasRequest;
export type DesignCanvasHideRequest = HideDesignCanvasRequest;
export type DesignCanvasRefreshRequest = RefreshDesignCanvasRequest;

export interface DesignCanvasProps {
  project: DesignProjectDetail;
  desktopAvailable: boolean;
  occluded?: boolean;
  onShowCanvas?(request: DesignCanvasShowRequest): void;
  onHideCanvas?(request: DesignCanvasHideRequest): void;
  onRefresh(request: DesignCanvasRefreshRequest): Promise<void>;
  onRestart(designId: string): Promise<void>;
}

let canvasRequestSequence = 0;

function nextCanvasRequestId(): number {
  canvasRequestSequence += 1;
  return canvasRequestSequence;
}

export function DesignCanvas({
  project,
  desktopAvailable,
  occluded = false,
  onShowCanvas,
  onHideCanvas,
  onRefresh,
  onRestart
}: DesignCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const operationRef = useRef<'refresh' | 'restart' | undefined>(undefined);
  const [operation, setOperation] = useState<'refresh' | 'restart' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const presentation = designCanvasPresentation({ project, desktopAvailable, occluded });
  const generationId = presentation.kind === 'NATIVE' ? presentation.target.generationId : undefined;
  const routeId = presentation.kind === 'NATIVE' ? presentation.target.routeId : undefined;
  const latestTurnOutcome = project.turns.at(-1)?.outcome;

  useLayoutEffect(() => {
    if (!generationId || !routeId || !onShowCanvas) {
      onHideCanvas?.({ designId: project.design.id, requestId: nextCanvasRequestId() });
      return;
    }

    const host = hostRef.current;
    if (!host) {
      onHideCanvas?.({ designId: project.design.id, requestId: nextCanvasRequestId() });
      return;
    }

    let frame: number | undefined;
    let scheduled = false;
    const report = () => {
      const bounds = finiteDesignCanvasBounds(host.getBoundingClientRect());
      if (!bounds) {
        onHideCanvas?.({ designId: project.design.id, requestId: nextCanvasRequestId() });
        return;
      }
      onShowCanvas({
        designId: project.design.id,
        taskId: project.task.id,
        generationId,
        routeId,
        requestId: nextCanvasRequestId(),
        bounds
      });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      frame = window.requestAnimationFrame(() => {
        scheduled = false;
        report();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      onHideCanvas?.({ designId: project.design.id, requestId: nextCanvasRequestId() });
    };
  }, [
    generationId,
    onHideCanvas,
    onShowCanvas,
    project.design.id,
    project.task.id,
    routeId,
    latestTurnOutcome
  ]);

  const runOperation = async (kind: 'refresh' | 'restart') => {
    if (operationRef.current) return;
    operationRef.current = kind;
    setOperation(kind);
    setError(undefined);
    try {
      if (kind === 'refresh') {
        if (!generationId) throw new Error('No ready preview is available to refresh.');
        await onRefresh({
          designId: project.design.id,
          generationId,
          requestId: nextCanvasRequestId()
        });
      } else {
        await onRestart(project.design.id);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : kind === 'refresh'
            ? 'Could not refresh the preview.'
            : 'Could not restart the preview.'
      );
    } finally {
      operationRef.current = undefined;
      setOperation(undefined);
    }
  };

  return (
    <section className="tm-design-canvas" aria-labelledby="design-canvas-title">
      <header className="tm-design-canvas__toolbar">
        <div>
          <h2 id="design-canvas-title">Canvas</h2>
          <span>Ready preview</span>
        </div>
        {presentation.kind === 'NATIVE' ? (
          <button
            type="button"
            className="tm-design-canvas__refresh"
            disabled={operation !== undefined}
            onClick={() => void runOperation('refresh')}
          >
            <RefreshIcon busy={operation === 'refresh'} />
            <span>{operation === 'refresh' ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        ) : null}
      </header>

      <div className="tm-design-canvas__stage">
        {presentation.kind === 'NATIVE' ? (
          <div
            ref={hostRef}
            className="tm-design-canvas__native-host"
            aria-label={`${project.design.title} preview`}
          >
            <span className="tm-visually-hidden">
              The interactive preview is displayed in the isolated desktop canvas.
            </span>
          </div>
        ) : presentation.kind === 'HIDDEN' ? (
          <div className="tm-design-canvas__placeholder" aria-live="polite">
            <CanvasGlyph state="hidden" />
            <strong>{presentation.title}</strong>
            <span>{presentation.detail}</span>
          </div>
        ) : presentation.kind === 'DESKTOP_ONLY' ? (
          <div className="tm-design-canvas__placeholder" aria-live="polite">
            <CanvasGlyph state="desktop" />
            <strong>{presentation.title}</strong>
            <span>{presentation.detail}</span>
          </div>
        ) : (
          <div className="tm-design-canvas__placeholder" aria-live="polite">
            <CanvasGlyph state={presentation.restart ? 'attention' : 'working'} />
            <strong>{presentation.title}</strong>
            <span>{presentation.detail}</span>
            {presentation.restart ? (
              <button
                type="button"
                className="primary-button"
                disabled={operation !== undefined}
                onClick={() => void runOperation('restart')}
              >
                {operation === 'restart' ? 'Restarting…' : 'Restart preview'}
              </button>
            ) : null}
          </div>
        )}
      </div>
      {error ? <p className="tm-design-canvas__error" role="alert">{error}</p> : null}
    </section>
  );
}

function RefreshIcon({ busy }: { busy: boolean }) {
  return (
    <svg
      className={busy ? 'tm-design-canvas__refresh-icon--busy' : undefined}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M13 5.5V2.75l-1.2 1.2A5.5 5.5 0 1 0 13.2 9" />
      <path d="M9.75 2.75H13V6" />
    </svg>
  );
}

function CanvasGlyph({ state }: { state: 'working' | 'attention' | 'desktop' | 'hidden' }) {
  return (
    <span className={`tm-design-canvas__glyph tm-design-canvas__glyph--${state}`} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <rect x="3.5" y="5" width="21" height="17" rx="2.5" />
        <path d="M3.5 9h21M7 7h.01M10 7h.01" />
        {state === 'attention' ? <path d="M14 12v4M14 19h.01" /> : null}
        {state === 'desktop' ? <path d="M10 25h8M14 22v3" /> : null}
        {state === 'hidden' ? <path d="m8 17 4-4 3 3 2-2 3 3" /> : null}
        {state === 'working' ? <path d="M9 15h10M14 12v6" /> : null}
      </svg>
    </span>
  );
}
