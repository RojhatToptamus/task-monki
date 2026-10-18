import type { BugCaseEnvironment } from './bugCase';
import type { BugRecordingTargetFacts } from './bugRecording';

/**
 * Bug Replay: record a bug in a clean copy of a task's app, reproduce it with Task Monki's own
 * runner, hand it to the task's agent, and verify the fix on frozen code. Verdicts are evidence
 * Task Monki observed; provider claims about the bug stay telemetry.
 */

export type BugReplayRunKind = 'RECORD' | 'BASELINE' | 'CANDIDATE';

export type BugReplayRunState =
  | 'QUEUED'
  | 'CHECKING'
  | 'WAITING'
  | 'PREPARING_SOURCE'
  | 'STARTING_ENVIRONMENT'
  | 'WARMING_UP'
  | 'RECORDING'
  | 'EXECUTING'
  | 'COLLECTING'
  | 'TEARING_DOWN'
  | 'SETTLED';

export type BugReplayWaitReason = 'APPROVAL' | 'CAPACITY' | 'KEYSTORE' | 'AGENT_TURN' | 'QUALIFICATION' | 'ENV_FILES';

export type BugReplayRunOutcome =
  | 'CAPTURED'
  | 'DISCARDED'
  | 'REPRODUCED'
  | 'NOT_REPRODUCED'
  | 'PASSED'
  | 'FAILED'
  | 'ENVIRONMENT_FAILED'
  | 'BLOCKED'
  | 'PROTECTED_INPUT_CHANGED'
  | 'ENV_FILES_CHANGED'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'SUPERSEDED';

/** Only these outcomes count towards a qualification or a verification attempt. */
export const COUNTED_BUG_REPLAY_OUTCOMES: ReadonlySet<BugReplayRunOutcome> = new Set([
  'REPRODUCED',
  'NOT_REPRODUCED',
  'PASSED',
  'FAILED'
]);

export type BugReplayOutcomeReason =
  | 'STEP_FAILED'
  | 'CHECK_FAILED'
  | 'SIGNATURE_MISMATCH'
  | 'RELOAD_TARGET_MISSING'
  | 'RELOAD_VALUE_CHANGED'
  | 'APP_FAILED'
  | 'SOURCE_CHANGED'
  | 'NOT_A_CLEAN_START'
  | 'START_FAILED'
  | 'RUNNER_FAILED'
  | 'IMAGE_MISSING'
  | 'DOCKER_UNAVAILABLE'
  | 'INELIGIBLE'
  | 'AUTHORIZATION_REFUSED'
  | 'BASELINE_UNAVAILABLE'
  | 'NOT_REPRODUCED'
  | 'CANCELED_BY_PERSON'
  | 'SHUTDOWN'
  /** A check found its element another, weaker way than on the recorded code. */
  | 'TARGET_CHANGED';

export interface BugReplayRunFailure {
  reason: BugReplayOutcomeReason;
  /** One sentence, already in the product's words: "Could not complete step 4: "Apply" was not found". */
  detail: string;
  stepIndex?: number;
  assertionId?: string;
}

/** What one counted run observed for one check. */
/**
 * Where an element sat in a screenshot, in CSS pixels of the case's viewport, so a surface can
 * outline it at any size the screenshot is drawn.
 */
export interface BugElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BugReplayAssertionObservation {
  assertionId: string;
  passed: boolean;
  /** Observed text, value, visibility, count, status or JSON, in words. */
  observed?: string;
  /** The same observation as a value alone, for a column: '"$40.00"', '200', 'Not shown'. */
  value?: string;
  afterReload?: { passed: boolean; observed?: string; value?: string };
  /** Which of the target's candidates found the element on the page: 0 is the first. */
  locator?: number;
  /** Where the checked element sat in the run's final screenshot. */
  box?: BugElementBox;
}

