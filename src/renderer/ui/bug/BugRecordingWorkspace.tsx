import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import {
  bugActionLabel,
  canReturnToRecording,
  fitRecordingViewport,
  formatElapsed,
  recordingHead,
  recordingViewVisible,
  startStepList
} from '../../model/bugReplay';
import { DecisionBlock } from '../DecisionBlock';
import { PlanList } from '../Plan';
import { StableLabel } from '../StableLabel';
import { BugCapturePanel } from './BugCapturePanel';
import { BugConfirmDialog } from './BugConfirmDialog';
import { BugLeaseFacts } from './BugLeaseBlock';
import { BugPageBar } from './BugPageBar';
import { BugRecordingView } from './BugRecordingView';
import { BugStepsRail } from './BugStepsRail';

/** The steps rail stays open beside the page while the workspace is at least this wide. */
const RAIL_FITS_WIDTH = 1180;
/** What the frame adds around the page: its 36px bar and 4px under the page, 4px either side. */
const FRAME_HEIGHT = 40;
const FRAME_WIDTH = 8;
/** How long Copied stays on the button before it reads Copy command again. */
const COPIED_HOLD_MS = 1500;

/**
 * Recording a bug, as the Preview tab's mode while it lasts: a clean, frozen copy of this task's
 * app on fresh data, shown in the app with the recorder attached. The person's own preview is
 * untouched. Preparation, permission, recording and marking happen here, in that order; the
 * page keeps its place from the moment it starts to the moment the bug is saved.
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
  const phase = recording.phase;
  const head = recordingHead(recording);
  const [busy, setBusy] = useState<string>();
  // An action that failed says so under the head: the page covers the window's notices.
  const [failed, setFailed] = useState<{ phase: string; message: string }>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // Until the person changes it, the choice is Task Monki's proposal, which arrives after the copy starts.
  const [envChoice, setEnvChoice] = useState<Set<string>>();
  const chosenEnv = envChoice ?? new Set((recording.envFiles ?? []).filter((file) => file.include).map((file) => file.name));
  const workspaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [railChoice, setRailChoice] = useState<boolean>();
  const live = recordingViewVisible(phase);
  const starting = phase === 'CHECKING' || phase === 'STARTING';
  const marking = phase === 'MARKING' || phase === 'SAVING';
  const decision = phase === 'CHOOSING_ENV_FILES' || phase === 'NEEDS_APPROVAL' || phase === 'FAILED';
  const capture = recording.capture;
  const composer = (marking || phase === 'INTERRUPTED') && Boolean(capture);
  const picking = phase === 'MARKING' && Boolean(recording.detail);
  const railFits = workspaceWidth >= RAIL_FITS_WIDTH;
  // Beside a page with room, the rail is always there; in a narrow space the person shows it.
  const railShown = phase === 'RECORDING' && (railFits || railChoice === true);
  const now = useClock(phase === 'RECORDING' || starting);
  const markRef = useRef<HTMLButtonElement>(null);
  const panelTitleRef = useRef<HTMLInputElement>(null);
  const pointRef = useRef<HTMLButtonElement>(null);
  const previousPhase = useRef(phase);

  // Focus follows the step, so it never falls to the page when the control that had it goes
  // away: marking moves it to Stop pointing while the page waits for a pick, or to the bug's
  // name, and going back returns it to Mark bug.
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (before === phase) return;
    if (phase === 'MARKING' && before === 'RECORDING') (picking ? pointRef : panelTitleRef).current?.focus({ preventScroll: true });
    if (phase === 'RECORDING' && before === 'MARKING') markRef.current?.focus({ preventScroll: true });
  }, [phase, picking]);

  // The workspace's width decides whether the steps rail fits beside the page.
  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => setWorkspaceWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    // The page fits inside the stage's padding, under its bar, so it is measured by the content box.
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const width = Math.max(0, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - FRAME_WIDTH);
      const height = Math.max(0, rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - FRAME_HEIGHT);
      setStage((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [decision, composer, railShown]);

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

  const report = (cause: unknown) => setFailed({ phase, message: cause instanceof Error ? cause.message : String(cause) });
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
  const error = failed && failed.phase === phase ? failed.message : undefined;
  const discard = () => act('discard', async () => {
    setConfirmDiscard(false);
    await taskManagerApi.cancelBugRecording({ taskId, sessionId });
  });
  const restart = () => act('restart', async () => {
    await taskManagerApi.startBugRecording({ taskId, clientOperationId: crypto.randomUUID() });
  });
  const viewport = recording.viewport ?? { width: 1280, height: 800 };
  const size = fitRecordingViewport(stage, viewport);
  const elapsed = phase === 'RECORDING'
    ? formatElapsed(recording.recordingStartedAt, now)
    : starting ? formatElapsed(recording.startedAt, now) : undefined;
  const failure = recording.failure;
  // Something counts while it lasts: the line says so with the live shimmer and its time.
  const liveLine = phase === 'RECORDING' || starting || phase === 'SAVING';
  const keepsSteps = phase === 'RECORDING' || phase === 'MARKING' || phase === 'INTERRUPTED';
  const steps = phase === 'CHECKING'
    ? { steps: [{ step: 'Check the app', status: 'IN_PROGRESS' as const }] }
    : startStepList(recording.progress ?? []);

  return (
    <section ref={workspaceRef} className="tm-bugrecord" aria-label="Record a bug" data-phase={phase.toLowerCase()}>
      <header className="tm-bugrecord__head">
        <div className="tm-bugrecord__status">
          {/* Only the step is announced; the clock beside it is not read every second. */}
          <strong className={`tm-bugrecord__title${liveLine ? ' tm-shimmer' : ''}`} role="status">{head.title}</strong>
          {elapsed ? <span className="tm-bugrecord__elapsed" aria-hidden="true">{elapsed}</span> : null}
          {recording.coverageNote && (phase === 'RECORDING' || phase === 'MARKING') ? (
            <span className="tm-bugrecord__coverage" title={recording.coverageNote}>{recording.coverageNote}</span>
          ) : null}
        </div>
        <div className="tm-bugrecord__actions">
          {phase === 'RECORDING' && !railFits ? (
            <button type="button" className="ghost-button tm-bugrecord__railtoggle" aria-pressed={railShown}
              onClick={() => setRailChoice(!railShown)}>
              Steps
              <span className="tm-bugrecord__count">{recording.timeline?.steps ?? 0}</span>
            </button>
          ) : null}
          {canReturnToRecording(recording) ? (
            <button type="button" className="ghost-button" disabled={Boolean(busy)}
              onClick={() => void act('back', () => taskManagerApi.returnToBugRecording({ taskId, sessionId }))}>
              Back to recording
            </button>
          ) : null}
          {phase === 'FAILED' || phase === 'SAVING' || decision ? null : (
            <button type="button" className="ghost-button" disabled={Boolean(busy)}
              onClick={() => (keepsSteps ? setConfirmDiscard(true) : void discard())}>
              {keepsSteps ? 'Discard' : 'Cancel'}
            </button>
          )}
          {phase === 'RECORDING' ? (
            <button ref={markRef} type="button" className="primary-button button--sm" disabled={Boolean(busy)}
              onClick={() => void act('mark', () => taskManagerApi.markBug({ taskId, sessionId }))}>
              Mark bug
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p className="tm-error tm-bugrecord__error" role="alert">{error}</p> : null}

      <div className="tm-bugrecord__body" data-side={composer ? 'composer' : railShown ? 'rail' : undefined} data-picking={picking ? '' : undefined}>
        {decision ? (
          // A decision takes the page's place before the page exists; declining comes first.
          <div className="tm-bugrecord__decision">
            {phase === 'CHOOSING_ENV_FILES' && recording.envFiles ? (
              <DecisionBlock
                kind="Env files"
                tone="action"
                summary="Git does not track these. Replays get only the ones you choose, and they stay on this machine."
                actions={
                  <>
                    <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void discard()}>Cancel</button>
                    <button type="button" className="primary-button" disabled={Boolean(busy)}
                      onClick={() => void act('env', () => taskManagerApi.chooseBugEnvFiles({ taskId, sessionId, include: [...chosenEnv] }))}>
                      Start the app
                    </button>
                  </>
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
            ) : null}

            {phase === 'NEEDS_APPROVAL' && recording.lease ? (
              <DecisionBlock
                kind={recording.lease.title}
                tone="action"
                summary={recording.lease.sameAsRunningPreview ? 'The same commands as this task’s running preview, on a separate copy.' : undefined}
                actions={
                  <>
                    <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void discard()}>Cancel</button>
                    <button type="button" className="outline-button" disabled={Boolean(busy)}
                      onClick={() => void act('keep', () => taskManagerApi.allowBugReplayRuns({ taskId, approvalDigest: recording.lease!.approvalDigest, keep: true }))}>
                      {bugActionLabel('always-allow-runs')}
                    </button>
                    <button type="button" className="primary-button" disabled={Boolean(busy)}
                      onClick={() => void act('allow', () => taskManagerApi.allowBugReplayRuns({ taskId, approvalDigest: recording.lease!.approvalDigest }))}>
                      {bugActionLabel('allow-runs')}
                    </button>
                  </>
                }
              >
                <BugLeaseFacts lease={recording.lease} />
              </DecisionBlock>
            ) : null}

            {phase === 'FAILED' && failure ? (
              <DecisionBlock
                kind={failure.title}
                tone="error"
                summary={failure.detail}
                actions={
                  <>
                    <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void discard()}>Close</button>
                    {failure.action === 'ask-preview-agent' && onAskPreviewAgent ? (
                      <button type="button" className="outline-button" disabled={Boolean(busy)}
                        onClick={() => onAskPreviewAgent(`The app did not start for Bug Replay: ${failure.detail}\nInspect preview.yaml and the project startup. Explain the proposed fix before changing anything.`)}>
                        Investigate with Preview agent
                      </button>
                    ) : null}
                    {failure.command ? (
                      <button type="button" className="outline-button" onClick={() => {
                        void navigator.clipboard.writeText(failure.command!).then(() => {
                          setCopied(true);
                          clearTimeout(copiedTimer.current);
                          copiedTimer.current = setTimeout(() => setCopied(false), COPIED_HOLD_MS);
                        });
                      }}>
                        <StableLabel label={copied ? 'Copied' : 'Copy command'} reserve={['Copy command', 'Copied']} />
                      </button>
                    ) : null}
                    <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void restart()}>
                      {failure.action === 'record-again' ? 'Record again' : 'Try again'}
                    </button>
                  </>
                }
              >
                {failure.command ? <pre className="tm-bugrecord__command">{failure.command}</pre> : null}
              </DecisionBlock>
            ) : null}
          </div>
        ) : (
          <div ref={stageRef} className="tm-bugrecord__stage">
            {size.width > 0 ? (
              <div className="tm-bugrecord__frame" style={{ width: size.width + FRAME_WIDTH }}>
                <BugPageBar
                  address={recording.routePath ?? '/'}
                  editable={Boolean(recording.startEditable)}
                  live={phase === 'RECORDING'}
                  viewport={viewport}
                  busy={Boolean(busy)}
                  onReload={() => void act('reload', () => window.bugRecordingView?.reload({ taskId, sessionId }) ?? Promise.resolve())}
                  onOpen={(path) => void act('open', () => window.bugRecordingView?.open({ taskId, sessionId, path }) ?? Promise.resolve())}
                />
                {live ? (
                  <BugRecordingView taskId={taskId} sessionId={sessionId} hidden={covered || confirmDiscard} width={size.width} height={size.height} />
                ) : (
                  // While the copy starts, or after it stopped, the page's place holds what happens instead.
                  <div className="tm-bugview tm-bugrecord__placeholder" style={{ width: size.width, height: size.height }}>
                    {starting ? (
                      <div className="tm-bugrecord__progress" aria-label="Starting the app">
                        <PlanList
                          steps={steps.steps.map((step, index) => ({ ...step, ...stepTime(recording.progress?.[index], now) }))}
                          marker={steps.failedIndex !== undefined ? { index: steps.failedIndex, kind: 'failed' } : undefined}
                        />
                      </div>
                    ) : phase === 'INTERRUPTED' && failure ? (
                      <p className="tm-bugrecord__stopped" role="note">{failure.title}</p>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {railShown ? <BugStepsRail timeline={recording.timeline} /> : null}

        {composer && capture ? (
          <BugCapturePanel taskId={taskId} recording={recording} capture={capture} picking={picking} replaces={replaces}
            titleRef={panelTitleRef} pointRef={pointRef} onError={(message) => setFailed({ phase, message })} onSaved={onSaved}
            onRecordAgain={phase === 'INTERRUPTED' ? () => void restart() : undefined} restarting={busy === 'restart'} />
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

/** A startup step's time: how long it took once done, how long so far while it runs. */
function stepTime(step: { startedAt?: string; endedAt?: string; state: string } | undefined, now: number): { meta?: string } {
  if (!step?.startedAt) return {};
  const started = Date.parse(step.startedAt);
  const ended = step.endedAt ? Date.parse(step.endedAt) : step.state === 'active' ? now : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return {};
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  // A step that took under a second has no time worth reading.
  if (step.endedAt && seconds < 1) return {};
  return { meta: seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` };
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
