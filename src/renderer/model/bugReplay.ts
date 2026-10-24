import type {
  BoardBugReplaySummary,
  BugCaptureCheckDraft,
  BugCaptureDraft,
  BugCapturePickView,
  BugCapturePreview,
  BugCaptureView,
  BugCaseAction,
  BugCaseView,
  BugCheckResult,
  BugExpectationEdit,
  BugExpectationsDraft,
  BugExpectationsPreview,
  BugExpectationView,
  BugRecordingPhase,
  BugRecordingSessionView,
  BugReplayGateProjection,
  BugReplayGateState,
  BugReplayRunView,
  BugReplayWaitReason,
  BugStartStep,
  BugStepView
} from '../../shared/bugReplay';
import { bugCountParts, bugReason, bugStateWord, suggestBugTitle } from '../../shared/bugReplayClaims';
import { formatClock } from './timeAgo';
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
}

export function describeBugStatus(gate: BugGate): BugStatus {
  const word = bugStateWord(gate);
  return {
    word: word.word,
    tone: word.tone === 'working' ? 'info' : word.tone,
    inFlight: word.tone === 'working'
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
      return 'Reproduce again';
    case 'record-again':
      return 'Record again';
    case 'allow-runs':
      return 'Approve replays';
    case 'always-allow-runs':
      return 'Always approve in this repository';
    case 'unlock-secrets':
      return 'Unlock secrets';
    case 'use-new-env-files':
      return (view?.envFilesChanged?.length ?? 0) > 1 ? 'Use the new env files' : 'Use the new env file';
    case 'keep-browser-storage':
      return view?.keepBrowserStorage ? 'Clear browser storage on reload' : 'Keep browser storage on reload';
    case 'edit-expectations':
      return 'Edit expectations';
    case 'save-without-check':
      return 'Keep steps only';
    case 'remove':
      return 'Remove bug';
    case 'cancel-run':
      return 'Cancel replays';
  }
}

/** What an action's control says while it runs. */
export function bugActionPendingLabel(action: BugCaseAction, view?: Parameters<typeof bugActionLabel>[1]): string {
  switch (action) {
    case 'send-to-agent':
      return 'Sending…';
    case 'verify-again':
    case 'run-again':
      return 'Queuing…';
    case 'record-again':
      return 'Starting…';
    case 'allow-runs':
    case 'always-allow-runs':
      return 'Approving…';
    case 'cancel-run':
      return 'Canceling…';
    default:
      return bugActionLabel(action, view);
  }
}

export interface BugActionLayout {
  primary?: BugCaseAction;
  secondary: BugCaseAction[];
  /** Declining an approval, which goes first as every approval's decline does. */
  decline?: BugCaseAction;
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
  NOT_REPRODUCED: ['record-again', 'run-again', 'edit-expectations'],
  FLAKY: ['record-again', 'send-to-agent'],
  REPRODUCTION_BLOCKED: ['use-new-env-files', 'run-again', 'record-again'],
  VERIFYING: ['cancel-run'],
  FIX_VERIFIED: [],
  STILL_FAILING: ['send-to-agent', 'verify-again'],
  COULDNT_VERIFY: ['use-new-env-files', 'verify-again', 'send-to-agent'],
  STALE: ['verify-again']
};

/** Replays waiting on approval hold the step alone: approving for now, keeping it, and declining. */
const APPROVAL_BUTTONS: BugCaseAction[] = ['allow-runs', 'always-allow-runs', 'cancel-run'];

