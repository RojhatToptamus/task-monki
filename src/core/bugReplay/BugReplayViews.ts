import type {
  BugCaseAction,
  BugCaseCheckView,
  BugCaseView,
  BugCheckResult,
  BugRecordingSessionView,
  BugReplayAssertionObservation,
  BugReplayGateProjection,
  BugReplayLeaseRequest,
  BugReplayRunView,
  BugReplaySnapshot,
  BugShotView
} from '../../shared/bugReplay';
import { BUG_REPLAY_STORAGE_LIMIT_BYTES } from '../../shared/bugReplay';
import { isDomAssertion, type BugCaseV1 } from '../../shared/bugCase';
import { BUG_BOUNDARY_LINE, bugCountsLine, bugScopeLine } from '../../shared/bugReplayClaims';
import { checkViews } from './BugCaseCompiler';
import { capturedValue } from './BugReplayVerdict';
import { effectiveVersion, latestSets, verdictAttempt } from './BugReplayGate';
import type { BugReplayCore } from './BugReplayPorts';
import type { BugCaptureRecord, BugCaseRecord, BugCaseVersionRecord, StoredBugReplayRun } from './BugReplayRecords';
import { staticEligibility, ReplayEligibilityError } from './ReplayDerivation';
import { readPreviewRecipeFiles } from '../preview/generation/PreviewRecipeFile';

/** Builds what the renderer reads about a task's bug: words, lines and actions already decided. */
export async function buildBugReplaySnapshot(
  service: BugReplayCore,
  taskId: string,
  recording: BugRecordingSessionView | undefined,
  recordingElsewhere = false
): Promise<BugReplaySnapshot> {
  const store = service.store;
  const data = await store.read((reader) => {
    const active = store.activeCase(reader, taskId);
    const cases = store.listCases(reader, taskId);
    const versions = active ? store.listVersions(reader, active.id) : [];
    const decisions = active ? store.listDecisions(reader, active.id) : [];
    const runs = active ? store.listRuns(reader, { caseId: active.id }) : [];
    const capture = active ? store.getCapture(reader, active.captureId) : undefined;
    const captureFiles = active ? store.filesFor(reader, 'CAPTURE', active.captureId) : [];
    const runFiles = new Map(runs.map((run) => [run.id, store.filesFor(reader, 'RUN', run.id)]));
    const gate = active ? service.gateIn(reader, taskId) : undefined;
    const earlier = cases
      .filter((bugCase) => bugCase.status !== 'ACTIVE')
      .slice(0, 20)
      .map((bugCase) => ({
        id: bugCase.id,
        title: bugCase.title,
        status: bugCase.status,
        createdAt: bugCase.createdAt,
        endedAt: bugCase.updatedAt,
        evidenceBytes: store.bytesForCase(reader, bugCase.id, bugCase.captureId)
      }));
    return { active, versions, decisions, runs, capture, captureFiles, runFiles, gate, earlier, used: store.usedBytes(reader) };
  });
  const availability = await recordAvailability(service, taskId, recording, recordingElsewhere);
  const snapshot: BugReplaySnapshot = {
    taskId,
    availability,
    runs: data.runs.slice(0, 20).map((run) => runView(run, data.runFiles.get(run.id) ?? [])),
    runCount: data.runs.filter((run) => run.kind !== 'RECORD').length,
    earlierCases: data.earlier,
    storage: { usedBytes: data.used, limitBytes: BUG_REPLAY_STORAGE_LIMIT_BYTES }
  };
  if (recording) snapshot.recording = recording;
  if (data.active && data.gate && data.capture) {
    const view = await caseView(service, data.active, data.capture, data.versions, data.decisions, data.runs, data.gate, data.captureFiles, data.runFiles);
    // A closed task keeps its bug as a record: nothing more runs or goes to the agent.
    if (await taskClosed(service, taskId)) view.actions = [];
    else await explainUnavailable(service, view, data.active, availability.recordDisabledReason);
    snapshot.activeCase = view;
  }
  return snapshot;
}