export interface BugReplayRunRecord {
  id: string;
  taskId: string;
  kind: BugReplayRunKind;
  caseId?: string;
  versionId?: string;
  /** Runs of one qualification or one verification attempt share a set. */
  setId?: string;
  /** A verification attempt's extra baseline run that checks the bug still shows on the recorded code. */
  control?: boolean;
  state: BugReplayRunState;
  waitingFor?: BugReplayWaitReason;
  outcome?: BugReplayRunOutcome;
  counted: boolean;
  failure?: BugReplayRunFailure;
  /** The Previewhost environment name, `br-<12 hex>`. */
  name: string;
  previewAttemptId?: string;
  /** The captured source tree the run executes. */
  inputTreeId?: string;
  readyTreeId?: string;
  endTreeId?: string;
  /** The completed agent turn whose tree a candidate verifies. */
  agentRunId?: string;
  observations: BugReplayAssertionObservation[];
  /** Facts about the run's environment and boundary, in words, for Details. */
  facts: string[];
  fileIds: string[];
  phase?: string;
  queuedAt: string;
  startedAt?: string;
  settledAt?: string;
  revision: number;
}

export type BugReplayGateState =
  | 'CAPTURED'
  | 'REPRODUCING'
  | 'REPRODUCED'
  | 'NOT_REPRODUCED'
  | 'FLAKY'
  | 'REPRODUCTION_BLOCKED'
  | 'VERIFYING'
  | 'FIX_VERIFIED'
  | 'STILL_FAILING'
  | 'COULDNT_VERIFY'
  | 'STALE';

export type BugReplayHandoffStatus = 'QUEUED' | 'RUNNING' | 'HELD';

/**
 * The task-level projection of the active bug. Every BUG_ event carries the whole projection
 * computed after its change; the reducer copies it and never decides a gate itself.
 */
export interface BugReplayGateProjection {
  caseId: string;
  title: string;
  state: BugReplayGateState;
  versionId?: string;
  version?: number;
  /** The one fact the Inbox and the finish row show for this state. */
  fact?: string;
  baseline?: { matched: number; total: number; treeId?: string };
  candidate?: { passed: number; total: number; treeId?: string; agentRunId?: string };
  /** The tree the current verdict is about. */
  verdictTreeId?: string;
  activeRun?: { runId: string; kind: BugReplayRunKind; waitingFor?: BugReplayWaitReason };
  handoff?: { handoffId: string; runId?: string; status: BugReplayHandoffStatus; since: string };
  lastSentAt?: string;
  pendingProposal?: boolean;
  updatedAt: string;
}

export interface BoardBugReplaySummary {
  state: BugReplayGateState;
  title: string;
  fact?: string;
  waitingFor?: BugReplayWaitReason;
  /** True while a bug follow-up is queued or running. */
  fixing: boolean;
}

/**
 * A setup input a case version keeps fixed: a whole file by blob id, one member of a JSON file
 * (a package script) by the SHA-256 of its canonical value, or the absence of further tracked
 * `.env*` files in a directory beyond those pinned as files.
 */
export type BugReplayProtectedInput =
  | { kind: 'file'; path: string; blob: string }
  | { kind: 'jsonMember'; path: string; pointer: string; valueSha256: string | null }
  | { kind: 'absent'; directory: string; present: string[] };

/** The reference a follow-up or queued instruction carries when it hands the bug to the agent. */
export interface BugCaseReference {
  caseId: string;
  versionId?: string;
  captureId: string;
}

export type BugCaseStatus = 'ACTIVE' | 'REPLACED' | 'REMOVED';

export type BugCaseRevisionKind =
  | 'INITIAL'
  | 'EXPECTATION_CHANGED'
  | 'SIGNATURE_RELAXED'
  | 'SETUP_ADOPTED'
  | 'ENV_FILES_ADOPTED'
  | 'RECIPE_ADOPTED';

export type BugCaseDecisionKind = 'PROPOSED' | 'APPROVED' | 'SUPERSEDED' | 'WITHDRAWN' | 'REPLACED' | 'REMOVED';

/** One request the marked action sent, as the capture modal lists it. */
export interface BugCaptureRequestRow {
  key: string;
  method: string;
  role: string;
  pathTemplate: string;
  path: string;
  queryKeys: string[];
  /** Observed status, or "no response". */
  observed: string;
  count: number;
  succeeded: boolean;
  defaultCheck: 'success' | 'answered' | 'none';
  defaultSentOnce: boolean;
}