/** The actions as buttons and a menu: a decision the bug waits on leads, then the state's own. */
export function layoutBugActions(actions: BugCaseAction[], state: BugReplayGateState): BugActionLayout {
  const offered = new Set(actions);
  const approval = offered.has('allow-runs');
  const buttons = approval
    ? APPROVAL_BUTTONS.filter((action) => offered.has(action))
    : [...(offered.has('unlock-secrets') ? ['unlock-secrets' as const] : []), ...STATE_BUTTONS[state].filter((action) => offered.has(action))].slice(0, 3);
  const shown = new Set<BugCaseAction>(buttons);
  const decline = approval && offered.has('cancel-run') ? 'cancel-run' : undefined;
  return {
    ...(buttons[0] ? { primary: buttons[0] } : {}),
    secondary: buttons.slice(1).filter((action) => action !== decline),
    ...(decline ? { decline } : {}),
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
  /** "Before" (the recorded code) or "After" (the code with the fix). */
  kind: 'Before' | 'After';
  /** It checked expectations the person has since changed: earlier context, never the current result. */
  earlier: boolean;
  word: string;
  tone: Tone;
  inFlight: boolean;
  detail?: string;
  /** When it settled or started, for the row's age. */
  at: string;
  /** How long it ran, once it settled. */
  durationMs?: number;
}

/** The replays a bug lists, newest first; one that checked earlier expectations keeps its word but no tone. */
export function bugRunRows(runs: BugReplayRunView[], currentVersionId?: string): BugRunRow[] {
  return runs
    .filter((run) => run.kind !== 'RECORD')
    .slice(0, 8)
    .map((run) => {
      // A control run replays the recorded code too: it is a before run.
      const kind = run.kind === 'CANDIDATE' ? 'After' : 'Before';
      const earlier = Boolean(currentVersionId && run.versionId && run.versionId !== currentVersionId);
      const settled = run.state === 'SETTLED' && run.outcome;
      const word = settled ? OUTCOME_WORDS[run.outcome!] : run.waitingFor ? WAIT_WORDS[run.waitingFor] : run.phase ?? (run.state === 'QUEUED' ? 'Queued' : 'Running');
      const tone: Tone = earlier && settled ? 'neutral'
        : !settled
          ? run.waitingFor === 'APPROVAL' || run.waitingFor === 'KEYSTORE' ? 'action' : 'info'
          : run.outcome === 'PASSED' ? 'success'
            : run.outcome === 'FAILED' ? 'error'
              : ['ENVIRONMENT_FAILED', 'BLOCKED', 'PROTECTED_INPUT_CHANGED', 'ENV_FILES_CHANGED'].includes(run.outcome!) ? 'action'
                : 'neutral';
      const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
      const ended = run.settledAt ? Date.parse(run.settledAt) : NaN;
      return {
        id: run.id,
        kind,
        earlier,
        word,
        tone,
        inFlight: !settled && !run.waitingFor,
        ...(run.failure?.detail && run.outcome !== 'CANCELED' && run.outcome !== 'SUPERSEDED' ? { detail: run.failure.detail } : {}),
        at: run.settledAt ?? run.startedAt ?? run.queuedAt,
        ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? { durationMs: ended - started } : {})
      };
    });
}

/** A duration in the app's words: "14 s", "2 min 5 s". */
/** The Replays disclosure's summary: what the replays support, one polarity per side. */
export function bugReplaysSummary(gate: Pick<BugReplayGateProjection, 'baseline' | 'candidate' | 'state'>): string[] {
  const parts = bugCountParts(gate);
  return [
    parts.reproduced ? `Reproduced ${parts.reproduced.count} of ${parts.reproduced.total}` : undefined,
    parts.passed ? `Passed ${parts.passed.count} of ${parts.passed.total}` : undefined
  ].filter((part): part is string => Boolean(part));
}

export interface BugResultRow {
  id: string;
  statement: string;
  before?: BugCheckResult;
  after?: BugCheckResult;
}

export interface BugResultsTable {
  rows: BugResultRow[];
  /** A fix was checked: the After column shows. */
  hasAfter: boolean;
  /** The After results are about code that changed since, or could not be checked again. */
  afterEarlier: boolean;
}

// Changing expectations

/**
 * The expectations editor: a saved bug's rows as the person left them, and the expectations they
 * removed. Saving it makes the bug's next version, which reproduces the bug again.
 */
