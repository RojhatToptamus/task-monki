import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git/gitCli';
import { parseConfigurationFile } from '../preview/ApplicationPreviewConfiguration';
import { isCasePath, isCaseQuery, type BugCaseEnvironment } from '../../shared/bugCase';
import type { BugRecordingLogV1, BugRecordingPick } from '../../shared/bugRecording';
import type {
  BugCaptureDraft,
  BugCapturePreview,
  BugCaptureValueRow,
  BugCaptureView,
  BugRecordingEnvFileChoice,
  BugRecordingPhase,
  BugRecordingSessionView,
  BugReplayLeaseRequest,
  BugStartStep
} from '../../shared/bugReplay';
import { DEFAULT_BUG_CASE_ENVIRONMENT } from '../../shared/bugReplay';
import { serviceStoppedSentence } from '../../shared/bugReplayClaims';
import { compileBugCase, describeCapture, numbersIn, suggestValue, BUG_CASE_COMPILER_VERSION } from './BugCaseCompiler';
import type { BugRecordingSessions, BugReplayCore, PendingReplayApproval } from './BugReplayPorts';
import { ceilingFor, versionDigest } from './BugReplayIdentity';
import type { BugCaptureRecord, BugCaseRecord, BugCaseVersionRecord, BugReplayFileRecord, StoredBugReplayRun } from './BugReplayRecords';
import { deriveReplaySpec, replayEnvironmentName, ReplayEligibilityError, staticEligibility, type DerivedReplaySpec } from './ReplayDerivation';
import { ReplayEnvironmentError, type StartedReplayEnvironment } from './ReplayEnvironment';
import { ReplaySourceError } from './ReplaySourceFreezer';
import { isEnvFileName, planProtectedInputs, type RecipeJob } from './ProtectedInputs';
import { leaseRequestFor } from './BugReplayLease';
import { oneLine, redactEvidence } from './BugReplayContext';
import { persistableLog, type RecorderNotice, type RecorderSession } from './recorder/RecorderSession';
import { BUG_REPLAY_FILE_LIMITS } from '../storage/sqlite/SqliteBugReplayStore';

/**
 * One recording at a time: a clean, frozen copy of the task's app on fresh data, shown in an
 * in-app browser with Task Monki's recorder attached. The developer's own preview is never
 * touched. Saving the capture is the person's approval of the expectation.
 */

export interface RecordingViewInput {
  sessionId: string;
  taskId: string;
  /** Origin role → origin; the view refuses every other origin. */
  origins: Record<string, string>;
  startUrl: string;
  environment: BugCaseEnvironment;
  notify: (notice: RecorderNotice | { kind: 'interrupted'; reason: string }) => void;
  /** The recording ended before or while the view opened: the host closes it. */
  signal: AbortSignal;
}

export interface RecordingViewHandle {
  recorder: RecorderSession;
  chromium: string;
  reload(): Promise<void>;
  /** Opens a page of the primary origin, by path and query. */
  open(path: string): Promise<void>;
  close(): Promise<void>;
  /** The page as the person sees it, at the case's size; empty when the view shows nothing. */
  screenshot?(): Promise<Buffer>;
}

/** The Electron host implements this; it owns the view, its session and its debugger. */
export interface RecordingBrowserHost {
  open(input: RecordingViewInput): Promise<RecordingViewHandle>;
}

interface RecordingSession {
  id: string;
  taskId: string;
  run: StoredBugReplayRun;
  phase: BugRecordingPhase;
  detail?: string;
  startedAt: string;
  recordingStartedAt?: string;
  lastInputAt?: string;
  worktreePath: string;
  worktreeId: string;
  treeId?: string;
  recipe?: { name: 'preview.yaml' | 'preview.yml'; text: string; sha256: string };
  envChoices?: BugRecordingEnvFileChoice[];
  included: Array<{ relativePath: string; bytes: Buffer }>;
  derived?: DerivedReplaySpec;
  exportRoot?: string;
  lease?: BugReplayLeaseRequest;
  environment?: StartedReplayEnvironment;
  view?: RecordingViewHandle;
  /** The view's engine, kept after an interruption closes it. */
  chromium?: string;
  controller: AbortController;
  failure?: BugRecordingSessionView['failure'];
  coverageNote?: string;
  routePath?: string;
  passwordTyped?: boolean;
  capture?: {
    log: BugRecordingLogV1;
    screenshot: Buffer;
    pageTitle: string;
    draftRevision: number;
    draft?: BugCaptureDraft;
  };
  idleTimer?: NodeJS.Timeout;
  lengthTimer?: NodeJS.Timeout;
  watchTimer?: NodeJS.Timeout;
  partial?: string;
  launching?: Promise<void>;
  /** Another start page is opening; the start step moves once it has. */
  opening?: boolean;
  /** Counts picks so a pick replaced by a newer one does not end the newer one's pointing. */
  pickToken?: number;
  /** The clean copy's start, step by step, while it starts. */
  start?: StartTracker;
  /** A timeline update waiting to go out; updates are sent at most four times a second. */
  timelineTimer?: NodeJS.Timeout;
}

/** What starting the clean copy has done so far, kept so each step keeps its own times. */
interface StartTracker {
  /** The recipe's services in its order, with what each is called. */
  services: Array<{ id: string; label: string }>;
  states: Map<string, string>;
  copied: boolean;
  opening: boolean;
  times: Map<string, { startedAt?: string; endedAt?: string }>;
  steps: BugStartStep[];
}

const IDLE_LIMIT_MS = 20 * 60_000;
const LENGTH_LIMIT_MS = 60 * 60_000;
const VIEWPORT = DEFAULT_BUG_CASE_ENVIRONMENT.viewport;

export class BugRecordingService implements BugRecordingSessions {
  private session?: RecordingSession;

  constructor(
    private readonly replay: BugReplayCore,
    private readonly host: () => RecordingBrowserHost | undefined,
    private readonly runningPreviewRecipe: (taskId: string) => Promise<string | undefined>
  ) {}

