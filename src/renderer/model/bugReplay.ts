import type {
  BoardBugReplaySummary,
  BugCaptureCheckDraft,
  BugCaptureDraft,
  BugCapturePickView,
  BugCapturePreview,
  BugCaptureView,
  BugCaseAction,
  BugCaseView,
  BugRecordingPhase,
  BugRecordingSessionView,
  BugReplayGateProjection,
  BugReplayGateState,
  BugReplayRunView,
  BugReplayWaitReason
} from '../../shared/bugReplay';
import { bugReason, bugStateWord } from '../../shared/bugReplayClaims';
import type { Tone } from './viewTypes';

/**
 * How every surface reads a task's recorded bug: one word and tone (the claims formatter's),
 * whether it waits on the person, the step it offers, and the capture modal's draft rules. The
 * board, the Inbox, the Now panel and the Bug section all read these, so a bug never has a
 * second name or a second next step.
 */

export type BugGate = Pick<BugReplayGateProjection, 'state' | 'fact'> & {
  activeRun?: { waitingFor?: BugReplayWaitReason };
  handoff?: { status: string };
};

/** A board summary or a task's full projection, read the same way. */
export function bugGateOf(value: BugReplayGateProjection | BoardBugReplaySummary | undefined): BugGate | undefined {
  if (!value) return undefined;
  if ('caseId' in value) return value;
  return {
    state: value.state,
    ...(value.fact ? { fact: value.fact } : {}),
    ...(value.waitingFor ? { activeRun: { waitingFor: value.waitingFor } } : {}),
    ...(value.fixing ? { handoff: { status: 'RUNNING' } } : {})
  };
}

export interface BugStatus {
  word: string;
  tone: Tone;
  /** Work in flight: Reproducing, Verifying, Fixing the bug. */
  inFlight: boolean;
  /** The person owes a step. */
  owed: boolean;
}

export function describeBugStatus(gate: BugGate): BugStatus {
  const word = bugStateWord(gate);
  return {
    word: word.word,
    tone: word.tone === 'working' ? 'info' : word.tone,
    inFlight: word.tone === 'working',
    owed: word.owed
  };
}

export function bugFixing(gate: BugGate | undefined): boolean {
  return Boolean(gate?.handoff && (gate.handoff.status === 'QUEUED' || gate.handoff.status === 'RUNNING'));
}

const ATTENTION_TONE: Partial<Record<BugReplayGateState, 'warning' | 'error' | 'info'>> = {
  REPRODUCED: 'info',
  NOT_REPRODUCED: 'warning',
  FLAKY: 'warning',
  REPRODUCTION_BLOCKED: 'error',
  STILL_FAILING: 'error',
  COULDNT_VERIFY: 'warning'
};

/**
 * The bug's claim on the person, for the board badge and the Inbox. Nothing while the agent
 * works or holds the bug: its own state leads then, and the bug's word returns when it ends.
 */
export function describeBugAttention(
  gate: BugGate | undefined,
  agentWorking: boolean
): { label: string; tone: 'warning' | 'error' | 'info'; detail?: string } | undefined {
  if (!gate || bugFixing(gate) || agentWorking) return undefined;
  const status = describeBugStatus(gate);
  const waiting = gate.activeRun?.waitingFor;
  if (waiting === 'APPROVAL' || waiting === 'KEYSTORE') return { label: status.word, tone: 'warning' };
  const tone = ATTENTION_TONE[gate.state];
  if (!tone) return undefined;
  const reason = bugReason(gate);
  return { label: status.word, tone, ...(reason ? { detail: reason } : {}) };
}

/** Labels of the Bug section's actions, in the product's verbs. */
export function bugActionLabel(action: BugCaseAction, view?: Pick<BugCaseView, 'keepBrowserStorage' | 'envFilesChanged'> & { gate?: Pick<BugReplayGateProjection, 'candidate'> }): string {
  switch (action) {
    case 'send-to-agent':
      return 'Send to agent';
    case 'verify-again':
      // Before any fix was checked, it is the first verification.
      return view?.gate && !view.gate.candidate ? 'Verify fix' : 'Verify again';
    case 'run-again':
      return 'Run again';
    case 'record-again':
      return 'Record again';
    case 'allow-runs':
      return 'Approve clean runs';
    case 'unlock-secrets':
      return 'Unlock secrets';
    case 'use-new-env-files':
      return (view?.envFilesChanged?.length ?? 0) > 1 ? 'Use the new env files' : 'Use the new env file';
    case 'keep-browser-storage':
      return view?.keepBrowserStorage ? 'Clear browser storage on reload' : 'Keep browser storage on reload';
    case 'save-without-check':
      return 'Remove the check';
    case 'remove':
      return 'Remove bug';
    case 'cancel-run':
      return 'Cancel runs';
  }
}

