import { useLayoutEffect, useRef, useState } from 'react';
import type {
  HideDesignCanvasRequest,
  RefreshDesignCanvasRequest,
  ShowDesignCanvasRequest
} from '../../shared/designCanvas';
import {
  designCanvasPresentation,
  designProjectStatus,
  finiteDesignCanvasBounds,
  formatDesignUpdatedAt,
  type DesignProjectDetail
} from '../model/designs';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { StatusGlyph } from './StatusBadge';
import {
  UiDesktopIcon,
  UiExternalLinkIcon,
  UiPhoneIcon,
  UiRefreshIcon,
  UiTabletIcon
} from './UiIcons';

export type DesignCanvasShowRequest = ShowDesignCanvasRequest;
export type DesignCanvasHideRequest = HideDesignCanvasRequest;
export type DesignCanvasRefreshRequest = RefreshDesignCanvasRequest;

type CanvasDevice = 'desktop' | 'tablet' | 'phone';
type CanvasOperation = 'refresh' | 'restart' | 'select' | 'restore' | 'open';

const DEVICE_OPTIONS: ReadonlyArray<{
  id: CanvasDevice;
  label: string;
  size: string;
}> = [
  { id: 'desktop', label: 'Desktop', size: '1280 × auto' },
  { id: 'tablet', label: 'Tablet', size: '768 × auto' },
  { id: 'phone', label: 'Phone', size: '390 × auto' }
];