  sessionView(taskId: string): BugRecordingSessionView | undefined {
    const session = this.session;
    if (!session || session.taskId !== taskId) return undefined;
    const view: BugRecordingSessionView = {
      sessionId: session.id,
      runId: session.run.id,
      phase: session.phase,
      startedAt: session.startedAt,
      viewport: { ...VIEWPORT },
      ...(session.detail ? { detail: session.detail } : {}),
      ...(session.recordingStartedAt ? { recordingStartedAt: session.recordingStartedAt } : {}),
      ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
      ...(session.envChoices ? { envFiles: session.envChoices } : {}),
      ...(session.lease && session.phase === 'NEEDS_APPROVAL' ? { lease: session.lease } : {}),
      ...(session.failure ? { failure: session.failure } : {}),
      ...(session.coverageNote ? { coverageNote: session.coverageNote } : {}),
      ...(session.routePath ? { routePath: session.routePath } : {}),
      ...(session.passwordTyped ? { passwordTyped: true } : {})
    };
    if (session.phase === 'STARTING' && session.start) view.progress = session.start.steps.map((step) => ({ ...step }));
    if (session.phase === 'RECORDING' && session.view) {
      view.timeline = session.view.recorder.timeline();
      if (session.view.recorder.onlyStart()) view.startEditable = true;
    }
    if (session.capture) view.capture = this.captureView(session);
    return view;
  }

  busyElsewhere(taskId: string): boolean {
    const session = this.session;
    return Boolean(session && session.taskId !== taskId && session.phase !== 'FAILED' && session.phase !== 'INTERRUPTED');
  }

  /** The current recording's session id when it belongs to the task; the in-app view asks for it. */
  activeSession(taskId: string): string | undefined {
    return this.session?.taskId === taskId ? this.session.id : undefined;
  }

  async start(taskId: string): Promise<void> {
    const available = this.replay.available();
    if (!available.record || !this.host()) throw new Error(available.reason ?? 'Recording needs the desktop app on macOS.');
    if (this.session && this.session.phase !== 'FAILED' && this.session.phase !== 'INTERRUPTED') {
      throw new Error(this.session.taskId === taskId ? 'This task is already recording.' : 'Another task is recording');
    }
    if (this.session) await this.dispose(this.session, 'DISCARDED');
    if (await this.replay.access.agentRunActive(taskId)) throw new Error("The agent is changing this task's files");
    const context = await this.replay.access.context(taskId);
    if (context.task.kind !== 'NORMAL') throw new Error('Bugs are recorded on normal tasks.');
    const run: StoredBugReplayRun = {
      id: randomUUID(),
      taskId,
      kind: 'RECORD',
      state: 'CHECKING',
      counted: false,
      name: replayEnvironmentName(randomBytes(6).toString('hex')),
      observations: [],
      facts: [],
      fileIds: [],
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      revision: 0
    };
    await this.replay.store.write((tx) => this.replay.store.insertRun(tx, run));
    const session: RecordingSession = {
      id: randomUUID(),
      taskId,
      run,
      phase: 'CHECKING',
      detail: 'Copying source',
      startedAt: new Date().toISOString(),
      worktreePath: context.worktree.worktreePath,
      worktreeId: context.worktree.id,
      included: [],
      controller: new AbortController()
    };
    this.session = session;
    this.replay.emitUpdate(taskId);
    this.track(session, this.prepare(session));
  }