/** What an action's control says while it runs. */
export function bugActionPendingLabel(action: BugCaseAction): string {
  switch (action) {
    case 'send-to-agent':
      return 'Sending…';
    case 'verify-again':
    case 'run-again':
      return 'Queuing…';
    case 'record-again':
      return 'Starting…';
    case 'allow-runs':
      return 'Approving…';
    case 'cancel-run':
      return 'Canceling…';
    default:
      return bugActionLabel(action);
  }
}

export interface BugActionLayout {
  primary?: BugCaseAction;
  secondary: BugCaseAction[];
  menu: BugCaseAction[];
}

/**
 * The buttons each state offers, the step first. Everything else the bug allows waits under its
 * ⋯ menu: Verify again on code that has not changed, Run again on a reproduced bug, options and
 * Remove bug.
 */
const STATE_BUTTONS: Record<BugReplayGateState, BugCaseAction[]> = {
  CAPTURED: ['send-to-agent'],
  REPRODUCING: ['send-to-agent', 'cancel-run'],
  REPRODUCED: ['send-to-agent'],
  NOT_REPRODUCED: ['record-again', 'run-again'],
  FLAKY: ['record-again', 'send-to-agent'],
  REPRODUCTION_BLOCKED: ['use-new-env-files', 'run-again', 'record-again'],
  VERIFYING: ['cancel-run'],
  FIX_VERIFIED: [],
  STILL_FAILING: ['send-to-agent', 'verify-again'],
  COULDNT_VERIFY: ['use-new-env-files', 'verify-again', 'send-to-agent'],
  STALE: ['verify-again']
};

/** The actions as buttons and a menu: a decision the bug waits on leads, then the state's own. */
export function layoutBugActions(actions: BugCaseAction[], state: BugReplayGateState): BugActionLayout {
  const offered = new Set(actions);
  const leading = (['allow-runs', 'unlock-secrets'] as const).filter((action) => offered.has(action));
  const buttons = [...leading, ...STATE_BUTTONS[state].filter((action) => offered.has(action))].slice(0, 3);
  const shown = new Set<BugCaseAction>(buttons);
  return {
    ...(buttons[0] ? { primary: buttons[0] } : {}),
    secondary: buttons.slice(1),
    menu: actions.filter((action) => !shown.has(action))
  };
}

/**
 * Whether the bug holds the Overview's Now panel: it owes the person a step and nothing more
 * urgent (a request, recovery, running work) leads. Fixed and in-flight states never do. Read
 * from the task's projection, so the owner is right from the first frame. Before the first
 * agent turn, starting the task sends the bug, so only a decision about clean runs leads.
 */
export function bugOwnsNowPanel(
  gate: BugReplayGateProjection | BoardBugReplaySummary | undefined,
  input: { agentWorking: boolean; implementationStarted: boolean }
): boolean {
  const bug = bugGateOf(gate);
  if (!describeBugAttention(bug, input.agentWorking)) return false;
  const waiting = bug?.activeRun?.waitingFor;
  return input.implementationStarted || waiting === 'APPROVAL' || waiting === 'KEYSTORE';
}

const OUTCOME_WORDS: Record<NonNullable<BugReplayRunView['outcome']>, string> = {
  CAPTURED: 'Recorded',
  DISCARDED: 'Discarded',
  REPRODUCED: 'Reproduced',
  NOT_REPRODUCED: 'Not reproduced',
  PASSED: 'Passed',
  FAILED: 'Failed',
  ENVIRONMENT_FAILED: "Didn't start",
  BLOCKED: 'Blocked',
  PROTECTED_INPUT_CHANGED: 'Setup changed',
  ENV_FILES_CHANGED: 'Env file changed',
  CANCELED: 'Canceled',
  INTERRUPTED: 'Interrupted',
  SUPERSEDED: 'Replaced'
};

const WAIT_WORDS: Record<BugReplayWaitReason, string> = {
  APPROVAL: 'Needs approval',
  CAPACITY: 'Waiting for preview capacity',
  KEYSTORE: 'Waiting for secrets',
  AGENT_TURN: "Waiting for the agent's turn",
  QUALIFICATION: 'Waiting for the bug to reproduce',
  ENV_FILES: 'Waiting for env files'
};

