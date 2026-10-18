import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import type { BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { canReturnToRecording, fitRecordingViewport, formatElapsed, recordingHead, recordingViewVisible } from '../../model/bugReplay';
import { DecisionBlock } from '../DecisionBlock';
import { StatusGlyph } from '../StatusBadge';
import { Tooltip } from '../Tooltip';
import { BugCapturePanel } from './BugCapturePanel';
import { BugConfirmDialog } from './BugConfirmDialog';
import { BugLeaseBlock } from './BugLeaseBlock';
import { BugRecordingView } from './BugRecordingView';

/**
 * Recording a bug, as the Preview tab's mode while it lasts: a clean, frozen copy of this task's
 * app on fresh data, shown in the app with the recorder attached. The person's own preview is
 * untouched. Preparation, permission, recording and marking happen here, in that order.
 */
export function BugRecordingWorkspace({
  taskId,
  recording,
  covered,
  onSaved,
  onAskPreviewAgent,
  replaces
}: {
  taskId: string;
  recording: BugRecordingSessionView;
  /** The task's current bug, which saving this one replaces. */
  replaces?: string;
  /** A modal, a menu or a floating panel covers the workspace; the native view steps aside. */
  covered: boolean;
  onSaved(withCheck: boolean): void;
  onAskPreviewAgent?(text: string): void;
}) {
  const sessionId = recording.sessionId;
  const head = recordingHead(recording);
  const [busy, setBusy] = useState<string>();
  // An action that failed says so under the head: the page covers the window's notices.
  const [failed, setFailed] = useState<{ phase: string; message: string }>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Until the person changes it, the choice is Task Monki's proposal, which arrives after the copy starts.
  const [envChoice, setEnvChoice] = useState<Set<string>>();
  const chosenEnv = envChoice ?? new Set((recording.envFiles ?? []).filter((file) => file.include).map((file) => file.name));
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const live = recordingViewVisible(recording.phase);
  const starting = recording.phase === 'CHECKING' || recording.phase === 'STARTING';
  const marking = recording.phase === 'MARKING' || recording.phase === 'SAVING';
  const capture = recording.capture;
  const picking = recording.phase === 'MARKING' && Boolean(recording.detail);
  const now = useClock(recording.phase === 'RECORDING' || recording.phase === 'CHECKING' || recording.phase === 'STARTING');
  const markRef = useRef<HTMLButtonElement>(null);
  const panelTitleRef = useRef<HTMLInputElement>(null);
  const pointRef = useRef<HTMLButtonElement>(null);
  const previousPhase = useRef(recording.phase);

  // Focus follows the step, so it never falls to the page when the control that had it goes
  // away: marking moves it to Stop pointing while the page waits for a pick (the fields are
  // locked then) or to the bug's name, and going back returns it to Mark bug.
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = recording.phase;
    if (before === recording.phase) return;
    if (recording.phase === 'MARKING' && before === 'RECORDING') (picking ? pointRef : panelTitleRef).current?.focus({ preventScroll: true });
    if (recording.phase === 'RECORDING' && before === 'MARKING') markRef.current?.focus({ preventScroll: true });
  }, [recording.phase, picking]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    // The view fits inside the stage's padding, so it is measured by its content box.
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const width = Math.max(0, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const height = Math.max(0, rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
      setStage((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [live, marking, starting]);

  // Escape stops pointing, as it does inside the page; the page itself rarely has the keyboard.
  useEffect(() => {
    if (!picking || covered || confirmDiscard) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void taskManagerApi.stopBugPick({ taskId, sessionId }).catch((cause: unknown) =>
        setFailed({ phase: 'MARKING', message: cause instanceof Error ? cause.message : String(cause) }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [picking, covered, confirmDiscard, taskId, sessionId]);

  const report = (cause: unknown) => setFailed({ phase: recording.phase, message: cause instanceof Error ? cause.message : String(cause) });
  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setFailed(undefined);
    try {
      await action();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(undefined);
    }
  };
  // A failure belongs to the step it happened in; the next step starts clean.
  const error = failed && failed.phase === recording.phase ? failed.message : undefined;
  const discard = () => act('discard', async () => {
    setConfirmDiscard(false);
    await taskManagerApi.cancelBugRecording({ taskId, sessionId });
  });
  const restart = () => act('restart', async () => {
    await taskManagerApi.startBugRecording({ taskId, clientOperationId: crypto.randomUUID() });
  });
  const size = fitRecordingViewport(stage, recording.viewport);
  const elapsed = recording.phase === 'RECORDING'
    ? formatElapsed(recording.recordingStartedAt, now)
    : head.working ? formatElapsed(recording.startedAt, now) : undefined;
  const failure = recording.failure;

  return (
    <section className="tm-bugrecord" aria-label="Record a bug">
      <header className="tm-bugrecord__head">
        <div className="tm-bugrecord__status">
          {head.working ? <StatusGlyph kind="working" className="tm-bugrecord__glyph" /> : null}
          {/* Only the step is announced; the clock beside it is not read every second. */}
          <strong className={`tm-bugrecord__title tm-bugrecord__title--${head.tone}`} role="status">{head.title}</strong>
          {elapsed ? <span className="tm-bugrecord__elapsed" role="timer" aria-hidden="true">{elapsed}</span> : null}
          {head.detail ? (
            <span className={head.detailMono ? 'tm-bugrecord__route' : 'tm-bugrecord__detail'} title={head.detail}>{head.detail}</span>
          ) : null}
          {recording.coverageNote && (recording.phase === 'RECORDING' || recording.phase === 'MARKING') ? (
            <span className="tm-bugrecord__coverage" title={recording.coverageNote}>{recording.coverageNote}</span>
          ) : null}
        </div>
        <div className="tm-bugrecord__actions">
          {recording.phase === 'RECORDING' ? (
            // Beside the button, never over the page: the page covers what lies below the head.
            <Tooltip label="Reload page" side="left">
              <button type="button" className="tm-iconbtn" aria-label="Reload page" disabled={Boolean(busy)}
                onClick={() => void act('reload', () => window.bugRecordingView?.reload({ taskId, sessionId }) ?? Promise.resolve())}>
                <RotateCw size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          {canReturnToRecording(recording) ? (
            <button type="button" className="ghost-button" disabled={Boolean(busy)}
              onClick={() => void act('back', () => taskManagerApi.returnToBugRecording({ taskId, sessionId }))}>
              Back to recording
            </button>
          ) : null}
          {recording.phase === 'FAILED' ? (
            <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void discard()}>Close</button>
          ) : recording.phase !== 'SAVING' ? (
            <button type="button" className="ghost-button" disabled={Boolean(busy)}
              onClick={() => (recording.phase === 'RECORDING' || recording.phase === 'MARKING' || recording.phase === 'INTERRUPTED' ? setConfirmDiscard(true) : void discard())}>
              {recording.phase === 'RECORDING' || recording.phase === 'MARKING' || recording.phase === 'INTERRUPTED' ? 'Discard' : 'Cancel'}
            </button>
          ) : null}
          {recording.phase === 'RECORDING' ? (
            <button ref={markRef} type="button" className="primary-button" disabled={Boolean(busy)}
              onClick={() => void act('mark', () => taskManagerApi.markBug({ taskId, sessionId }))}>
              Mark bug
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p className="tm-error tm-bugrecord__error" role="alert">{error}</p> : null}

      <div className={`tm-bugrecord__body${marking || (recording.phase === 'INTERRUPTED' && capture) ? ' tm-bugrecord__body--split' : ''}`}
        data-picking={picking ? '' : undefined}>
        {starting ? (
          // The head states the step; the page's place waits here with what the copy is.
          <div ref={stageRef} className="tm-bugrecord__stage">
            <div className="tm-bugview tm-bugrecord__placeholder" style={size.width > 0 ? { width: size.width, height: size.height } : undefined}>
              <p className="tm-bugrecord__note">A clean copy of this task’s files on fresh data. Your own preview keeps running.</p>
            </div>
          </div>
        ) : null}

        {recording.phase === 'CHOOSING_ENV_FILES' && recording.envFiles ? (
          <div className="tm-bugrecord__decision">
            <DecisionBlock
              kind="Ignored env files"
              tone="action"
              summary="Git does not track these files. The clean copy gets the ones you choose; their contents never leave this machine."
              actions={
                <button type="button" className="primary-button" disabled={Boolean(busy)}
                  onClick={() => void act('env', () => taskManagerApi.chooseBugEnvFiles({ taskId, sessionId, include: [...chosenEnv] }))}>
                  Start clean copy
                </button>
              }
            >
              <div className="tm-bugrecord__choices">
                {recording.envFiles.map((file) => (
                  <label key={file.name} className="tm-bugcheck__option">
                    <input type="checkbox" checked={chosenEnv.has(file.name)}
                      onChange={(event) => {
                        const next = new Set(chosenEnv);
                        if (event.target.checked) next.add(file.name);
                        else next.delete(file.name);
                        setEnvChoice(next);
                      }} />
                    <code>{file.name}</code>
                  </label>
                ))}
              </div>
            </DecisionBlock>
          </div>
        ) : null}

        {recording.phase === 'NEEDS_APPROVAL' && recording.lease ? (
          <div className="tm-bugrecord__decision">
            <BugLeaseBlock lease={recording.lease} busy={Boolean(busy)}
              onAllow={() => void act('allow', () => taskManagerApi.allowBugReplayRuns({ taskId, templateDigest: recording.lease!.templateDigest }))} />
          </div>
        ) : null}

        {recording.phase === 'FAILED' && failure ? (
          <div className="tm-bugrecord__decision">
            <DecisionBlock
              kind={failure.title}
              tone="error"
              summary={failure.detail}
              actions={
                <>
                  {failure.action === 'ask-preview-agent' && onAskPreviewAgent ? (
                    <button type="button" className="outline-button" disabled={Boolean(busy)}
                      onClick={() => onAskPreviewAgent(`A clean copy of this app for Bug Replay did not start: ${failure.detail}\nInspect preview.yaml and the project startup. Explain the proposed fix before changing anything.`)}>
                      Investigate with Preview agent
                    </button>
                  ) : null}
                  {failure.command ? (
                    <button type="button" className="outline-button" onClick={() => void navigator.clipboard.writeText(failure.command!)}>Copy command</button>
                  ) : null}
                  <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void restart()}>
                    {failure.action === 'record-again' ? 'Record again' : 'Try again'}
                  </button>
                </>
              }
            >
              {failure.command ? <pre className="tm-bugrecord__command">{failure.command}</pre> : null}
            </DecisionBlock>
          </div>
        ) : null}

        {recording.phase === 'INTERRUPTED' && failure ? (
          // Only the reason: the head says it stopped, and the panel's foot holds the choices.
          <div className="tm-bugrecord__decision">
            <DecisionBlock kind={failure.title} tone="action" summary={failure.detail} />
          </div>
        ) : null}

        {live ? (
          <div ref={stageRef} className="tm-bugrecord__stage">
            {size.width > 0 ? (
              <BugRecordingView taskId={taskId} sessionId={sessionId} hidden={covered || confirmDiscard} width={size.width} height={size.height} />
            ) : null}
          </div>
        ) : null}

        {(marking || recording.phase === 'INTERRUPTED') && capture ? (
          <BugCapturePanel taskId={taskId} recording={recording} capture={capture} picking={picking} replaces={replaces}
            titleRef={panelTitleRef} pointRef={pointRef} onError={(message) => setFailed({ phase: recording.phase, message })} onSaved={onSaved}
            onRecordAgain={recording.phase === 'INTERRUPTED' ? () => void restart() : undefined} restarting={busy === 'restart'} />
        ) : null}
      </div>

      {confirmDiscard ? (
        <BugConfirmDialog
          title="Discard this recording?"
          body="The steps recorded so far are not kept."
          keepLabel="Keep recording"
          confirmLabel="Discard recording"
          busyLabel="Discarding…"
          busy={busy === 'discard'}
          onKeep={() => setConfirmDiscard(false)}
          onConfirm={() => void discard()} />
      ) : null}
    </section>
  );
}

/** Now, every second while something counts. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
