import type {
  BugReplayGateProjection,
  BugReplayGateState,
  BugReplayRunRecord
} from '../../shared/bugReplay';
import { isDomAssertion, type BugCaseV1 } from '../../shared/bugCase';
import type { BugCaseDecisionRecord, BugCaseRecord, BugCaseVersionRecord, StoredBugReplayRun } from './BugReplayRecords';
import { attemptOutcome, qualificationOutcome, volatileComparisonIds } from './BugReplayVerdict';

/**
 * Pure gate rules: the bug's state from its versions, decisions and runs. Every surface reads the
 * projection this produces, so the board, the Inbox, the Overview and the finish checklist can
 * never disagree about a bug.
 */

/** The version in force: the newest approved one that was not later superseded or withdrawn. */
export function effectiveVersion(versions: BugCaseVersionRecord[], decisions: BugCaseDecisionRecord[]): BugCaseVersionRecord | undefined {
  const ended = new Set<string>();
  const approved: string[] = [];
  for (const decision of decisions) {
    if (!decision.versionId) continue;
    if (decision.kind === 'APPROVED') approved.push(decision.versionId);
    if (decision.kind === 'SUPERSEDED' || decision.kind === 'WITHDRAWN') ended.add(decision.versionId);
  }
  for (let index = approved.length - 1; index >= 0; index -= 1) {
    const id = approved[index];
    if (ended.has(id)) continue;
    return versions.find((version) => version.id === id);
  }
  return undefined;
}

export interface GateInput {
  /** The case, with the bookkeeping it keeps: the follow-up in flight and the code last observed. */
  bugCase: BugCaseRecord;
  versions: BugCaseVersionRecord[];
  decisions: BugCaseDecisionRecord[];
  /** Runs of this case, newest first. */
  runs: StoredBugReplayRun[];
  toolchain: string;
  now: string;
}

export interface GateSets {
  qualification?: StoredBugReplayRun[];
  attempt?: { candidates: StoredBugReplayRun[]; control?: StoredBugReplayRun; controlDue: boolean };
}

/** The newest qualification set and verification attempt of a version. */
export function latestSets(runs: StoredBugReplayRun[], versionId: string): GateSets {
  const forVersion = runs.filter((run) => run.versionId === versionId && run.setId);
  const newestSet = (kind: 'BASELINE' | 'CANDIDATE') => {
    const candidates = forVersion.filter((run) => run.kind === kind && !run.control);
    if (candidates.length === 0) return undefined;
    const newest = candidates.reduce((latest, run) => (run.queuedAt > latest.queuedAt ? run : latest));
    return forVersion
      .filter((run) => run.setId === newest.setId)
      .sort((left, right) => (left.queuedAt < right.queuedAt ? -1 : left.queuedAt > right.queuedAt ? 1 : left.id.localeCompare(right.id)));
  };
  const qualification = newestSet('BASELINE');
  const attemptRuns = newestSet('CANDIDATE');
  const sets: GateSets = {};
  if (qualification) sets.qualification = qualification.filter((run) => run.kind === 'BASELINE');
  if (attemptRuns) {
    const candidates = attemptRuns.filter((run) => run.kind === 'CANDIDATE');
    const control = newestControl(attemptRuns);
    sets.attempt = { candidates, ...(control ? { control } : {}), controlDue: candidates.some((run) => run.controlDue === true) };
  }
  return sets;
}

/** The control run that decides: a restart can cut one short, and its replacement is newer. */
function newestControl(set: StoredBugReplayRun[]): StoredBugReplayRun | undefined {
  return set
    .filter((run) => run.kind === 'BASELINE' && run.control)
    .reduce<StoredBugReplayRun | undefined>((newest, run) => (!newest || run.queuedAt > newest.queuedAt || (run.queuedAt === newest.queuedAt && run.id > newest.id) ? run : newest), undefined);
}