export interface ExpectationsEditor {
  versionId: string;
  rows: BugExpectationView[];
  removed: string[];
}

export function openExpectationsEditor(version: Pick<NonNullable<BugCaseView['version']>, 'id' | 'expectations'>): ExpectationsEditor {
  return { versionId: version.id, rows: version.expectations, removed: [] };
}

/** The rows still listed: a request stays while its status or Sent once does. */
export function shownExpectationRows(editor: ExpectationsEditor): Array<{ row: BugExpectationView; index: number }> {
  const removed = new Set(editor.removed);
  return editor.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === 'request'
      ? Boolean((row.status && !removed.has(row.status.id)) || (row.sentOnceId && !removed.has(row.sentOnceId)))
      : !removed.has(row.id));
}

export function updateExpectationRow(editor: ExpectationsEditor, index: number, row: BugExpectationView): ExpectationsEditor {
  return { ...editor, rows: editor.rows.map((current, position) => (position === index ? row : current)) };
}

export function keepExpectation(editor: ExpectationsEditor, id: string, kept: boolean): ExpectationsEditor {
  const others = editor.removed.filter((candidate) => candidate !== id);
  return { ...editor, removed: kept ? others : [...others, id] };
}

/** Removes a row's expectations; a request's go with the values that read its answer. */
export function removeExpectationRow(editor: ExpectationsEditor, row: BugExpectationView): ExpectationsEditor {
  const ids = row.kind === 'request' ? [row.status?.id, row.sentOnceId, ...row.valueIds].filter((id): id is string => Boolean(id)) : [row.id];
  return { ...editor, removed: [...new Set([...editor.removed, ...ids])] };
}

/** What the editor would save: each kept expectation as the person left it. */
export function expectationsDraft(editor: ExpectationsEditor): BugExpectationsDraft {
  const removed = new Set(editor.removed);
  const expectations: BugExpectationEdit[] = [];
  for (const row of editor.rows) {
    switch (row.kind) {
      case 'element':
        if (removed.has(row.id)) break;
        expectations.push({
          kind: 'element',
          id: row.id,
          template: row.template,
          ...(row.expected !== undefined ? { expected: row.expected } : {}),
          ...(row.count !== undefined ? { count: row.count } : {}),
          alsoAfterReload: row.alsoAfterReload
        });
        break;
      case 'request':
        if (row.status && !removed.has(row.status.id)) expectations.push({ kind: 'status', id: row.status.id, check: row.status.check });
        if (row.sentOnceId && !removed.has(row.sentOnceId)) expectations.push({ kind: 'keep', id: row.sentOnceId });
        break;
      case 'value':
        if (!removed.has(row.id)) expectations.push({ kind: 'value', id: row.id, expected: row.expected });
        break;
      default:
        if (!removed.has(row.id)) expectations.push({ kind: 'keep', id: row.id });
    }
  }
  return { versionId: editor.versionId, expectations };
}

export interface ExpectationsSaveState {
  canSave: boolean;
  /** Why saving is not available, when that is known. */
  reason?: string;
}

/**
 * Whether the editor's draft can be saved: it changes something, and the recording still shows a
 * bug against it. While a newer preview is on its way the last answer stands; the save is checked
 * again, so a stale yes can only end in its reason.
 */
export function expectationsSaveState(changed: boolean, preview: BugExpectationsPreview | undefined): ExpectationsSaveState {
  // An untouched form and its disabled Save say it already: there is nothing to save.
  if (!changed) return { canSave: false };
  // Typed but the same once read as the case reads it, such as spaces around a value.
  if (preview?.changed === false) return { canSave: false, reason: 'No changes' };
  if (!preview) return { canSave: false };
  if (!preview.reproducible) return { canSave: false, reason: preview.reason ?? 'These expectations cannot be reproduced' };
  return { canSave: true };
}