async function taskClosed(service: BugReplayCore, taskId: string): Promise<boolean> {
  try {
    const { task } = await service.access.context(taskId);
    return ['DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase);
  } catch {
    return true;
  }
}

/**
 * Offered actions that cannot run right now say why beside them, instead of failing when they
 * are clicked. Before the first agent turn, starting the task's implementation sends the bug.
 */
async function explainUnavailable(service: BugReplayCore, view: BugCaseView, bugCase: BugCaseRecord, recordReason: string | undefined): Promise<void> {
  const agent = await service.access.agentState(bugCase.taskId).catch(() => ({ hasRun: true, turn: 'IDLE' as const }));
  const unavailable: NonNullable<BugCaseView['unavailable']> = {};
  if (!agent.hasRun) {
    view.startSendsBug = true;
    view.actions = view.actions.filter((action) => action !== 'send-to-agent');
  }
  if (agent.turn === 'WAITING') unavailable['send-to-agent'] = 'Answer the agent first';
  else if (agent.turn === 'MOVING') unavailable['send-to-agent'] = 'Wait for the agent to start or stop';
  if (agent.turn !== 'IDLE') unavailable['verify-again'] = "Wait for the agent's turn to finish";
  else if (view.version && bugCase.observedTreeId === view.version.baselineTreeId) unavailable['verify-again'] = 'No changes since the recording';
  if (recordReason) unavailable['record-again'] = recordReason;
  for (const action of Object.keys(unavailable) as BugCaseAction[]) if (!view.actions.includes(action)) delete unavailable[action];
  if (Object.keys(unavailable).length) view.unavailable = unavailable;
}

async function recordAvailability(
  service: BugReplayCore,
  taskId: string,
  recording: BugRecordingSessionView | undefined,
  recordingElsewhere: boolean
): Promise<BugReplaySnapshot['availability']> {
  const available = service.available();
  if (!available.record) return { canRecord: false, hiddenReason: available.reason ?? 'Recording needs the desktop app on macOS.' };
  let context;
  try {
    context = await service.access.context(taskId);
  } catch {
    return { canRecord: false, hiddenReason: 'The task has no worktree.' };
  }
  if (context.task.kind !== 'NORMAL') return { canRecord: false, hiddenReason: 'Design tasks keep their own canvas.' };
  if (['DONE', 'CANCELED', 'ARCHIVED'].includes(context.task.workflowPhase)) return { canRecord: false, hiddenReason: 'The task is closed.' };
  const files = await readPreviewRecipeFiles(context.worktree.worktreePath).catch(() => []);
  if (files.length === 0) return { canRecord: false, hiddenReason: 'Set up Preview first.' };
  if (recording && !['FAILED', 'INTERRUPTED'].includes(recording.phase)) return { canRecord: false, recordDisabledReason: 'Recording' };
  if (recordingElsewhere) return { canRecord: true, recordDisabledReason: 'Another task is recording' };
  try {
    staticEligibility(files[0].text);
  } catch (error) {
    return { canRecord: true, recordDisabledReason: error instanceof ReplayEligibilityError ? error.message : 'The preview recipe is not valid.' };
  }
  if (await service.access.agentRunActive(taskId)) return { canRecord: true, recordDisabledReason: "The agent is changing this task's files" };
  const used = await service.store.read((reader) => service.store.usedBytes(reader));
  if (used >= BUG_REPLAY_STORAGE_LIMIT_BYTES) return { canRecord: true, recordDisabledReason: 'Bug evidence storage is full. Delete evidence of earlier bugs.' };
  return { canRecord: true };
}

async function caseView(
  service: BugReplayCore,
  bugCase: BugCaseRecord,
  capture: BugCaptureRecord,
  versions: BugCaseVersionRecord[],
  decisions: Parameters<typeof effectiveVersion>[1],
  runs: StoredBugReplayRun[],
  gate: BugReplayGateProjection,
  captureFiles: Array<{ id: string; kind: string }>,
  runFiles: Map<string, Array<{ id: string; kind: string }>>
): Promise<BugCaseView> {
  const version = effectiveVersion(versions, decisions);
  const view: BugCaseView = {
    id: bugCase.id,
    captureId: bugCase.captureId,
    title: bugCase.title,
    ...(bugCase.statement ? { statement: bugCase.statement } : {}),
    status: bugCase.status,
    keepBrowserStorage: bugCase.keepBrowserStorage,
    gate,
    steps: capture.stepSummaries.map((text, index) => ({
      kind: capture.stepKinds?.[index] ?? (version?.document.steps.length === capture.stepSummaries.length ? version.document.steps[index].kind : 'step'),
      text
    })),
    screenshotFileIds: captureFiles.filter((file) => file.kind === 'SCREENSHOT').map((file) => file.id),
    shots: {},
    actions: [],
    createdAt: bugCase.createdAt,
    ...(capture.coverage.complete ? {} : { partial: capture.coverage.reasons[0] ?? 'The recording is incomplete' })
  };
  if (version) {
    const alsoAfterReload = version.document.assertions.some((assertion) => isDomAssertion(assertion) && assertion.alsoAfterReload);
    view.version = {
      id: version.id,
      version: version.version,
      revisionKind: version.revisionKind,
      checks: checkViews(version.document),
      envFiles: version.envFiles.map((file) => file.relativePath),
      protectedPaths: version.protectedInputs.flatMap((pin) => (pin.kind === 'file' ? [pin.path] : pin.kind === 'jsonMember' ? [`${pin.path} (${pin.pointer.slice(1).replace(/\//g, '.')})`] : [])).slice(0, 40),
      baselineTreeId: version.baselineTreeId,
      alsoAfterReload
    };
    view.scopeLine = bugScopeLine(alsoAfterReload, bugCase.keepBrowserStorage);
    view.boundaryLine = BUG_BOUNDARY_LINE;
    const counts = bugCountsLine(gate);
    if (counts) view.countsLine = counts;
    const sets = latestSets(runs, version.id);
    const signature = new Set(version.document.failureSignature.map((entry) => entry.assertionId));
    const reproduced = (sets.qualification ?? []).find((run) => run.outcome === 'REPRODUCED') ?? (sets.qualification ?? []).find((run) => run.counted);
    if (reproduced) {
      view.before = reproduced.observations
        .filter((observation) => signature.has(observation.assertionId) && observation.observed)
        .slice(0, 3)
        .map((observation) => `Before: ${observation.observed}`);
    }
    const attempt = verdictAttempt(runs, version.id, gate)?.candidates ?? [];
    const decisive = [...attempt].reverse().find((run) => run.outcome === 'FAILED') ?? [...attempt].reverse().find((run) => run.outcome === 'PASSED');
    if (decisive) {
      if (decisive.outcome === 'FAILED' && decisive.failure) {
        view.after = [decisive.failure.detail.replace(/^After: /, 'After: ')];
      } else {
        view.after = decisive.observations
          .filter((observation) => signature.has(observation.assertionId) && observation.observed)
          .slice(0, 3)
          .map((observation) => `After: ${observation.observed}${observation.afterReload?.passed ? ', also after reload' : ''}`);
      }
      for (const file of runFiles.get(decisive.id) ?? []) if (file.kind === 'SCREENSHOT') view.screenshotFileIds.push(file.id);
    }
    // What each expectation showed before the fix (the run that reproduced it, or the recording
    // before any run counted) and after it (the verdict's decisive run).
    view.version.checks = view.version.checks.map((check) => withResults(check, version.document, reproduced, decisive));
    const recordedShot = captureFiles.find((file) => file.kind === 'SCREENSHOT');
    const beforeShot = reproduced ? runShot(reproduced, runFiles.get(reproduced.id)) : undefined;
    if (beforeShot) view.shots.before = beforeShot;
    else if (recordedShot) view.shots.before = { fileId: recordedShot.id, at: capture.createdAt, boxes: recordedBoxes(version.document, capture.markedBoxes ?? []) };
    const afterShot = decisive ? runShot(decisive, runFiles.get(decisive.id)) : undefined;
    if (afterShot) view.shots.after = afterShot;
    const protectedRun = attempt.find((run) => run.outcome === 'PROTECTED_INPUT_CHANGED');
    if (protectedRun?.failure) {
      const match = /\(([^)]*)\)$/.exec(protectedRun.failure.detail);
      if (match) view.changedProtectedPaths = match[1].split(', ').slice(0, 10);
    }
    if (version.sharedSetup.length > 0 && attempt.length > 0) view.changedSharedSetup = await changedSharedSetup(service, bugCase.taskId, version, attempt[0].inputTreeId);
    const envRun = runs.find((run) => run.outcome === 'ENV_FILES_CHANGED' && run.versionId === version.id);
    if (envRun?.failure) view.envFilesChanged = version.envFiles.map((file) => file.relativePath).filter((file) => envRun.failure!.detail.includes(file));
  }
  view.screenshotFileIds = [...new Set(view.screenshotFileIds)].slice(0, 6);
  if (!view.shots.before) {
    const recordedShot = captureFiles.find((file) => file.kind === 'SCREENSHOT');
    if (recordedShot) view.shots.before = { fileId: recordedShot.id, at: capture.createdAt, boxes: [] };
  }
  view.actions = actionsFor(view, gate, runs);
  return view;
}