/** Whether a qualification set reproduced the bug, comparing what its two counted runs showed. */
export function qualificationOf(qualification: StoredBugReplayRun[], document: BugCaseV1): ReturnType<typeof qualificationOutcome> {
  const counted = qualification.filter((run) => run.counted).slice(0, 2);
  return qualificationOutcome(qualification, counted.map((run) => run.signatureObserved), volatileComparisonIds(document));
}

export function computeGate(input: GateInput): BugReplayGateProjection {
  const { bugCase } = input;
  const version = effectiveVersion(input.versions, input.decisions);
  const open = input.runs.filter((run) => run.state !== 'SETTLED' && run.kind !== 'RECORD');
  // A run waiting on the person leads: the runs queued behind it wait for that same decision.
  const active = open.find((run) => run.waitingFor === 'APPROVAL' || run.waitingFor === 'KEYSTORE') ?? open[0];
  const base: BugReplayGateProjection = {
    caseId: bugCase.id,
    title: bugCase.title,
    state: 'CAPTURED',
    updatedAt: input.now,
    ...(active ? { activeRun: { runId: active.id, kind: active.kind, ...(active.waitingFor ? { waitingFor: active.waitingFor } : {}) } } : {}),
    ...(bugCase.handoff ? { handoff: { handoffId: bugCase.handoff.handoffId, ...(bugCase.handoff.runId ? { runId: bugCase.handoff.runId } : {}), status: bugCase.handoff.status, since: bugCase.handoff.since } } : {}),
    ...(bugCase.lastSentAt ? { lastSentAt: bugCase.lastSentAt } : {})
  };
  if (!version) return base;
  base.versionId = version.id;
  base.version = version.version;
  const sets = latestSets(input.runs, version.id);
  const qualificationRuns = sets.qualification ?? [];
  const qualification = qualificationOf(qualificationRuns, version.document);
  base.baseline = { matched: qualification.matched, total: qualification.total, treeId: version.baselineTreeId };
  const withState = (gateState: BugReplayGateState, fact?: string): BugReplayGateProjection => ({
    ...base,
    state: gateState,
    ...(fact ? { fact: fact.slice(0, 240) } : {})
  });

  if (qualificationRuns.length === 0) return withState('REPRODUCING');
  if (qualification.state === 'PENDING') {
    // A requalification under a newer toolchain keeps an earlier verdict's attempt waiting.
    if (sets.attempt && sets.attempt.candidates.some((run) => run.state !== 'SETTLED')) {
      return { ...withState('VERIFYING', 'Rechecking the bug first'), candidate: { passed: 0, total: 2 } };
    }
    return withState('REPRODUCING');
  }
  if (qualification.state === 'NOT_REPRODUCED') return withState('NOT_REPRODUCED', qualification.detail);
  if (qualification.state === 'FLAKY') return withState('FLAKY', qualification.detail);
  if (qualification.state === 'BLOCKED') return withState('REPRODUCTION_BLOCKED', qualification.detail);

  // The worktree could not be read after the agent's last turn, so no verdict is about the code
  // it holds now; the reason says what to change.
  const unreadable = bugCase.observedTreeIssue ? `Couldn't verify: ${lowerFirst(bugCase.observedTreeIssue)}` : undefined;

  // Reproduced: the latest verification attempt decides, unless it is about other code than the
  // worktree holds now and an earlier attempt already reached a verdict for that code.
  const latest = sets.attempt;
  if (!latest) return unreadable ? withState('COULDNT_VERIFY', unreadable) : withState('REPRODUCED');
  const latestOutcome = attemptOutcome(latest.candidates, latest.control, latest.controlDue);
  const terms = replayTerms(input.toolchain, bugCase.keepBrowserStorage, version.document);
  const earlier = latestOutcome.state === 'PENDING' ? undefined : attemptForTree(input.runs, version.id, bugCase.observedTreeId, terms, latest);
  const attempt = earlier ?? latest;
  const outcome = earlier ? attemptOutcome(earlier.candidates, earlier.control, earlier.controlDue) : latestOutcome;
  const tree = attempt.candidates.find((run) => run.inputTreeId)?.inputTreeId;
  const agentRunId = attempt.candidates.find((run) => run.agentRunId)?.agentRunId;
  const candidate = { passed: outcome.passed, total: outcome.total, ...(tree ? { treeId: tree } : {}), ...(agentRunId ? { agentRunId } : {}) };
  if (outcome.state === 'PENDING') return { ...withState('VERIFYING'), candidate };
  if (attempt.candidates.every((run) => run.state === 'SETTLED' && (run.outcome === 'SUPERSEDED' || run.outcome === 'CANCELED'))) {
    return unreadable ? withState('COULDNT_VERIFY', unreadable) : withState('REPRODUCED');
  }
  if (unreadable) return { ...withState('COULDNT_VERIFY', unreadable), candidate, ...(tree ? { verdictTreeId: tree } : {}) };
  if (outcome.state === 'COULDNT_VERIFY') return { ...withState('COULDNT_VERIFY', outcome.detail), candidate, ...(tree ? { verdictTreeId: tree } : {}) };
  const verdict = outcome.state === 'FIX_VERIFIED' ? 'FIX_VERIFIED' : 'STILL_FAILING';
  const projection: BugReplayGateProjection = {
    ...withState(verdict, outcome.state === 'STILL_FAILING' ? outcome.detail : undefined),
    candidate,
    ...(tree ? { verdictTreeId: tree } : {})
  };
  if (tree && bugCase.observedTreeId && bugCase.observedTreeId !== tree) {
    return { ...projection, state: 'STALE', fact: 'The code changed after this result' };
  }
  return projection;
}