/** The Expected, Before and After table: what each expectation showed before the fix and after it. */
export function bugResultsTable(view: Pick<BugCaseView, 'version' | 'gate'>): BugResultsTable | undefined {
  const checks = view.version?.checks ?? [];
  if (checks.length === 0) return undefined;
  const rows = checks.map((check) => ({
    id: check.id,
    statement: check.statement,
    ...(check.before ? { before: check.before } : {}),
    ...(check.after ? { after: check.after } : {})
  }));
  const hasAfter = rows.some((row) => row.after);
  return { rows, hasAfter, afterEarlier: hasAfter && (view.gate.state === 'STALE' || view.gate.state === 'COULDNT_VERIFY') };
}

/** Steps as a checklist: how far a replay got, or the startup of a clean copy. */
export interface BugChecklistStep {
  step: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PENDING';
}

/** A replay's steps: done up to where it stopped, the failed step marked, the rest not run. */
export function runStepList(steps: BugStepView[], run: Pick<BugReplayRunView, 'state' | 'outcome' | 'failure'>): { steps: BugChecklistStep[]; failedIndex?: number } {
  const settled = run.state === 'SETTLED';
  const failedIndex = run.failure?.stepIndex;
  const reachedChecks = settled && (run.outcome === 'REPRODUCED' || run.outcome === 'NOT_REPRODUCED' || run.outcome === 'PASSED' || (run.outcome === 'FAILED' && failedIndex === undefined));
  return {
    steps: steps.map((step, index) => ({
      step: step.text,
      status: reachedChecks || (failedIndex !== undefined && index < failedIndex) ? 'COMPLETED' : 'PENDING'
    })),
    ...(failedIndex !== undefined && failedIndex < steps.length ? { failedIndex } : {})
  };
}

/** The clean copy's start as a checklist, with the failed step marked. */
export function startStepList(progress: BugStartStep[]): { steps: BugChecklistStep[]; failedIndex?: number } {
  const failedIndex = progress.findIndex((step) => step.state === 'failed');
  return {
    steps: progress.map((step) => ({
      step: step.label,
      status: step.state === 'done' ? 'COMPLETED' : step.state === 'active' ? 'IN_PROGRESS' : 'PENDING'
    })),
    ...(failedIndex >= 0 ? { failedIndex } : {})
  };
}

/** The verdict Mark done displayed, sent so a verdict about code that changed since is caught. */
export function displayedBugVerdict(gate: BugReplayGateProjection | undefined): { caseId: string; treeId: string } | undefined {
  return gate?.state === 'FIX_VERIFIED' && gate.verdictTreeId ? { caseId: gate.caseId, treeId: gate.verdictTreeId } : undefined;
}

// Recording