/** A JSON value in a request or response of the marked action that matches the picked wrong value. */
export interface BugCaptureValueRow {
  requestKey: string;
  side: 'request' | 'response';
  pointer: string;
  /** Canonical JSON of what was observed. */
  observed: string;
  /** Prefilled from the person's expectation, in the observed value's representation. */
  suggested?: string;
}

export interface BugCapturePickView {
  index: number;
  target: BugRecordingTargetFacts;
  text: string;
  value?: string;
  visible: boolean;
  count: number;
  /** Tokens of `text` that look volatile (dates, times, ids). */
  volatileTokens: string[];
  /** A short name for the element, e.g. `"Total"` or the test id. */
  label: string;
  /** Where it sat in the capture's screenshot. */
  box?: BugElementBox;
}

export type BugCaptureCheckTemplate = 'equals' | 'contains' | 'visible' | 'hidden' | 'count';

export interface BugCaptureCheckDraft {
  pickIndex: number;
  template: BugCaptureCheckTemplate;
  expected?: string;
  count?: number;
  alsoAfterReload: boolean;
}

export interface BugCaptureRequestRule {
  requestKey: string;
  check: 'success' | 'answered' | 'none';
  sentOnce: boolean;
}

export interface BugCaptureValueCheck {
  requestKey: string;
  side: 'request' | 'response';
  pointer: string;
  /** JSON text of the expected value. */
  expected: string;
}

/** The capture modal's current content; saving it is the person's approval of the expectation. */
export interface BugCaptureDraft {
  title: string;
  statement?: string;
  checks: BugCaptureCheckDraft[];
  requestRules: BugCaptureRequestRule[];
  valueChecks: BugCaptureValueCheck[];
  /** The page should raise no uncaught error. */
  noPageError?: boolean;
  /**
   * How many picks this draft has taken in. A later pick joins it with its own expectation; an
   * earlier one whose expectation the person removed stays out.
   */
  picksSeen?: number;
}

export type BugRecordingPhase =
  | 'CHECKING'
  | 'CHOOSING_ENV_FILES'
  | 'NEEDS_APPROVAL'
  | 'STARTING'
  | 'RECORDING'
  | 'MARKING'
  | 'SAVING'
  | 'FAILED'
  | 'INTERRUPTED';

export interface BugRecordingEnvFileChoice {
  name: string;
  directory: string;
  include: boolean;
}

/** A fact the person reads before approving clean runs: "Runs as", "Your user, without a sandbox". */
export interface BugReplayLeaseFact {
  label: string;
  value: string;
}

export interface BugReplayLeaseRequest {
  /** Exactly what the facts and commands state; approving names it, so nothing else is approved. */
  approvalDigest: string;
  title: string;
  /** The execution boundary first, then when runs happen, the approval, code, data, secrets, files and network. */
  facts: BugReplayLeaseFact[];
  commands: Array<{ service: string; command: string; directory: string }>;
  sameAsRunningPreview: boolean;
}

/** What a replayed step does; `step` when an older record kept only its words. */
export type BugStepKind = 'navigate' | 'reload' | 'click' | 'check' | 'uncheck' | 'fill' | 'select' | 'press' | 'dialog' | 'step';

/** A step a clean run replays, in the product's words: 'Click "Apply coupon"'. */
export interface BugStepView {
  kind: BugStepKind;
  text: string;
}

/**
 * One row of a recording's live timeline: a step the person took, an input a clean run can't
 * replay, or something the page did that a person looks for when a bug shows (a failed or
 * refused request, an uncaught error).
 */
export interface BugTimelineEntry {
  /** Stable for the row while the recording lasts. */
  id: string;
  kind: BugStepKind | 'unsupported' | 'request' | 'error';
  text: string;
  /** The step's number in a replay, on steps. */
  step?: number;
  /** A server error or no answer is an error; a refused outside host is a warning; a 4xx answer has no tone. */
  tone?: 'error' | 'warning';
}