/**
 * The attempt behind the gate's verdict: the one about the verdict's tree when the gate reused an
 * earlier verdict, otherwise the latest. Every surface reads Before and After from this attempt.
 */
export function verdictAttempt(runs: StoredBugReplayRun[], versionId: string, gate: Pick<BugReplayGateProjection, 'verdictTreeId'>): GateSets['attempt'] | undefined {
  const latest = latestSets(runs, versionId).attempt;
  const tree = gate.verdictTreeId;
  if (!latest || !tree || latest.candidates.some((run) => run.inputTreeId === tree)) return latest;
  const matching = attemptsAbout(runs, versionId, tree)[0];
  return matching ? asAttempt(matching) : latest;
}

/** A version's verification attempts about `treeId`, newest first: each its candidates and controls. */
function attemptsAbout(runs: StoredBugReplayRun[], versionId: string, treeId: string): StoredBugReplayRun[][] {
  const sets = new Map<string, StoredBugReplayRun[]>();
  for (const run of runs) {
    if (run.versionId !== versionId || !run.setId || (run.kind !== 'CANDIDATE' && !run.control)) continue;
    sets.set(run.setId, [...(sets.get(run.setId) ?? []), run]);
  }
  return [...sets.values()]
    .filter((set) => set.some((run) => run.kind === 'CANDIDATE' && run.inputTreeId === treeId))
    .sort((left, right) => newestQueued(right).localeCompare(newestQueued(left)));
}

function asAttempt(set: StoredBugReplayRun[]): NonNullable<GateSets['attempt']> {
  const candidates = set.filter((run) => run.kind === 'CANDIDATE');
  const control = newestControl(set);
  return { candidates, ...(control ? { control } : {}), controlDue: candidates.some((run) => run.controlDue === true) };
}

/**
 * What a verdict holds under: the replay toolchain and, when the bug's checks reload the page,
 * whether browser storage is kept across the reload. A run records its terms; a verdict reached
 * under other terms is never reused, so changing either reproduces and verifies again.
 */
export function replayTerms(toolchain: string, keepBrowserStorage: boolean, document: BugCaseV1): string {
  const reloads = document.assertions.some((assertion) => isDomAssertion(assertion) && assertion.alsoAfterReload);
  return keepBrowserStorage && reloads ? `${toolchain} keeps-storage` : toolchain;
}

/**
 * The newest settled attempt about `treeId` whose verdict counts under these terms, when the
 * latest attempt is about other code. Going back to code already verified needs no new runs.
 */