export interface DesignCanvasProps {
  project: DesignProjectDetail;
  desktopAvailable: boolean;
  occluded?: boolean;
  onShowCanvas?(request: DesignCanvasShowRequest): void;
  onHideCanvas?(request: DesignCanvasHideRequest): void;
  onRefresh(request: DesignCanvasRefreshRequest): Promise<void>;
  onRestart(designId: string): Promise<void>;
  onSelectRevision(revisionId: string): Promise<void>;
  onRestore(revisionId: string): Promise<void>;
  onOpen?(taskId: string, generationId: string, routeId: string): Promise<void>;
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
  onRestart,
  onSelectRevision,
  onRestore,
  onOpen
}: DesignCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const operationRef = useRef<CanvasOperation | undefined>(undefined);
  const [operation, setOperation] = useState<CanvasOperation>();
  const [device, setDevice] = useState<CanvasDevice>('desktop');
  const [error, setError] = useState<string>();
  const presentation = designCanvasPresentation({ project, desktopAvailable, occluded });
  const generationId = presentation.kind === 'NATIVE' ? presentation.target.generationId : undefined;
  const routeId = presentation.kind === 'NATIVE' ? presentation.target.routeId : undefined;
  const latestTurnOutcome = project.turns.at(-1)?.outcome;
  const latestRevision = project.revisions.at(-1);
  const presentedRevisionId =
    presentation.kind === 'NATIVE' ? presentation.target.revisionId : undefined;
  const selectedRevision =
    project.revisions.find((revision) => revision.id === presentedRevisionId) ?? latestRevision;
  const viewingEarlierRevision = Boolean(
    latestRevision && selectedRevision && selectedRevision.id !== latestRevision.id
  );
  const activeOrdinal = latestRevision?.ordinal ?? 1;
  const selectedDevice = DEVICE_OPTIONS.find((option) => option.id === device)!;
  const sourceFile =
    project.projectFiles.find((file) => file.path.endsWith('/index.html') || file.path === 'index.html') ??
    project.projectFiles[0];
  const canvasStatus = canvasStatusView(
    project,
    activeOrdinal,
    viewingEarlierRevision ? selectedRevision?.ordinal : undefined
  );

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

  const runOperation = async (
    kind: CanvasOperation,
    action: () => Promise<void>,
    fallback: string
  ) => {
    if (operationRef.current) return;
    operationRef.current = kind;
    setOperation(kind);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      operationRef.current = undefined;
      setOperation(undefined);
    }
  };

  const previewContent = presentation.kind === 'NATIVE' ? (
    <div
      ref={hostRef}
      className="tm-design-canvas__native-host"
      aria-label={`${project.design.title}${
        viewingEarlierRevision ? ` version ${selectedRevision?.ordinal}` : ''
      } preview`}
    >
      <span className="tm-visually-hidden">
        The interactive preview is displayed in the isolated desktop canvas.
      </span>
    </div>
  ) : (
    <div className="tm-design-canvas__placeholder" aria-live="polite">
      <strong>{presentation.title}</strong>
      <span>{presentation.detail}</span>
      {presentation.kind === 'PLACEHOLDER' && presentation.restart ? (
        <button
          type="button"
          className="primary-button"
          disabled={operation !== undefined}
          onClick={() => void runOperation(
            'restart',
            () => onRestart(project.design.id),
            'Could not restart the preview.'
          )}
        >
          {operation === 'restart' ? 'Restarting…' : 'Restart preview'}
        </button>
      ) : null}
    </div>
  );

  return (
    <section className="tm-design-canvas" aria-label="Design canvas">
      <header className="tm-design-canvas__toolbar">
        <nav className="tm-design-canvas__versions" aria-label="Design versions">
          {project.revisions.length === 0 ? (
            <span aria-current="true">v1</span>
          ) : project.revisions.map((revision) => {
            const selected = revision.id === selectedRevision?.id;
            const current = revision.id === latestRevision?.id;
            return (
              <button
                type="button"
                key={revision.id}
                aria-current={selected ? 'true' : undefined}
                aria-label={
                  selected
                    ? current
                      ? `Current version ${revision.ordinal}`
                      : `Viewing version ${revision.ordinal}`
                    : `View version ${revision.ordinal}`
                }
                disabled={selected || operation !== undefined}
                onClick={() => void runOperation(
                  'select',
                  () => onSelectRevision(revision.id),
                  'Could not show this version.'
                )}
              >
                v{revision.ordinal}
              </button>
            );
          })}
        </nav>
        <div className="tm-design-canvas__tools">
          <div className="tm-design-canvas__devices" role="group" aria-label="Canvas device">
            {DEVICE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                aria-label={option.label}
                title={option.label}
                aria-pressed={device === option.id}
                onClick={() => setDevice(option.id)}
              >
                {option.id === 'desktop'
                  ? <UiDesktopIcon />
                  : option.id === 'tablet'
                    ? <UiTabletIcon />
                    : <UiPhoneIcon />}
              </button>
            ))}
          </div>
          <span className="tm-design-canvas__device-size">{selectedDevice.size}</span>
          <button
            type="button"
            className="tm-design-canvas__tool"
            aria-label="Reload preview"
            title="Reload preview"
            disabled={!generationId || operation !== undefined}
            onClick={() => void runOperation(
              'refresh',
              () => onRefresh({
                designId: project.design.id,
                generationId: generationId!,
                requestId: nextCanvasRequestId()
              }),
              'Could not refresh the preview.'
            )}
          >
            <UiRefreshIcon busy={operation === 'refresh'} />
          </button>
          <button
            type="button"
            className="tm-design-canvas__tool"
            aria-label="Open preview in browser"
            title="Open preview in browser"
            disabled={!generationId || !routeId || !onOpen || operation !== undefined}
            onClick={() => void runOperation(
              'open',
              () => onOpen!(project.task.id, generationId!, routeId!),
              'Could not open the preview.'
            )}
          >
            <UiExternalLinkIcon />
          </button>
        </div>
      </header>

      {viewingEarlierRevision && selectedRevision && latestRevision ? (
        <div className="tm-design-canvas__revision-actions" aria-label="Earlier version preview">
          <span>Viewing v{selectedRevision.ordinal}</span>
          <div>
            <button
              type="button"
              className="outline-button"
              disabled={operation !== undefined}
              onClick={() => void runOperation(
                'select',
                () => onSelectRevision(latestRevision.id),
                'Could not return to the current version.'
              )}
            >
              Back to v{latestRevision.ordinal}
            </button>
            <button
              type="button"
              className="primary-button"
              aria-label={`Restore version ${selectedRevision.ordinal} as a new version`}
              disabled={operation !== undefined}
              onClick={() => void runOperation(
                'restore',
                () => onRestore(selectedRevision.id),
                'Could not restore this version.'
              )}
            >
              {operation === 'restore' ? 'Restoring…' : 'Restore as new'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="tm-design-canvas__stage">
        <div className="tm-design-canvas__viewport" data-device={device}>
          {previewContent}
        </div>
      </div>

      <footer className="tm-design-canvas__footer">
        <span className="tm-design-canvas__state" data-tone={canvasStatus.tone}>
          <StatusGlyph kind={canvasStatus.tone} />
          {canvasStatus.label}
        </span>
        {sourceFile && !viewingEarlierRevision ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="tm-design-canvas__source" title={sourceFile.path}>
              {sourceFile.path} · {formatAttachmentBytes(sourceFile.byteCount)}
            </span>
          </>
        ) : null}
        <span className="tm-design-canvas__footer-spacer" />
        <time dateTime={selectedRevision?.createdAt ?? project.design.updatedAt}>
          {formatDesignUpdatedAt(selectedRevision?.createdAt ?? project.design.updatedAt)}
        </time>
      </footer>
      {error ? <p className="tm-design-canvas__error" role="alert">{error}</p> : null}
    </section>
  );
}

function canvasStatusView(
  project: DesignProjectDetail,
  ordinal: number,
  viewedOrdinal?: number
): { label: string; tone: 'idle' | 'working' | 'waiting' | 'verified' | 'blocked' } {
  if (viewedOrdinal !== undefined) {
    return { label: `v${viewedOrdinal} preview`, tone: 'idle' };
  }
  const status = designProjectStatus(project);
  if (status === 'STARTING' || status === 'RUNNING') {
    return { label: `building v${ordinal}`, tone: 'working' };
  }
  if (status === 'UPDATING') {
    return { label: `rebuilding v${ordinal + 1}`, tone: 'working' };
  }
  if (status === 'READY') {
    return { label: `v${ordinal} ready`, tone: 'verified' };
  }
  if (status === 'NEEDS_INPUT') {
    return { label: 'waiting for input', tone: 'waiting' };
  }
  if (status === 'NEEDS_ATTENTION') {
    return { label: 'preview needs attention', tone: 'blocked' };
  }
  return { label: `v${ordinal} archived`, tone: 'idle' };
}