export interface BugRecordingTimeline {
  /** The newest entries, oldest first. */
  entries: BugTimelineEntry[];
  /** Steps a clean run replays, in all. */
  steps: number;
  /** Entries before the first one shown. */
  omitted: number;
}

/** One step of starting a clean copy, read by its mark. */
export interface BugStartStep {
  id: string;
  /** "Copy this task's files", "Install dependencies", "Start web", "Open the app". */
  label: string;
  state: 'pending' | 'active' | 'done' | 'failed';
  startedAt?: string;
  endedAt?: string;
}

export interface BugRecordingSessionView {
  sessionId: string;
  runId: string;
  phase: BugRecordingPhase;
  /** The observed step of preparation, e.g. "Installing dependencies". */
  detail?: string;
  /** While the clean copy starts: its steps, in order. */
  progress?: BugStartStep[];
  /** While recording: what was recorded so far. */
  timeline?: BugRecordingTimeline;
  /** Nothing was recorded after the start page yet, so the recording can start on another page. */
  startEditable?: boolean;
  startedAt: string;
  recordingStartedAt?: string;
  lastInputAt?: string;
  envFiles?: BugRecordingEnvFileChoice[];
  lease?: BugReplayLeaseRequest;
  failure?: { title: string; detail: string; action?: 'ask-preview-agent' | 'retry' | 'record-again'; command?: string };
  /** Facts the toolbar shows quietly, e.g. "Step 6 can't be replayed (⌘K)". */
  coverageNote?: string;
  routePath?: string;
  viewport?: { width: number; height: number };
  passwordTyped?: boolean;
  /** Present while marking: what the modal edits. */
  capture?: BugCaptureView;
}

export interface BugCaptureView {
  draftRevision: number;
  picks: BugCapturePickView[];
  requests: BugCaptureRequestRow[];
  valueRows: BugCaptureValueRow[];
  otherRequests: string[];
  pageErrors: string[];
  /** The marked action raised an uncaught error: "No page error" can reproduce the bug. */
  uncaughtError: boolean;
  stepCount: number;
  steps: BugStepView[];
  screenshotFileId?: string;
  suggestedTitle: string;
  /** The person's draft as last saved by the modal. */
  draft?: BugCaptureDraft;
  /** Why Save and reproduce is not available, when it is not. */
  reproduceBlockedReason?: string;
  partial?: string;
}

export interface BugReplayRunView {
  id: string;
  kind: BugReplayRunKind;
  control?: boolean;
  state: BugReplayRunState;
  phase?: string;
  waitingFor?: BugReplayWaitReason;
  outcome?: BugReplayRunOutcome;
  counted: boolean;
  failure?: BugReplayRunFailure;
  observations: BugReplayAssertionObservation[];
  facts: string[];
  screenshotFileIds: string[];
  treeId?: string;
  queuedAt: string;
  startedAt?: string;
  settledAt?: string;
}

/** What one run, or the recording, observed for a check. */
export interface BugCheckResult {
  held: boolean;
  /** The observed value alone: '"$40.00"', '200', 'Not shown'. */
  value?: string;
  /** The check's second look after a reload, when it has one. */
  afterReload?: { held: boolean; value?: string };
}

export interface BugCaseCheckView {
  id: string;
  /** "Total should read "$45.00"". */
  statement: string;
  inSignature: boolean;
  /** What the recording showed, in words. */
  recorded?: string;
  /** Before the fix: the run that reproduced the bug, or the recording before any run counted. */
  before?: BugCheckResult;
  /** After the fix: the verdict's decisive run, once a fix was checked. */
  after?: BugCheckResult;
}

/** A screenshot the Bug section shows, with where each checked element sat in it. */
export interface BugShotView {
  fileId: string;
  /** The run that took it; absent for the recording's own. */
  runId?: string;
  at: string;
  boxes: Array<{ checkId: string; box: BugElementBox }>;
}