  async chooseEnvFiles(sessionId: string, include: string[]): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'CHOOSING_ENV_FILES' || !session.envChoices) throw new Error('This recording is not choosing env files.');
    const chosen = new Set(include);
    session.envChoices = session.envChoices.map((choice) => ({ ...choice, include: chosen.has(choice.name) }));
    session.included = [];
    for (const choice of session.envChoices.filter((item) => item.include)) {
      const bytes = await fs.readFile(path.join(session.worktreePath, choice.name));
      session.included.push({ relativePath: choice.name, bytes });
    }
    this.setPhase(session, 'CHECKING', 'Checking the app');
    this.track(session, this.derive(session));
  }

  pendingApproval(taskId: string): PendingReplayApproval | undefined {
    const session = this.session;
    if (!session || session.taskId !== taskId || session.phase !== 'NEEDS_APPROVAL' || !session.lease || !session.derived) return undefined;
    return { request: session.lease, envFiles: session.included.map((file) => file.relativePath), calls: session.derived.outsideHosts };
  }

  async leaseGranted(taskId: string, approvalDigest: string): Promise<void> {
    const session = this.session;
    if (!session || session.taskId !== taskId || session.phase !== 'NEEDS_APPROVAL' || session.derived?.approvalDigest !== approvalDigest) return;
    this.track(session, this.launch(session));
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.dispose(session, 'DISCARDED');
  }

  async cancelForTask(taskId: string): Promise<void> {
    if (this.session?.taskId === taskId) await this.dispose(this.session, 'DISCARDED');
  }

  /** Task Monki is closing: the recording ends unsaved, which also releases a pick in progress. */
  async shutdown(): Promise<void> {
    if (this.session) await this.dispose(this.session, 'DISCARDED');
  }

  forgetTask(taskId: string): void {
    void taskId;
  }

  async reload(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'RECORDING' || !session.view) return;
    session.view.recorder.noteReload();
    await session.view.reload();
  }

  /**
   * Opens another page of the app before the first step, so the recording starts where the bug
   * is: the start step becomes that page. After the first step the path is the steps' to set.
   */
  async openPage(sessionId: string, path: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'RECORDING' || !session.view || !session.environment) throw new Error('Open a page while recording.');
    const view = session.view;
    const origin = new URL(session.environment.origins.primary).origin;
    let url: URL;
    try {
      url = new URL(path.trim() || '/', `${origin}/`);
    } catch {
      throw new Error('Write a path such as /checkout.');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) throw new Error('Open a page of this app.');
    const query = [...url.searchParams.entries()];
    const target = `${url.pathname}${url.search}`;
    if (target.length > 512) throw new Error('The path is too long.');
    // A start a replay can open: the case's own rules for a path and its query.
    if (!isCasePath(url.pathname) || !isCaseQuery(query)) throw new Error('Write a path such as /checkout.');
    if (!view.recorder.onlyStart()) throw new Error('The recording already has steps. Record again to start on another page.');
    if (session.opening) throw new Error('A page is still opening.');
    // The start moves once the page opened, timed from when its load began.
    const startedAt = view.recorder.now();
    session.opening = true;
    try {
      await view.open(target);
    } finally {
      session.opening = false;
    }
    if (this.session !== session || session.phase !== 'RECORDING' || session.view !== view) return;
    if (!view.recorder.restartAt(url.pathname, query, 'primary', startedAt)) {
      // Steps taken while the page opened belong to neither page.
      view.recorder.markIncomplete('Steps were recorded while another page opened');
      this.replay.emitUpdate(session.taskId);
      throw new Error('Steps were recorded while the page opened. Record again to start on that page.');
    }
    session.routePath = target;
    this.replay.emitUpdate(session.taskId);
  }

  /** Seals what happened up to now, takes the screenshot and lets the person point at the wrong value. */
  async mark(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'RECORDING' || !session.view) throw new Error('Mark the bug while recording.');
    const view = session.view;
    const recorder = view.recorder;
    recorder.seal();
    // Picks are placed on the screenshot by the page's scroll at this moment.
    await recorder.noteShot();
    // The recording can end or stop while the page answers.
    if (this.session !== session || session.phase !== 'RECORDING' || session.view !== view) return;
    const screenshot = await this.screenshot(view);
    if (this.session !== session || session.phase !== 'RECORDING' || session.view !== view) return;
    this.setPhase(session, 'MARKING', 'Point at what is wrong');
    session.capture = { log: recorder.log(), screenshot, pageTitle: recorder.title, draftRevision: 1 };
    this.replay.emitUpdate(session.taskId);
    // Pointing ends with a pick or Stop pointing; until then the person can still act.
    void this.awaitPick(session);
  }

  /** Outlines the elements the draft's expectations read, numbered as their rows are. */
  private showMarks(session: RecordingSession, draft: BugCaptureDraft | undefined, extra?: number): void {
    const view = session.view;
    const picks = session.capture?.log.mark?.picks ?? [];
    if (!view) return;
    const indexes = new Set((draft?.checks ?? []).map((check) => check.pickIndex));
    if (extra !== undefined) indexes.add(extra);
    const marks = [...indexes].sort((a, b) => a - b).flatMap((index) => (picks[index] ? [{ css: picks[index].target.css, label: String(index + 1) }] : []));
    void view.recorder.showMarks(marks);
  }

  /** Add check: the person points at another element on the visible page. */
  async pickCheck(sessionId: string, draft?: BugCaptureDraft): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'MARKING' || !session.view || !session.capture) throw new Error('Mark the bug first.');
    if (draft) session.capture.draft = draft;
    session.detail = 'Point at what is wrong';
    this.replay.emitUpdate(session.taskId);
    void this.awaitPick(session);
  }

  /** Stop pointing without picking. */
  async stopPick(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'MARKING' || !session.view) return;
    await session.view.recorder.cancelPick();
  }

  private async awaitPick(session: RecordingSession): Promise<void> {
    const view = session.view;
    if (!view) return;
    const token = (session.pickToken ?? 0) + 1;
    session.pickToken = token;
    const pick = await view.recorder.pick().catch(() => undefined);
    if (this.session !== session || session.pickToken !== token || session.phase !== 'MARKING' || !session.capture) return;
    session.detail = undefined;
    if (pick) {
      const log = view.recorder.log();
      session.capture = { ...session.capture, log, draftRevision: session.capture.draftRevision + 1 };
      this.showMarks(session, session.capture.draft, (log.mark?.picks.length ?? 1) - 1);
    }
    this.replay.emitUpdate(session.taskId);
  }

  /** Back to recording; the marked window is dropped and Mark seals a new one. */
  async returnToRecording(sessionId: string, draft?: BugCaptureDraft): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.phase !== 'MARKING' || !session.view) return;
    void draft;
    const recorder = session.view.recorder;
    // Recording again first: a preview that lands while the page clears finds no capture, so no
    // outline comes back to be recorded or caught in the next mark's screenshot.
    recorder.unseal();
    session.capture = undefined;
    this.setPhase(session, 'RECORDING');
    await recorder.cancelPick();
    await recorder.showMarks([]);
  }

  preview(sessionId: string, draft: BugCaptureDraft): BugCapturePreview {
    const session = this.requireSession(sessionId);
    if (!session.capture) throw new Error('Mark the bug first.');
    // The draft lives here. A change is announced, so the renderer's snapshot holds it and a panel
    // that mounts again (the Overview and back) starts from the name and notes the person wrote.
    const changed = JSON.stringify(session.capture.draft) !== JSON.stringify(draft);
    session.capture.draft = draft;
    if (session.phase === 'MARKING') this.showMarks(session, draft);
    if (changed) this.replay.emitUpdate(session.taskId);
    const compiled = compileBugCase(session.capture.log, draft);
    return {
      draftRevision: session.capture.draftRevision,
      reproducible: compiled.reproducible,
      ...(compiled.reason ? { reason: compiled.reason } : {}),
      checks: compiled.checks,
      valueRows: suggestedValueRows(session.capture.log, session.capture.pageTitle, draft)
    };
  }

  /**
   * Saves the capture: the person's approval of the expectation. With a check, version 1 is
   * approved and two clean runs are queued at once; without one, the bug is kept as evidence.
   */
  async save(sessionId: string, draftRevision: number, draft: BugCaptureDraft, withCheck: boolean): Promise<void> {
    const session = this.requireSession(sessionId);
    const capture = session.capture;
    if (!capture || (session.phase !== 'MARKING' && session.phase !== 'INTERRUPTED')) throw new Error('Mark the bug first.');
    if (draftRevision !== capture.draftRevision) throw new Error('The capture changed after it was shown. Review it again.');
    if (session.phase === 'MARKING' && session.detail) throw new Error('Pick an element or stop pointing first.');
    const title = oneLine(draft.title).slice(0, 200);
    if (!title) throw new Error('Name the bug first.');
    const compiled = compileBugCase(capture.log, draft);
    if (withCheck && !compiled.reproducible) throw new Error(compiled.reason ?? 'These checks cannot be reproduced.');
    if (!session.treeId || !session.recipe || !session.derived) throw new Error('The recording has no frozen source.');
    const resume = { phase: session.phase, detail: session.detail };
    this.setPhase(session, 'SAVING');
    const taskId = session.taskId;
    const treeId = session.treeId;
    const captureId = randomUUID();
    const caseId = randomUUID();
    const published: BugReplayFileRecord[] = [];
    let saved = false;
    try {
      // Evidence on disk never holds request bodies or typed passwords, with or without a view.
      const sensitive = sensitiveValues(capture.log);
      const persisted = redactEvidence(persistableLog(capture.log), sensitive);
      const publish = async (kind: 'ACTION_LOG' | 'NETWORK_LOG' | 'CONSOLE_LOG' | 'SCREENSHOT', mediaType: string, bytes: Buffer) => {
        const file = await this.replay.store.publishFile({ taskId, ownerKind: 'CAPTURE', ownerId: captureId, kind, mediaType, bytes });
        published.push(file);
        return file;
      };
      const actionLog = await publish('ACTION_LOG', 'application/json', boundedJson(persisted.actions, BUG_REPLAY_FILE_LIMITS.ACTION_LOG, 'head'));
      const network = await publish('NETWORK_LOG', 'application/json', boundedJson(persisted.requests, BUG_REPLAY_FILE_LIMITS.NETWORK_LOG, 'tail'));
      const consoleLog = await publish('CONSOLE_LOG', 'application/json', boundedJson(persisted.console, BUG_REPLAY_FILE_LIMITS.CONSOLE_LOG, 'tail'));
      const screenshots = capture.screenshot.length > 0 && capture.screenshot.length <= BUG_REPLAY_FILE_LIMITS.SCREENSHOT
        ? [await publish('SCREENSHOT', 'image/png', capture.screenshot)]
        : [];
      const described = describeCapture(capture.log, capture.pageTitle);
      const now = new Date().toISOString();
      const envFiles = session.included.map((file) => ({ relativePath: file.relativePath, sha256: sha256(file.bytes) }));
      const captureRecord: BugCaptureRecord = {
        id: captureId,
        taskId,
        worktreeId: session.worktreeId,
        recordingRunId: session.run.id,
        sourceTreeId: treeId,
        environment: capture.log.environment,
        engine: { chromium: session.view?.chromium ?? session.chromium ?? 'unknown' },
        coverage: { complete: capture.log.coverage.complete, reasons: capture.log.coverage.reasons },
        roles: capture.log.roles,
        recipe: session.recipe,
        templateDigest: session.derived.templateDigest,
        envFiles,
        ...(capture.pageTitle ? { pageTitle: capture.pageTitle } : {}),
        stepSummaries: described.stepSummaries,
        stepKinds: described.stepKinds,
        markedBoxes: (capture.log.mark?.picks ?? []).flatMap((pick) => (pick.box ? [{ css: pick.target.css, box: pick.box }] : [])),
        fileIds: {
          actionLog: actionLog.id,
          network: network.id,
          console: consoleLog.id,
          screenshots: screenshots.map((file) => file.id)
        },
        createdAt: now
      };
      const caseRecord: BugCaseRecord = {
        id: caseId,
        taskId,
        captureId,
        title,
        ...(draft.statement?.trim() ? { statement: draft.statement.trim().slice(0, 2000) } : {}),
        status: 'ACTIVE',
        keepBrowserStorage: false,
        createdAt: now,
        updatedAt: now,
        revision: 0
      };
      let version: BugCaseVersionRecord | undefined;
      if (withCheck && compiled.document) {
        const reader = await this.replay.treeReader(session.worktreePath, treeId);
        const jobs = jobsOf(session.recipe.text);
        const protectedPlan = await planProtectedInputs(jobs, reader).catch((error: unknown) => {
          throw new Error(error instanceof Error ? error.message : 'This setup job reads files Task Monki cannot track.');
        });
        const draftVersion: Omit<BugCaseVersionRecord, 'digest'> = {
          id: randomUUID(),
          caseId,
          taskId,
          version: 1,
          revisionKind: 'INITIAL',
          document: compiled.document,
          // What the recording showed, so a later change to an expectation is judged against it.
          ...(compiled.recorded ? { recorded: compiled.recorded } : {}),
          recipe: session.recipe,
          templateDigest: session.derived.templateDigest,
          protectedInputs: protectedPlan.pins,
          sharedSetup: protectedPlan.sharedSetup,
          envFiles,
          baselineTreeId: treeId,
          toolchain: `${this.replay.toolchain()} ${BUG_CASE_COMPILER_VERSION}`,
          createdAt: now
        };
        version = { ...draftVersion, digest: versionDigest(draftVersion) };
      }
      // The recorded code stays readable for as long as the bug exists.
      await this.replay.freezer.pin(session.worktreePath, taskId, `capture-${captureId}`, treeId);
      const runId = session.run.id;
      await this.replay.commit(taskId, 'BUG_CAPTURED', async (tx) => {
        for (const file of published) this.replay.store.recordFile(tx, file);
        await this.replay.replaceActiveCase(tx, taskId);
        this.replay.store.insertCapture(tx, captureRecord);
        this.replay.store.insertCase(tx, caseRecord);
        if (version) {
          this.replay.store.insertVersion(tx, version);
          this.replay.store.insertDecision(tx, { id: randomUUID(), caseId, taskId, kind: 'APPROVED', versionId: version.id, createdAt: now });
          // A saved check is always reproduced: its first two clean runs are part of the save.
          this.replay.insertQualification(tx, taskId, caseId, version.id);
        }
        const current = this.replay.store.getRun(tx, runId);
        if (current) {
          this.replay.store.updateRun(tx, { ...current, state: 'SETTLED', outcome: 'CAPTURED', caseId, settledAt: now }, current.revision);
        }
      }, { captureId, withCheck });
      saved = true;
    } catch (error) {
      // Nothing was saved: the person keeps the capture and can try again or discard it.
      await this.replay.store.discardPublished(published);
      await this.replay.freezer.release(session.worktreePath, taskId, `capture-${captureId}`).catch(() => undefined);
      if (this.session === session && this.phaseOf(session) === 'SAVING') this.setPhase(session, resume.phase, resume.detail);
      throw error;
    } finally {
      if (saved) {
        await this.dispose(session, undefined);
        this.replay.schedule();
      }
    }
  }

  // Internal flow

  private async prepare(session: RecordingSession): Promise<void> {
    try {
      const { treeId } = await this.replay.freezer.capture(session.worktreePath, session.taskId, `record-${session.run.id}`);
      session.treeId = treeId;
      const reader = await this.replay.treeReader(session.worktreePath, treeId);
      const name = reader.files.includes('preview.yaml') ? 'preview.yaml' : reader.files.includes('preview.yml') ? 'preview.yml' : undefined;
      if (!name) throw new ReplayEligibilityError('INELIGIBLE', 'Set up Preview for this task first. Clean copies run its recipe.');
      if (reader.files.includes('preview.yaml') && reader.files.includes('preview.yml')) {
        throw new ReplayEligibilityError('INELIGIBLE', 'Keep one preview recipe: preview.yaml or preview.yml.');
      }
      const text = await reader.readText(name);
      if (!text) throw new ReplayEligibilityError('INELIGIBLE', 'The preview recipe could not be read.');
      staticEligibility(text);
      session.recipe = { name, text, sha256: sha256(Buffer.from(text)) };
      if (reader.files.some((file) => /(?:^|\/)\.gitmodules$/.test(file))) {
        throw new ReplayEligibilityError('INELIGIBLE', 'Clean copies do not include Git submodules yet.');
      }
      const choices = await ignoredEnvFiles(session.worktreePath, text);
      if (choices.length > 0) {
        session.envChoices = choices;
        this.setPhase(session, 'CHOOSING_ENV_FILES');
        return;
      }
      this.setPhase(session, 'CHECKING', 'Checking the app');
      await this.derive(session);
    } catch (error) {
      await this.fail(session, error);
    }
  }

  private async derive(session: RecordingSession): Promise<void> {
    try {
      if (!session.treeId || !session.recipe) throw new Error('The recording has no frozen source.');
      session.exportRoot = path.join(await fs.realpath(this.replay.freezer.exportRoot), session.taskId, session.run.id, 'source');
      session.derived = await deriveReplaySpec({
        recipeText: session.recipe.text,
        exportRoot: session.exportRoot,
        liveWorktree: session.worktreePath,
        runName: session.run.name,
        ceiling: ceilingFor(session.exportRoot),
        tree: await this.replay.treeReader(session.worktreePath, session.treeId),
        envFiles: session.included.map((file) => ({ relativePath: file.relativePath, text: file.bytes.toString('utf8') }))
      });
      // An approval kept for the task's repository starts the copy without asking.
      if (!(await this.replay.approved(session.taskId, session.derived.approvalDigest))) {
        session.lease = await this.leaseRequest(session, session.derived);
        this.setPhase(session, 'NEEDS_APPROVAL');
        return;
      }
      await this.launch(session);
    } catch (error) {
      await this.fail(session, error);
    }
  }

  private async launch(session: RecordingSession): Promise<void> {
    if (session.launching) return session.launching;
    const launching = (async () => {
      try {
        const derived = session.derived!;
        session.start = startTracker(derived);
        advanceStart(session.start);
        this.setPhase(session, 'STARTING', 'Copying source');
        await this.replay.freezer.export({
          worktreePath: session.worktreePath,
          taskId: session.taskId,
          runId: session.run.id,
          treeId: session.treeId!,
          envFiles: session.included,
          signal: session.controller.signal
        });
        await this.replay.environment.preflight(derived.spec);
        const capacity = await this.replay.environment.capacity(Object.keys((derived.spec as { services?: object }).services ?? {}).length);
        if (!capacity.ok) throw new ReplayEnvironmentError('CAPACITY', capacity.reason ?? 'Waiting for preview capacity');
        session.start.copied = true;
        advanceStart(session.start);
        this.setPhase(session, 'STARTING', derived.addedInstallJobs.length ? 'Installing dependencies' : 'Starting the app');
        session.environment = await this.replay.environment.start({
          taskId: session.taskId,
          name: session.run.name,
          spec: derived.spec,
          approvalDigest: derived.approvalDigest,
          secretIds: derived.secretIds,
          signal: session.controller.signal,
          onPhase: (phase) => {
            if (session.phase === 'STARTING' && session.detail !== phase) {
              session.detail = phase;
              this.replay.emitUpdate(session.taskId);
            }
          },
          onServices: (services) => {
            const start = session.start;
            // A report read before the services were ready can land after: the start has moved on.
            if (!start || start.opening || session.phase !== 'STARTING') return;
            let changed = false;
            for (const service of services) {
              if (start.states.get(service.id) === service.state) continue;
              start.states.set(service.id, service.state);
              changed = true;
            }
            if (changed && advanceStart(start)) this.replay.emitUpdate(session.taskId);
          }
        });
        // Ready: every service that did not fail is up, and the page opens next.
        for (const service of session.start.services) {
          if (startFailed(session.start.states.get(service.id))) continue;
          session.start.states.set(service.id, 'ready');
        }
        session.start.opening = true;
        advanceStart(session.start);
        this.setPhase(session, 'STARTING', 'Opening the app');
        await this.replay.environment.warmUp(session.environment.origins, [{ role: 'primary', method: 'GET', path: '/' }], session.controller.signal);
        const host = this.host();
        if (!host) throw new Error('Recording needs the desktop app on macOS.');
        const environment: BugCaseEnvironment = { ...DEFAULT_BUG_CASE_ENVIRONMENT, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en-US' };
        session.view = await host.open({
          sessionId: session.id,
          taskId: session.taskId,
          origins: session.environment.origins,
          startUrl: `${session.environment.origins.primary}/`,
          environment,
          notify: (notice) => this.onNotice(session, notice),
          signal: session.controller.signal
        });
        if (session.controller.signal.aborted) throw new ReplayEnvironmentError('CANCELED', 'Canceled');
        // The recorder attached before the start page loaded: the start step is timed from then.
        session.view.recorder.noteStart('/', [], 'primary', 0);
        session.recordingStartedAt = new Date().toISOString();
        session.lastInputAt = session.recordingStartedAt;
        session.routePath = '/';
        this.setPhase(session, 'RECORDING');
        this.armTimers(session);
      } catch (error) {
        if (session.controller.signal.aborted) {
          // Discarded while it started: the clean copy or the view can have come up after the
          // discard's own teardown looked for them.
          await this.stopEnvironment(session);
          return;
        }
        await this.fail(session, error);
      } finally {
        session.launching = undefined;
      }
    })();
    session.launching = launching;
    return launching;
  }

  private onNotice(session: RecordingSession, notice: RecorderNotice | { kind: 'interrupted'; reason: string }): void {
    if (this.session !== session) return;
    switch (notice.kind) {
      case 'activity':
        session.lastInputAt = new Date().toISOString();
        this.armIdle(session);
        return;
      case 'route':
        session.routePath = notice.path;
        break;
      case 'coverage':
        session.coverageNote = notice.note;
        break;
      case 'password':
        session.passwordTyped = true;
        break;
      case 'ready':
        return;
      case 'timeline':
        // Steps arrive as fast as the person acts; the view follows at a steady pace.
        if (session.phase === 'RECORDING' && !session.timelineTimer) {
          session.timelineTimer = setTimeout(() => {
            session.timelineTimer = undefined;
            if (this.session === session) this.replay.emitUpdate(session.taskId);
          }, 250);
          session.timelineTimer.unref?.();
        }
        return;
      case 'interrupted':
        void this.interrupt(session, notice.reason);
        return;
    }
    this.replay.emitUpdate(session.taskId);
  }

  private armTimers(session: RecordingSession): void {
    this.armIdle(session);
    session.lengthTimer = setTimeout(() => void this.interrupt(session, 'The recording reached its 60 minute limit'), LENGTH_LIMIT_MS);
    session.lengthTimer.unref?.();
    session.watchTimer = setInterval(() => void this.watchEnvironment(session), 5_000);
    session.watchTimer.unref?.();
  }

  private armIdle(session: RecordingSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (this.session !== session || session.phase !== 'RECORDING') return;
      void this.fail(session, new RecordingEnded('Recording ended after 20 minutes without input'));
    }, IDLE_LIMIT_MS);
    session.idleTimer.unref?.();
  }

  private async watchEnvironment(session: RecordingSession): Promise<void> {
    if (this.session !== session || session.phase !== 'RECORDING' || !session.environment) return;
    const bracket = await this.replay.environment.bracket(session.run.name, session.environment.attemptId);
    if (!bracket.ok) await this.interrupt(session, serviceStoppedSentence(bracket.service));
  }

  /**
   * The environment stopped or a limit was reached: what was recorded can only be saved as
   * evidence. `reason` is a sentence of its own: "The app service stopped".
   */
  private async interrupt(session: RecordingSession, reason: string): Promise<void> {
    if (this.session !== session || session.phase !== 'RECORDING' || !session.view) return;
    const recorder = session.view.recorder;
    const incomplete = `Recording stopped early: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    recorder.markIncomplete(incomplete);
    recorder.seal();
    const screenshot = await this.screenshot(session.view).catch(() => Buffer.alloc(0));
    session.capture = { log: recorder.log(), screenshot, pageTitle: recorder.title, draftRevision: 1 };
    session.partial = incomplete;
    session.failure = { title: reason, detail: 'The steps up to that point are kept.', action: 'record-again' };
    this.setPhase(session, 'INTERRUPTED');
    // Nothing more can be recorded: the page and its clean copy stop now; the steps stay.
    await this.stopEnvironment(session);
  }

  private async fail(session: RecordingSession, error: unknown): Promise<void> {
    if (this.session !== session) return;
    if (session.controller.signal.aborted && !(error instanceof RecordingEnded)) return;
    const failure = failureFor(error);
    session.failure = failure;
    await this.teardown(session);
    await this.replay.settleRun(session.run, error instanceof ReplayEnvironmentError && error.code === 'START_FAILED' ? 'ENVIRONMENT_FAILED' : 'DISCARDED', {
      reason: error instanceof ReplayEnvironmentError && error.code === 'PREREQUISITE' ? 'IMAGE_MISSING' : 'INELIGIBLE',
      detail: failure.detail
    }).catch(() => undefined);
    this.setPhase(session, 'FAILED');
  }

  private async dispose(session: RecordingSession, outcome: 'DISCARDED' | undefined): Promise<void> {
    session.controller.abort();
    await this.teardown(session);
    if (outcome) await this.replay.settleRun(session.run, outcome, { reason: 'CANCELED_BY_PERSON', detail: 'Recording discarded.' }).catch(() => undefined);
    if (this.session === session) this.session = undefined;
    this.replay.emitUpdate(session.taskId);
  }

  /** Stops what the recording runs: its timers, the view, the clean copy and its exported source. */
  private async stopEnvironment(session: RecordingSession): Promise<void> {
    for (const timer of [session.idleTimer, session.lengthTimer, session.timelineTimer]) if (timer) clearTimeout(timer);
    session.timelineTimer = undefined;
    if (session.watchTimer) clearInterval(session.watchTimer);
    const view = session.view;
    session.view = undefined;
    if (view) {
      session.chromium = view.chromium;
      view.recorder.dispose();
      await view.close().catch(() => undefined);
    }
    const teardown = await this.replay.environment.teardown(session.run.name).catch(() => ({ complete: false as const, reason: 'Cleanup failed' }));
    if (!teardown.complete) {
      await this.replay.store.write((tx) => {
        const current = this.replay.store.getRun(tx, session.run.id);
        if (current) this.replay.store.updateRun(tx, { ...current, cleanupDebt: teardown.reason }, current.revision);
      }).catch(() => undefined);
    }
    await this.replay.freezer.cleanup(session.taskId, session.run.id).catch(() => undefined);
  }

  /** Everything the recording holds, including the ref that keeps its frozen code. */
  private async teardown(session: RecordingSession): Promise<void> {
    await this.stopEnvironment(session);
    await this.replay.freezer.release(session.worktreePath, session.taskId, `record-${session.run.id}`).catch(() => undefined);
  }

  private async screenshot(view: RecordingViewHandle): Promise<Buffer> {
    const shown = await view.screenshot?.().catch(() => undefined);
    return shown && shown.length > 0 ? shown : view.recorder.screenshot();
  }

  /** The phase as it is now; a narrowed `session.phase` would be the phase before an await. */
  private phaseOf(session: RecordingSession): BugRecordingPhase {
    return session.phase;
  }

  private setPhase(session: RecordingSession, phase: BugRecordingPhase, detail?: string): void {
    session.phase = phase;
    session.detail = detail;
    this.replay.emitUpdate(session.taskId);
  }

  private requireSession(sessionId: string): RecordingSession {
    if (!this.session || this.session.id !== sessionId) throw new Error('This recording has ended.');
    return this.session;
  }

  private track(session: RecordingSession, work: Promise<void>): void {
    void this.replay.track(work.catch((error: unknown) => this.fail(session, error)));
  }

  private captureView(session: RecordingSession): BugCaptureView {
    const capture = session.capture!;
    const described = describeCapture(capture.log, capture.pageTitle);
    const view: BugCaptureView = {
      draftRevision: capture.draftRevision,
      picks: described.picks,
      requests: described.requests,
      valueRows: described.valueRows,
      otherRequests: described.otherRequests,
      pageErrors: described.pageErrors,
      uncaughtError: described.uncaughtError,
      stepCount: described.stepSummaries.length,
      steps: described.stepSummaries.map((text, index) => ({ kind: described.stepKinds[index] ?? 'step', text })),
      suggestedTitle: described.suggestedTitle,
      ...(capture.draft ? { draft: capture.draft } : {}),
      ...(described.partial || session.partial ? { partial: described.partial ?? session.partial } : {})
    };
    if (capture.draft) {
      const compiled = compileBugCase(capture.log, capture.draft);
      if (!compiled.reproducible && compiled.reason) view.reproduceBlockedReason = compiled.reason;
    }
    return view;
  }

  private async leaseRequest(session: RecordingSession, derived: DerivedReplaySpec): Promise<BugReplayLeaseRequest> {
    const running = await this.runningPreviewRecipe(session.taskId).catch(() => undefined);
    const same = Boolean(running && session.recipe && running === session.recipe.text && derived.addedInstallJobs.length === 0);
    return leaseRequestFor(derived, session.included.map((file) => file.relativePath), same);
  }

}

class RecordingEnded extends Error {}

/** The clean copy's start as steps: copying the files, each job and service in the recipe's order, opening the app. */
function startTracker(derived: DerivedReplaySpec): StartTracker {
  const spec = derived.spec as { type?: string; services?: Record<string, { type?: string }> };
  const entries = spec.type === 'environment' && spec.services ? Object.entries(spec.services) : [];
  const installs = entries.filter(([id, service]) => service.type === 'job' && (derived.addedInstallJobs.includes(id) || /install/i.test(id)));
  const directoryOf = (id: string) => derived.serviceDirectories.find((entry) => entry.service === id)?.directory;
  // In the order they run: installs, then databases, then the other jobs, then the app's processes.
  const rank = ([id, service]: [string, { type?: string }]) =>
    installs.some(([installId]) => installId === id) ? 0 : service.type === 'postgres' || service.type === 'redis' ? 1 : service.type === 'job' ? 2 : 3;
  const ordered = [...entries].sort((left, right) => rank(left) - rank(right));
  const services = ordered.map(([id, service]) => {
    if (service.type !== 'job') return { id, label: `Start ${id}` };
    if (!installs.some(([installId]) => installId === id)) return { id, label: `Run ${id}` };
    const directory = directoryOf(id);
    return { id, label: installs.length > 1 && directory && directory !== '.' ? `Install dependencies in ${directory}` : 'Install dependencies' };
  });
  return {
    services: services.length ? services : [{ id: 'app', label: 'Start the app' }],
    states: new Map(),
    copied: false,
    opening: false,
    times: new Map(),
    steps: []
  };
}

function startFailed(state: string | undefined): boolean {
  return state === 'failed' || state === 'canceled';
}

/** Recomputes the steps and stamps when each became active and ended. True when a step changed. */
function advanceStart(start: StartTracker): boolean {
  const serviceState = (id: string): BugStartStep['state'] => {
    const state = start.states.get(id);
    if (state === 'starting') return 'active';
    if (state === 'ready' || state === 'succeeded' || state === 'skipped') return 'done';
    if (startFailed(state)) return 'failed';
    return 'pending';
  };
  const raw: Array<{ id: string; label: string; state: BugStartStep['state'] }> = [
    { id: 'copy', label: "Copy this task's files", state: start.copied ? 'done' : 'active' },
    ...start.services.map((service) => ({ id: `service:${service.id}`, label: service.label, state: start.copied ? serviceState(service.id) : 'pending' as const })),
    { id: 'open', label: 'Open the app', state: start.opening ? 'active' : 'pending' }
  ];
  const now = new Date().toISOString();
  const steps = raw.map((step) => {
    const times = start.times.get(step.id) ?? {};
    if ((step.state === 'active' || step.state === 'done' || step.state === 'failed') && !times.startedAt) times.startedAt = now;
    if ((step.state === 'done' || step.state === 'failed') && !times.endedAt) times.endedAt = now;
    start.times.set(step.id, times);
    return { ...step, ...(times.startedAt ? { startedAt: times.startedAt } : {}), ...(times.endedAt ? { endedAt: times.endedAt } : {}) };
  });
  const changed = JSON.stringify(steps.map((step) => [step.id, step.state])) !== JSON.stringify(start.steps.map((step) => [step.id, step.state]));
  start.steps = steps;
  return changed;
}

function failureFor(error: unknown): NonNullable<BugRecordingSessionView['failure']> {
  if (error instanceof RecordingEnded) return { title: 'Recording ended', detail: error.message, action: 'record-again' };
  if (error instanceof ReplayEligibilityError) return { title: "Recording couldn't start", detail: error.message, action: error.action };
  if (error instanceof ReplaySourceError) return { title: "Recording couldn't start", detail: error.message, action: 'retry' };
  if (error instanceof ReplayEnvironmentError) {
    if (error.code === 'PREREQUISITE') {
      const image = /image\s+([\w./:-]+)/i.exec(error.message)?.[1];
      return { title: "Recording couldn't start", detail: error.message, action: 'retry', ...(image ? { command: `docker pull ${image}` } : {}) };
    }
    if (error.code === 'CAPACITY') return { title: "Recording couldn't start", detail: 'Preview is at capacity. Stop another preview and retry.', action: 'retry' };
    if (error.code === 'NOT_CLEAN') return { title: "Recording couldn't start", detail: error.message, action: 'record-again' };
    return { title: "Recording couldn't start", detail: error.message, action: 'ask-preview-agent' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { title: "Recording couldn't start", detail: message.split('\n')[0].slice(0, 300), action: 'retry' };
}

/** Ignored `.env*` files in the directories the recipe runs code in; the person chooses which a clean copy gets. */
async function ignoredEnvFiles(worktreePath: string, recipeText: string): Promise<BugRecordingEnvFileChoice[]> {
  const directories = new Set<string>(['.']);
  try {
    const spec = parseConfigurationFile(recipeText);
    const services = spec.type === 'environment' ? Object.values(spec.services) : [spec];
    for (const service of services as Array<Record<string, unknown>>) {
      for (const key of ['cwd', 'directory']) {
        const value = service[key];
        if (typeof value !== 'string') continue;
        const relative = path.relative(worktreePath, path.resolve(worktreePath, value)).split(path.sep).join('/');
        if (!relative.startsWith('..')) directories.add(relative || '.');
      }
    }
  } catch {
    // The recipe was validated before this point.
  }
  const candidates: string[] = [];
  for (const directory of directories) {
    const absolute = path.join(worktreePath, directory);
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
      candidates.push(directory === '.' ? entry.name : `${directory}/${entry.name}`);
    }
  }
  if (candidates.length === 0) return [];
  const ignored = await git(worktreePath, ['check-ignore', '--no-index', ...candidates], 15_000).catch((error: { stdout?: string }) => error.stdout ?? '');
  const ignoredSet = new Set(String(ignored).split('\n').map((line) => line.trim()).filter(Boolean));
  return candidates
    .filter((file) => ignoredSet.has(file))
    .slice(0, 12)
    .map((name) => ({ name, directory: path.posix.dirname(name), include: true }));
}

/**
 * The capture's value rows, each with the value the person's expectation implies in the
 * observed representation: a picked "$40.00" expected as "$45.00" suggests 45 for a JSON 40.
 */
function suggestedValueRows(log: BugRecordingLogV1, pageTitle: string, draft: BugCaptureDraft): BugCaptureValueRow[] {
  return describeCapture(log, pageTitle).valueRows.map((row) => {
    let observed: number;
    try {
      observed = Number(JSON.parse(row.observed));
    } catch {
      return row;
    }
    for (const check of draft.checks) {
      if (!check.expected || (check.template !== 'equals' && check.template !== 'contains')) continue;
      const pick = log.mark?.picks[check.pickIndex];
      const matched = pick ? numbersIn(pick.text).find((number) => number === observed || Math.round(number * 100) === observed) : undefined;
      if (matched === undefined) continue;
      const suggested = suggestValue(row.observed, matched, check.expected);
      if (suggested && suggested !== row.observed) return { ...row, suggested };
    }
    return row;
  });
}

function jobsOf(recipeText: string): RecipeJob[] {
  const spec = parseConfigurationFile(recipeText);
  const services = spec.type === 'environment' ? Object.entries(spec.services) : [['app', spec] as const];
  return services.map(([id, service]) => {
    const record = service as Record<string, unknown>;
    const directory = typeof record.cwd === 'string' ? record.cwd : typeof record.directory === 'string' ? record.directory : '.';
    const normalized = path.posix.normalize(directory.replace(/\\/g, '/'));
    return {
      id,
      type: String(record.type),
      directory: normalized,
      ...(Array.isArray(record.command) ? { command: record.command as string[] } : {})
    };
  });
}

/** JSON of a list within `max` bytes, keeping its first (`head`) or last (`tail`) items. */
function boundedJson(value: unknown[], max: number, keep: 'head' | 'tail'): Buffer {
  let items = value;
  let bytes = Buffer.from(JSON.stringify(items));
  while (bytes.length > max && items.length > 0) {
    const count = Math.floor(items.length / 2);
    items = keep === 'head' ? items.slice(0, count) : items.slice(items.length - count);
    bytes = Buffer.from(JSON.stringify(items));
  }
  return bytes;
}

/** Values typed into password fields during the recording. */
function sensitiveValues(log: BugRecordingLogV1): string[] {
  return log.actions.flatMap((action) => (action.kind === 'fill' && action.sensitive && action.value ? [action.value] : []));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