function attemptForTree(
  runs: StoredBugReplayRun[],
  versionId: string,
  treeId: string | undefined,
  terms: string,
  latest: NonNullable<GateSets['attempt']>
): GateSets['attempt'] | undefined {
  if (!treeId || latest.candidates.some((run) => run.inputTreeId === treeId)) return undefined;
  for (const set of attemptsAbout(runs, versionId, treeId)) {
    if (set.some((run) => run.state !== 'SETTLED')) continue;
    const attempt = asAttempt(set);
    if (!attempt.candidates.some((run) => run.counted && run.toolchain === terms)) continue;
    const outcome = attemptOutcome(attempt.candidates, attempt.control, attempt.controlDue);
    if (outcome.state === 'FIX_VERIFIED' || outcome.state === 'STILL_FAILING') return attempt;
  }
  return undefined;
}

/** States whose verdict is about a verification attempt, so its runs say what happened After. */
const ATTEMPT_VERDICTS: ReadonlySet<BugReplayGateState> = new Set(['STILL_FAILING', 'FIX_VERIFIED', 'STALE', 'COULDNT_VERIFY']);

/**
 * The runs every surface reads Before and After from: the qualification run that reproduced the
 * bug and, once the gate states a verdict about an attempt, that attempt's decisive run (the one
 * that failed, else one that passed). A verification still running has no After yet.
 */
export function verdictEvidence(
  runs: StoredBugReplayRun[],
  versionId: string,
  gate: Pick<BugReplayGateProjection, 'state' | 'verdictTreeId'>
): { reproduced?: StoredBugReplayRun; decisive?: StoredBugReplayRun } {
  const reproduced = (latestSets(runs, versionId).qualification ?? []).find((run) => run.outcome === 'REPRODUCED');
  const candidates = ATTEMPT_VERDICTS.has(gate.state) ? [...(verdictAttempt(runs, versionId, gate)?.candidates ?? [])].reverse() : [];
  const decisive = candidates.find((run) => run.outcome === 'FAILED') ?? candidates.find((run) => run.outcome === 'PASSED');
  return { ...(reproduced ? { reproduced } : {}), ...(decisive ? { decisive } : {}) };
}

function newestQueued(runs: StoredBugReplayRun[]): string {
  return runs.reduce((latest, run) => (run.queuedAt > latest ? run.queuedAt : latest), '');
}

/**
 * A verification is owed for this tree unless an attempt already reached a verdict for it under
 * these terms (`replayTerms`), is still running, ended Couldn't verify, or was cancelled by the
 * person. An attempt a restart or a newer turn cut short owes a new one.
 */
export function verificationCovered(runs: StoredBugReplayRun[], versionId: string, treeId: string, terms: string): boolean {
  const attempts = new Map<string, StoredBugReplayRun[]>();
  for (const run of runs) {
    if (run.versionId !== versionId || !run.setId) continue;
    if (run.kind === 'CANDIDATE' && run.inputTreeId !== treeId) continue;
    const list = attempts.get(run.setId) ?? [];
    list.push(run);
    attempts.set(run.setId, list);
  }
  for (const set of attempts.values()) {
    const candidates = set.filter((run) => run.kind === 'CANDIDATE');
    if (candidates.length === 0) continue;
    if (set.some((run) => run.state !== 'SETTLED')) return true;
    if (set.some((run) => run.outcome === 'CANCELED' && run.failure?.reason === 'CANCELED_BY_PERSON')) return true;
    const control = newestControl(set);
    const outcome = attemptOutcome(candidates, control, candidates.some((run) => run.controlDue === true));
    if (outcome.state === 'FIX_VERIFIED' || outcome.state === 'STILL_FAILING') {
      if (candidates.some((run) => run.counted && run.toolchain === terms)) return true;
      continue;
    }
    if (outcome.state === 'COULDNT_VERIFY') {
      const cutShort = candidates.some((run) => run.outcome === 'INTERRUPTED' || run.outcome === 'SUPERSEDED') || control?.outcome === 'INTERRUPTED';
      if (!cutShort) return true;
    }
  }
  return false;
}