export function recordingTitle(recording: BugRecordingSessionView): string {
  switch (recording.phase) {
    case 'CHECKING':
    case 'STARTING':
      return 'Starting the app';
    case 'CHOOSING_ENV_FILES':
    case 'NEEDS_APPROVAL':
    case 'FAILED':
      // The card in the page's place carries the step, or what went wrong.
      return 'Record a bug';
    case 'INTERRUPTED':
      // The notice beside the steps says why; the composer's foot holds the choices.
      return 'Recording stopped';
    case 'RECORDING':
      return 'Recording';
    case 'MARKING':
      return recording.detail ? "Point at what's wrong" : 'Mark the bug';
    case 'SAVING':
      return 'Saving the bug';
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

/** The clock since an ISO time: m:ss or h:mm:ss, in tabular figures. */
export function clockSince(fromIso: string | undefined, now: number): string | undefined {
  const start = fromIso ? Date.parse(fromIso) : NaN;
  return Number.isFinite(start) ? formatClock(now - start) : undefined;
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

/**
 * The draft the composer opens with, or the current one with the picks it has not taken in yet:
 * each new pick joins with its own expectation, and an expectation the person removed stays
 * removed when they point at another element.
 */
export function captureDraft(capture: BugCaptureView, current?: BugCaptureDraft): BugCaptureDraft {
  const base: BugCaptureDraft = current ?? capture.draft ?? {
    title: capture.suggestedTitle,
    checks: [],
    requestRules: capture.requests.map((row) => ({ requestKey: row.key, check: row.defaultCheck, sentOnce: row.defaultSentOnce })),
    valueChecks: []
  };
  const covered = new Set(base.checks.map((check) => check.pickIndex));
  const added = capture.picks.filter((pick) => !covered.has(pick.index) && pick.index >= (base.picksSeen ?? 0)).map(defaultCheck);
  const known = new Set(base.requestRules.map((rule) => rule.requestKey));
  const rules = [
    ...base.requestRules.filter((rule) => capture.requests.some((row) => row.key === rule.requestKey)),
    ...capture.requests.filter((row) => !known.has(row.key)).map((row) => ({ requestKey: row.key, check: row.defaultCheck, sentOnce: row.defaultSentOnce }))
  ];
  return {
    ...base,
    checks: [...base.checks.filter((check) => capture.picks.some((pick) => pick.index === check.pickIndex)), ...added],
    requestRules: rules,
    picksSeen: capture.picks.length
  };
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
  capture: BugCaptureView
): CaptureSaveState {
  const titled = draft.title.trim().length > 0;
  if (!titled) return { reproducible: false, reason: 'Name the bug first', canSaveEvidence: false };
  if (capture.partial) return { reproducible: false, reason: capture.partial, canSaveEvidence: true };
  const unfilled = draft.checks.find((check) => (check.template === 'equals' || check.template === 'contains') && !check.expected?.trim());
  if (unfilled) return { reproducible: false, reason: 'Write what it should read', canSaveEvidence: true };
  // While a newer preview is on its way, the last verdict for these picks stands: the save
  // itself is checked again, so a stale yes can only end in its reason.
  if (!preview || preview.draftRevision !== capture.draftRevision) return { reproducible: false, canSaveEvidence: true };
  if (!preview.reproducible) return { reproducible: false, reason: preview.reason ?? 'These expectations cannot be reproduced', canSaveEvidence: true };
  return { reproducible: true, canSaveEvidence: true };
}

/** The request rows' expectations, in the order the select lists them. */
export const REQUEST_CHECK_OPTIONS: Array<{ value: 'success' | 'answered'; label: string }> = [
  { value: 'answered', label: 'Should get no server error' },
  { value: 'success', label: 'Should succeed' }
];

/** The suggested name for the bug from its first expectation; empty without one. */
export function suggestedCaptureTitle(capture: Pick<BugCaptureView, 'picks'>, draft: Pick<BugCaptureDraft, 'checks'>): string {
  const check = draft.checks[0];
  const pick = check ? capture.picks.find((item) => item.index === check.pickIndex) : undefined;
  if (!check || !pick) return '';
  return suggestBugTitle({
    label: pick.label,
    template: check.template,
    ...(check.expected !== undefined ? { expected: check.expected } : {}),
    ...(check.count !== undefined ? { count: check.count } : {}),
    shown: pick.value ?? pick.text
  });
}

export const CHECK_TEMPLATE_OPTIONS: Array<{ value: BugCaptureCheckDraft['template']; label: string }> = [
  { value: 'equals', label: 'Should read' },
  { value: 'contains', label: 'Should contain' },
  { value: 'visible', label: 'Should be visible' },
  { value: 'hidden', label: 'Should be hidden' },
  { value: 'count', label: 'Should appear' }
];

/**
 * The Review brief's Bug block: the bug's word and what was observed before and after the fix.
 * What the replays could not see is stated where a replay is opened, not beside the diff.
 */
export function reviewBehaviour(view: BugCaseView | undefined): { word: string; lines: string[] } | undefined {
  if (!view?.version) return undefined;
  const lines = [...(view.before ?? []), ...(view.after ?? [])];
  if (lines.length === 0) return undefined;
  return { word: describeBugStatus(view.gate).word, lines };
}