export interface BugCaseView {
  id: string;
  captureId: string;
  title: string;
  statement?: string;
  status: BugCaseStatus;
  keepBrowserStorage: boolean;
  version?: {
    id: string;
    version: number;
    revisionKind: BugCaseRevisionKind;
    checks: BugCaseCheckView[];
    envFiles: string[];
    protectedPaths: string[];
    baselineTreeId: string;
    alsoAfterReload: boolean;
  };
  gate: BugReplayGateProjection;
  /** The recorded steps, in the product's words, with or without a check. */
  steps: BugStepView[];
  /** Lines in the product's words: "Before: total showed $40.00". */
  before?: string[];
  after?: string[];
  countsLine?: string;
  scopeLine?: string;
  boundaryLine?: string;
  /** The candidate changed setup files the bug keeps fixed. */
  changedProtectedPaths?: string[];
  changedSharedSetup?: string[];
  recipeDiffers?: boolean;
  envFilesChanged?: string[];
  screenshotFileIds: string[];
  /** The pair the Bug section compares: before the fix (the reproducing run, or the recording) and after it. */
  shots: { before?: BugShotView; after?: BugShotView };
  partial?: string;
  /** Actions the Bug section offers now, already filtered by state. */
  actions: BugCaseAction[];
  /** Offered actions that cannot run right now, with the reason shown beside them. */
  unavailable?: Partial<Record<BugCaseAction, string>>;
  /** No agent turn has run yet: starting the task's implementation sends the bug with it. */
  startSendsBug?: boolean;
  createdAt: string;
}

export type BugCaseAction =
  | 'send-to-agent'
  | 'verify-again'
  | 'run-again'
  | 'record-again'
  | 'allow-runs'
  | 'always-allow-runs'
  | 'unlock-secrets'
  | 'use-new-env-files'
  | 'keep-browser-storage'
  | 'save-without-check'
  | 'remove'
  | 'cancel-run';

export interface BugReplayEarlierCase {
  id: string;
  title: string;
  status: BugCaseStatus;
  createdAt: string;
  /** When the person removed or replaced it. */
  endedAt: string;
  /** What its recording and runs keep on disk; 0 once its evidence is deleted. */
  evidenceBytes: number;
}

export interface BugReplayAvailability {
  /** Record bug is offered at all (desktop app on macOS, normal task, recipe present). */
  canRecord: boolean;
  /** Why Record bug is disabled, when it is shown but cannot start. */
  recordDisabledReason?: string;
  /** Why Record bug is hidden. */
  hiddenReason?: string;
}

export interface BugReplaySnapshot {
  taskId: string;
  availability: BugReplayAvailability;
  recording?: BugRecordingSessionView;
  activeCase?: BugCaseView;
  /** The current bug's newest runs; `runCount` says how many it has in all. */
  runs: BugReplayRunView[];
  runCount: number;
  earlierCases: BugReplayEarlierCase[];
  /** Present while a clean run waits for the person to allow clean runs of this app. */
  pendingLease?: BugReplayLeaseRequest;
  storage: { usedBytes: number; limitBytes: number };
}

export interface BugReplayTaskRequest {
  taskId: string;
}

/** Replays of one recipe the person approved for a repository until they revoke it, as Settings lists them. */
export interface BugReplayKeptApproval {
  id: string;
  repositoryId: string;
  repositoryName: string;
  /** The commands the person read when they approved. */
  commands: Array<{ service: string; command: string; directory: string }>;
  /** The ignored env files replays get and the outside hosts they call, as the person read them. */
  envFiles: string[];
  calls: string[];
  keptAt: string;
}

export interface BugRecordingRequest extends BugReplayTaskRequest {
  sessionId: string;
}