async function changedSharedSetup(service: BugReplayCore, taskId: string, version: BugCaseVersionRecord, treeId: string | undefined): Promise<string[]> {
  if (!treeId) return [];
  try {
    const context = await service.access.context(taskId);
    const before = await service.treeReader(context.worktree.worktreePath, version.baselineTreeId);
    const after = await service.treeReader(context.worktree.worktreePath, treeId);
    const changed: string[] = [];
    for (const file of version.sharedSetup.slice(0, 50)) {
      if ((await before.readText(file)) !== (await after.readText(file))) changed.push(file);
    }
    return changed.slice(0, 10);
  } catch {
    return [];
  }
}

function resultOf(observation: BugReplayAssertionObservation): BugCheckResult {
  return {
    held: observation.passed,
    ...(observation.value !== undefined ? { value: observation.value } : {}),
    ...(observation.afterReload
      ? { afterReload: { held: observation.afterReload.passed, ...(observation.afterReload.value !== undefined ? { value: observation.afterReload.value } : {}) } }
      : {})
  };
}

function withResults(
  check: BugCaseCheckView,
  document: BugCaseV1,
  reproduced: StoredBugReplayRun | undefined,
  decisive: StoredBugReplayRun | undefined
): BugCaseCheckView {
  const next: BugCaseCheckView = { ...check };
  const before = reproduced?.observations.find((observation) => observation.assertionId === check.id);
  if (before) next.before = resultOf(before);
  else {
    // The recording: a check in the signature did not hold, and shows what it showed; any other held.
    const entry = document.failureSignature.find((candidate) => candidate.assertionId === check.id);
    next.before = entry ? { held: false, ...(entry.captured ? { value: capturedValue(entry.captured) } : {}) } : { held: true };
  }
  const after = decisive?.observations.find((observation) => observation.assertionId === check.id);
  if (after) next.after = resultOf(after);
  return next;
}