export interface BugRunRow {
  id: string;
  /** "Before", "After" or "Recheck": the recorded code run again before a fix counts. */
  kind: string;
  word: string;
  tone: Tone;
  inFlight: boolean;
  detail?: string;
  /** When it settled or started, for the row's age. */
  at: string;
  screenshotFileIds: string[];
}

export function bugRunRows(runs: BugReplayRunView[]): BugRunRow[] {
  return runs
    .filter((run) => run.kind !== 'RECORD')
    .slice(0, 8)
    .map((run) => {
      const kind = run.control ? 'Recheck' : run.kind === 'CANDIDATE' ? 'After' : 'Before';
      const settled = run.state === 'SETTLED' && run.outcome;
      const word = settled ? OUTCOME_WORDS[run.outcome!] : run.waitingFor ? WAIT_WORDS[run.waitingFor] : run.phase ?? (run.state === 'QUEUED' ? 'Queued' : 'Running');
      const tone: Tone = !settled
        ? run.waitingFor === 'APPROVAL' || run.waitingFor === 'KEYSTORE' ? 'action' : 'info'
        : run.outcome === 'PASSED' || run.outcome === 'REPRODUCED' ? (run.kind === 'CANDIDATE' && !run.control ? 'success' : 'neutral')
          : run.outcome === 'FAILED' ? 'error'
            : ['ENVIRONMENT_FAILED', 'BLOCKED', 'PROTECTED_INPUT_CHANGED', 'ENV_FILES_CHANGED'].includes(run.outcome!) ? 'action'
              : 'neutral';
      return {
        id: run.id,
        kind,
        word,
        tone,
        inFlight: !settled && !run.waitingFor,
        ...(run.failure?.detail && run.outcome !== 'CANCELED' && run.outcome !== 'SUPERSEDED' ? { detail: run.failure.detail } : {}),
        at: run.settledAt ?? run.startedAt ?? run.queuedAt,
        screenshotFileIds: run.screenshotFileIds
      };
    });
}

/** The verdict Mark done displayed, sent so a verdict about code that changed since is caught. */
export function displayedBugVerdict(gate: BugReplayGateProjection | undefined): { caseId: string; treeId: string } | undefined {
  return gate?.state === 'FIX_VERIFIED' && gate.verdictTreeId ? { caseId: gate.caseId, treeId: gate.verdictTreeId } : undefined;
}

// Recording

export interface RecordingHead {
  /** The toolbar's state, in one phrase. */
  title: string;
  tone: Tone;
  working: boolean;
  /** Live detail beside it: the step of preparation, or the page being recorded. */
  detail?: string;
  detailMono?: boolean;
}

export function recordingHead(recording: BugRecordingSessionView): RecordingHead {
  switch (recording.phase) {
    case 'CHECKING':
    case 'STARTING':
      return { title: 'Starting a clean copy', tone: 'info', working: true, ...(recording.detail ? { detail: recording.detail } : {}) };
    case 'CHOOSING_ENV_FILES':
    case 'NEEDS_APPROVAL':
    case 'FAILED':
      // The decision block below carries the step, or what went wrong, and its tone.
      return { title: 'Record a bug', tone: 'neutral', working: false };
    case 'INTERRUPTED':
      // The block below says why; the steps so far wait in the panel.
      return { title: 'Recording stopped', tone: 'action', working: false };
    case 'RECORDING':
      return { title: 'Recording', tone: 'info', working: false, ...(recording.routePath ? { detail: recording.routePath, detailMono: true } : {}) };
    case 'MARKING':
      return recording.detail
        ? { title: "Point at what's wrong", tone: 'action', working: false }
        : { title: 'Mark the bug', tone: 'info', working: false };
    case 'SAVING':
      return { title: 'Saving the bug', tone: 'info', working: true };
  }
}

/** Whether Back to recording applies: the bug is being marked and nothing is saving. */
export function canReturnToRecording(recording: BugRecordingSessionView): boolean {
  return recording.phase === 'MARKING';
}

/** Phases in which the native view shows the page. */
export function recordingViewVisible(phase: BugRecordingPhase): boolean {
  return phase === 'RECORDING' || phase === 'MARKING' || phase === 'SAVING';
}