export interface BugReplayApi {
  getBugReplay(input: BugReplayTaskRequest): Promise<BugReplaySnapshot>;
  startBugRecording(input: BugReplayTaskRequest & { clientOperationId: string }): Promise<BugReplaySnapshot>;
  chooseBugEnvFiles(input: BugRecordingRequest & { include: string[] }): Promise<BugReplaySnapshot>;
  /** Approves what the task asks to run now: for now, or kept for its repository until revoked. */
  allowBugReplayRuns(input: BugReplayTaskRequest & { approvalDigest: string; keep?: boolean }): Promise<BugReplaySnapshot>;
  listBugReplayApprovals(): Promise<BugReplayKeptApproval[]>;
  revokeBugReplayApproval(input: { approvalId: string }): Promise<BugReplayKeptApproval[]>;
  cancelBugRecording(input: BugRecordingRequest): Promise<BugReplaySnapshot>;
  markBug(input: BugRecordingRequest): Promise<BugReplaySnapshot>;
  pickBugCheck(input: BugRecordingRequest & { draft?: BugCaptureDraft }): Promise<BugReplaySnapshot>;
  stopBugPick(input: BugRecordingRequest): Promise<BugReplaySnapshot>;
  returnToBugRecording(input: BugRecordingRequest & { draft?: BugCaptureDraft }): Promise<BugReplaySnapshot>;
  previewBugCapture(input: BugRecordingRequest & { draft: BugCaptureDraft }): Promise<BugCapturePreview>;
  saveBugCapture(input: BugRecordingRequest & {
    draftRevision: number;
    draft: BugCaptureDraft;
    withCheck: boolean;
  }): Promise<BugReplaySnapshot>;
  sendBugToAgent(input: BugReplayTaskRequest & { clientOperationId: string; attachmentDraftId?: string }): Promise<BugReplaySnapshot>;
  runBugBaseline(input: BugReplayTaskRequest): Promise<BugReplaySnapshot>;
  verifyBugFix(input: BugReplayTaskRequest): Promise<BugReplaySnapshot>;
  cancelBugReplayRun(input: BugReplayTaskRequest & { runId: string }): Promise<BugReplaySnapshot>;
  applyBugCaseAction(input: BugReplayTaskRequest & { action: BugCaseAction }): Promise<BugReplaySnapshot>;
  removeBug(input: BugReplayTaskRequest): Promise<BugReplaySnapshot>;
  deleteBugEvidence(input: BugReplayTaskRequest & { caseId: string }): Promise<BugReplaySnapshot>;
  readBugReplayImage(input: BugReplayTaskRequest & { fileId: string }): Promise<{ mimeType: 'image/png'; data: Uint8Array }>;
  checkBugVerdictCurrency(input: BugReplayTaskRequest): Promise<BugVerdictCurrency>;
}

/** What saving the current draft would do, computed by the compiler without saving. */
export interface BugCapturePreview {
  draftRevision: number;
  reproducible: boolean;
  /** Why the draft can only be saved as evidence. */
  reason?: string;
  checks: BugCaseCheckView[];
  /** The capture's value rows, each with the value the draft's expectation suggests. */
  valueRows: BugCaptureValueRow[];
}

export interface BugVerdictCurrency {
  state: 'CURRENT' | 'STALE' | 'UNKNOWN' | 'NONE';
  treeId?: string;
}

/** The recording view's placeholder in the renderer, in CSS pixels. */
export interface BugRecordingViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShowBugRecordingViewRequest {
  taskId: string;
  sessionId: string;
  bounds: BugRecordingViewBounds;
  /** Grows with every show and hide the renderer sends; an older request is ignored. */
  requestId: number;
}

export interface HideBugRecordingViewRequest {
  taskId: string;
  sessionId: string;
  requestId: number;
}

/**
 * Electron-only bridge for the native view a bug is recorded in. The renderer sends identities
 * and bounds; it never sends a URL.
 */
export interface BugRecordingViewApi {
  show(input: ShowBugRecordingViewRequest): Promise<void>;
  hide(input: HideBugRecordingViewRequest): Promise<void>;
  reload(input: { taskId: string; sessionId: string }): Promise<void>;
  /** Before the first step: start the recording on another page of the app. */
  open(input: { taskId: string; sessionId: string; path: string }): Promise<void>;
}

export const BUG_REPLAY_STORAGE_LIMIT_BYTES = 256 * 1024 * 1024;

export const DEFAULT_BUG_CASE_ENVIRONMENT: BugCaseEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'en-US',
  timezoneId: 'UTC'
};