const MAX_INTERRUPTED_CANDIDATES = 3;
const MAX_INTERRUPTED_CONTROLS = 3;

/** A run a version's sets still need, described by the set it joins. */
export interface OwedRun {
  kind: 'BASELINE' | 'CANDIDATE';
  /** The set it joins; absent for a version's first qualification. */
  setId?: string;
  control?: boolean;
  /** The candidate it repeats: its tree, agent turn and control flag. */
  like?: StoredBugReplayRun;
}

/**
 * The runs a version still needs: its first qualification, the replacement for an infrastructure
 * failure, members a restart cut short, and the control run a verified attempt is due. One rule
 * for saving, refilling and startup, so a run is never queued twice or never.
 */
export function owedRuns(runs: StoredBugReplayRun[], versionId: string): OwedRun[] {
  const sets = latestSets(runs, versionId);
  if (!sets.qualification) return [{ kind: 'BASELINE' }, { kind: 'BASELINE' }];
  const owed: OwedRun[] = [];
  const qualificationSet = sets.qualification[0].setId!;
  for (let index = openSetNeeds(sets.qualification, 'BASELINE'); index > 0; index -= 1) owed.push({ kind: 'BASELINE', setId: qualificationSet });
  const attempt = sets.attempt;
  if (!attempt || attempt.candidates.length === 0) return owed;
  const like = attempt.candidates[0];
  const attemptSet = like.setId!;
  const needs = openSetNeeds(attempt.candidates, 'CANDIDATE');
  for (let index = needs; index > 0; index -= 1) owed.push({ kind: 'CANDIDATE', setId: attemptSet, like });
  // Two passes on an old qualification add one control run on the recorded code; a restart that
  // cuts it short runs it again, a few times at most.
  const passed = attempt.candidates.filter((run) => run.outcome === 'PASSED').length;
  if (needs === 0 && passed >= 2 && attempt.controlDue && attempt.candidates.every((run) => run.state === 'SETTLED')) {
    const controls = runs.filter((run) => run.setId === attemptSet && run.kind === 'BASELINE' && run.control);
    const interrupted = controls.filter((run) => run.outcome === 'INTERRUPTED').length;
    const control = attempt.control;
    if (!control || (control.state === 'SETTLED' && control.outcome === 'INTERRUPTED' && interrupted < MAX_INTERRUPTED_CONTROLS)) {
      owed.push({ kind: 'BASELINE', setId: attemptSet, control: true });
    }
  }
  return owed;
}

/** How many more runs an open set needs; a closed set never asks for more. */
export function openSetNeeds(set: Pick<BugReplayRunRecord, 'state' | 'outcome' | 'counted' | 'failure'>[], kind: 'BASELINE' | 'CANDIDATE'): number {
  if (set.some((run) => run.state !== 'SETTLED')) return 0;
  const counted = set.filter((run) => run.counted);
  if (kind === 'CANDIDATE') {
    if (counted.some((run) => run.outcome === 'FAILED')) return 0;
    // A run Task Monki's own restart cut short is no verdict: it is run again, a few times at most.
    const interrupted = set.filter((run) => run.outcome === 'INTERRUPTED').length;
    if (interrupted >= MAX_INTERRUPTED_CANDIDATES) return 0;
    if (set.some((run) => !run.counted && run.outcome !== 'INTERRUPTED')) return 0;
    return Math.max(0, 2 - counted.length);
  }
  const terminal = set.some((run) => ['BLOCKED', 'ENV_FILES_CHANGED', 'CANCELED', 'SUPERSEDED'].includes(run.outcome ?? ''));
  if (terminal) return 0;
  const infrastructure = set.filter((run) => run.outcome === 'ENVIRONMENT_FAILED').length;
  if (infrastructure >= 2) return 0;
  return Math.max(0, 2 - counted.length);
}

function lowerFirst(value: string): string {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}