/** Elapsed time as m:ss or h:mm:ss, in tabular figures. */
export function formatElapsed(fromIso: string | undefined, now: number): string | undefined {
  const start = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The largest box of the case's 16:10 viewport that fits the space, never larger than the viewport. */
export function fitRecordingViewport(
  available: { width: number; height: number },
  viewport: { width: number; height: number } = { width: 1280, height: 800 }
): { width: number; height: number } {
  if (available.width <= 0 || available.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, available.width / viewport.width, available.height / viewport.height);
  return { width: Math.floor(viewport.width * scale), height: Math.floor(viewport.height * scale) };
}

// Capture

/** A check for a picked element: what it should read, starting from what it showed. */
export function defaultCheck(pick: BugCapturePickView): BugCaptureCheckDraft {
  if (pick.value !== undefined) return { pickIndex: pick.index, template: 'equals', expected: pick.value, alsoAfterReload: false };
  if (pick.text) return { pickIndex: pick.index, template: 'equals', expected: pick.text, alsoAfterReload: false };
  return { pickIndex: pick.index, template: pick.visible ? 'hidden' : 'visible', alsoAfterReload: false };
}

/** The draft the modal opens with: the saved one if any, with a check for every pick it lacks. */
export function captureDraft(capture: BugCaptureView, current?: BugCaptureDraft): BugCaptureDraft {
  const base: BugCaptureDraft = current ?? capture.draft ?? {
    title: capture.suggestedTitle,
    checks: [],
    requestRules: capture.requests.map((row) => ({ requestKey: row.key, check: row.defaultCheck, sentOnce: row.defaultSentOnce })),
    valueChecks: []
  };
  const covered = new Set(base.checks.map((check) => check.pickIndex));
  const added = capture.picks.filter((pick) => !covered.has(pick.index)).map(defaultCheck);
  const known = new Set(base.requestRules.map((rule) => rule.requestKey));
  const rules = [
    ...base.requestRules.filter((rule) => capture.requests.some((row) => row.key === rule.requestKey)),
    ...capture.requests.filter((row) => !known.has(row.key)).map((row) => ({ requestKey: row.key, check: row.defaultCheck, sentOnce: row.defaultSentOnce }))
  ];
  return { ...base, checks: [...base.checks.filter((check) => capture.picks.some((pick) => pick.index === check.pickIndex)), ...added], requestRules: rules };
}

export interface CaptureSaveState {
  /** Save and reproduce is available. */
  reproducible: boolean;
  /** Why it is not, in a few words. */
  reason?: string;
  /** Save without a check is available. */
  canSaveEvidence: boolean;
}

export function captureSaveState(
  draft: BugCaptureDraft,
  preview: BugCapturePreview | undefined,
  capture: BugCaptureView,
  pending: boolean
): CaptureSaveState {
  const titled = draft.title.trim().length > 0;
  if (!titled) return { reproducible: false, reason: 'Name the bug first', canSaveEvidence: false };
  if (capture.partial) return { reproducible: false, reason: capture.partial, canSaveEvidence: true };
  const unfilled = draft.checks.find((check) => (check.template === 'equals' || check.template === 'contains') && !check.expected?.trim());
  if (unfilled) return { reproducible: false, reason: 'Write what it should read', canSaveEvidence: true };
  if (pending || !preview || preview.draftRevision !== capture.draftRevision) return { reproducible: false, canSaveEvidence: true };
  if (!preview.reproducible) return { reproducible: false, reason: preview.reason ?? 'These checks cannot be reproduced', canSaveEvidence: true };
  return { reproducible: true, canSaveEvidence: true };
}

/** The request rows' check choices, in the order the select lists them. */
export const REQUEST_CHECK_OPTIONS: Array<{ value: 'success' | 'answered' | 'none'; label: string }> = [
  { value: 'success', label: 'Should succeed' },
  { value: 'answered', label: 'Should be answered' },
  { value: 'none', label: 'Not checked' }
];

export const CHECK_TEMPLATE_OPTIONS: Array<{ value: BugCaptureCheckDraft['template']; label: string }> = [
  { value: 'equals', label: 'Should read' },
  { value: 'contains', label: 'Should contain' },
  { value: 'visible', label: 'Should be visible' },
  { value: 'hidden', label: 'Should be hidden' },
  { value: 'count', label: 'Should appear' }
];

/** The Review brief's Bug block: the bug's word, what was observed, and the scope. */
export function reviewBehaviour(view: BugCaseView | undefined): { word: string; tone: Tone; lines: string[]; scope?: string } | undefined {
  if (!view?.version) return undefined;
  const lines = [...(view.before ?? []), ...(view.after ?? [])];
  if (lines.length === 0) return undefined;
  const status = describeBugStatus(view.gate);
  return {
    word: status.word,
    tone: status.tone,
    lines,
    ...(view.scopeLine ? { scope: view.scopeLine } : {})
  };
}