/** A run's screenshot with where each checked element sat in it. */
function runShot(run: StoredBugReplayRun, files: Array<{ id: string; kind: string }> | undefined): BugShotView | undefined {
  const shot = [...(files ?? [])].reverse().find((file) => file.kind === 'SCREENSHOT');
  if (!shot) return undefined;
  return {
    fileId: shot.id,
    runId: run.id,
    at: run.settledAt ?? run.startedAt ?? run.queuedAt,
    boxes: run.observations.flatMap((observation) => (observation.box ? [{ checkId: observation.assertionId, box: observation.box }] : []))
  };
}

/** The recording's outlines, matched to the checks that read each picked element. */
function recordedBoxes(document: BugCaseV1, marked: Array<{ css: string; box: BugShotView['boxes'][number]['box'] }>): BugShotView['boxes'] {
  const boxes: BugShotView['boxes'] = [];
  for (const assertion of document.assertions) {
    if (!isDomAssertion(assertion)) continue;
    const css = assertion.target.candidates.flatMap((candidate) => (candidate.kind === 'css' ? [candidate.value] : []));
    const match = marked.find((entry) => css.includes(entry.css));
    if (match) boxes.push({ checkId: assertion.id, box: { ...match.box } });
  }
  return boxes;
}

/** The actions the Bug section offers in this state, the primary first. */
function actionsFor(view: BugCaseView, gate: BugReplayGateProjection, runs: StoredBugReplayRun[]): BugCaseAction[] {
  const actions: BugCaseAction[] = [];
  const fixing = gate.handoff && (gate.handoff.status === 'QUEUED' || gate.handoff.status === 'RUNNING');
  const sendable = !fixing;
  const waiting = gate.activeRun?.waitingFor;
  if (waiting === 'APPROVAL') actions.push('allow-runs', 'always-allow-runs');
  if (waiting === 'KEYSTORE') actions.push('unlock-secrets');
  const firstReproduced = runs.some((run) => run.versionId === gate.versionId && run.kind === 'BASELINE' && run.outcome === 'REPRODUCED');
  switch (gate.state) {
    case 'CAPTURED':
      if (sendable) actions.push('send-to-agent');
      break;
    case 'REPRODUCING':
      if (sendable && firstReproduced) actions.push('send-to-agent');
      if (gate.activeRun) actions.push('cancel-run');
      break;
    case 'REPRODUCED':
      if (sendable) actions.push('send-to-agent');
      actions.push('verify-again', 'run-again');
      break;
    case 'NOT_REPRODUCED':
      actions.push('record-again', 'run-again', 'save-without-check');
      break;
    case 'FLAKY':
      actions.push('record-again');
      if (sendable) actions.push('send-to-agent');
      actions.push('run-again', 'save-without-check');
      break;
    case 'REPRODUCTION_BLOCKED':
      if (view.envFilesChanged?.length) actions.push('use-new-env-files');
      actions.push('run-again', 'record-again');
      break;
    case 'VERIFYING':
      if (gate.activeRun) actions.push('cancel-run');
      break;
    case 'FIX_VERIFIED':
      actions.push('verify-again');
      break;
    case 'STILL_FAILING':
      if (sendable) actions.push('send-to-agent');
      actions.push('verify-again');
      break;
    case 'COULDNT_VERIFY':
      if (view.envFilesChanged?.length) actions.push('use-new-env-files');
      actions.push('verify-again');
      if (sendable) actions.push('send-to-agent');
      break;
    case 'STALE':
      actions.push('verify-again');
      if (sendable) actions.push('send-to-agent');
      break;
  }
  if (view.version?.alsoAfterReload) actions.push('keep-browser-storage');
  actions.push('remove');
  return [...new Set(actions)];
}

function runView(run: StoredBugReplayRun, files: Array<{ id: string; kind: string }>): BugReplayRunView {
  return {
    id: run.id,
    kind: run.kind,
    ...(run.control ? { control: true } : {}),
    state: run.state,
    ...(run.phase ? { phase: run.phase } : {}),
    ...(run.waitingFor ? { waitingFor: run.waitingFor } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}),
    counted: run.counted,
    ...(run.failure ? { failure: run.failure } : {}),
    observations: run.observations,
    facts: run.facts,
    screenshotFileIds: files.filter((file) => file.kind === 'SCREENSHOT').map((file) => file.id),
    ...(run.inputTreeId ? { treeId: run.inputTreeId } : {}),
    queuedAt: run.queuedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.settledAt ? { settledAt: run.settledAt } : {})
  };
}

/** The lease sheet for queued runs waiting on the person, from the waiting run's own spec. */
export type ReplayLeaseView = BugReplayLeaseRequest;
