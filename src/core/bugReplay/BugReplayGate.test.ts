import { describe, expect, it } from 'vitest';
import type { StoredBugReplayRun } from './BugReplayRecords';
import {
  at,
  attempt,
  bugCaseRecord,
  newestFirst,
  reproducedQualification,
  runRecord,
  TOOLCHAIN,
  versionRecord
} from '../../testSupport/bugReplay/bugReplayFixtures';
import { computeGate, openSetNeeds, owedRuns, verdictAttempt, verificationCovered, type BugCaseState } from './BugReplayGate';

const version = versionRecord();
const approved = [{ id: 'decision-1', caseId: version.caseId, taskId: 'task-1', kind: 'APPROVED' as const, versionId: version.id, createdAt: at(0) }];

function gate(runs: StoredBugReplayRun[], state: BugCaseState = {}) {
  return computeGate({ bugCase: bugCaseRecord(), state, versions: [version], decisions: approved, runs: newestFirst(runs), toolchain: TOOLCHAIN, now: at(60) });
}

describe('Bug gate', () => {
  it('moves from reproducing to reproduced to a verdict about the code it ran', () => {
    expect(gate([runRecord({ kind: 'BASELINE', setId: 'q', state: 'QUEUED' })]).state).toBe('REPRODUCING');

    const qualification = reproducedQualification();
    expect(gate(qualification)).toMatchObject({ state: 'REPRODUCED', baseline: { matched: 2, total: 2, treeId: 'tree-recorded' } });

    const verified = gate([...qualification, ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)], { observedTreeId: 'tree-fix' });
    expect(verified).toMatchObject({ state: 'FIX_VERIFIED', verdictTreeId: 'tree-fix', candidate: { passed: 2, total: 2, treeId: 'tree-fix' } });
  });

  it('marks a verdict out of date when the worktree holds other code', () => {
    const runs = [...reproducedQualification(), ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)];

    expect(gate(runs, { observedTreeId: 'tree-later-edit' })).toMatchObject({
      state: 'STALE',
      verdictTreeId: 'tree-fix',
      fact: 'The code changed after this result'
    });
  });

  it('reuses the verdict of code it already verified when the worktree returns to it', () => {
    // Verified tree A, then a follow-up made B (still failing), then B was undone back to A.
    const runs = [
      ...reproducedQualification(),
      ...attempt('attempt-a', 'tree-a', ['PASSED', 'PASSED'], 10),
      ...attempt('attempt-b', 'tree-b', ['FAILED'], 20)
    ];
    const projection = gate(runs, { observedTreeId: 'tree-a' });

    expect(projection).toMatchObject({ state: 'FIX_VERIFIED', verdictTreeId: 'tree-a' });
    // Every surface reads Before and After from the same attempt the gate decided on.
    expect(verdictAttempt(newestFirst(runs), version.id, projection)?.candidates.map((run) => run.inputTreeId)).toEqual(['tree-a', 'tree-a']);
    expect(gate(runs, { observedTreeId: 'tree-b' })).toMatchObject({ state: 'STILL_FAILING', verdictTreeId: 'tree-b' });
  });

  it('asks the person to allow runs even when newer runs wait behind the requalification', () => {
    const runs = [
      ...reproducedQualification(),
      ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10),
      runRecord({ kind: 'BASELINE', setId: 'requalification', state: 'WAITING', waitingFor: 'APPROVAL', queuedAt: at(30) }),
      runRecord({ kind: 'BASELINE', setId: 'requalification', state: 'WAITING', waitingFor: 'APPROVAL', queuedAt: at(30) }),
      runRecord({ kind: 'CANDIDATE', setId: 'attempt-2', inputTreeId: 'tree-fix', state: 'WAITING', waitingFor: 'QUALIFICATION', queuedAt: at(31) }),
      runRecord({ kind: 'CANDIDATE', setId: 'attempt-2', inputTreeId: 'tree-fix', state: 'WAITING', waitingFor: 'QUALIFICATION', queuedAt: at(32) })
    ];
    const projection = gate(runs, { observedTreeId: 'tree-fix' });

    // The old verdict no longer applies while the bug is rechecked under new terms.
    expect(projection).toMatchObject({ state: 'VERIFYING', fact: 'Rechecking the bug first' });
    expect(projection.activeRun).toMatchObject({ kind: 'BASELINE', waitingFor: 'APPROVAL' });
  });

  it('starts changed expectations over: the earlier version’s verdict never stands for them', () => {
    const changed = versionRecord({ id: '9c4f5d6e-7081-4c93-9da4-c5e6f708192a', version: 2, revisionKind: 'EXPECTATION_CHANGED' });
    const decisions = [
      ...approved,
      { id: 'decision-2', caseId: version.caseId, taskId: 'task-1', kind: 'APPROVED' as const, versionId: changed.id, createdAt: at(30) },
      { id: 'decision-3', caseId: version.caseId, taskId: 'task-1', kind: 'SUPERSEDED' as const, versionId: version.id, createdAt: at(30) }
    ];
    const ofChanged = (runs: StoredBugReplayRun[]) => runs.map((run) => ({ ...run, versionId: changed.id }));
    const gateOf = (runs: StoredBugReplayRun[]) =>
      computeGate({ bugCase: bugCaseRecord(), state: { observedTreeId: 'tree-fix' }, versions: [version, changed], decisions, runs: newestFirst(runs), toolchain: TOOLCHAIN, now: at(60) });
    // Version 1 was reproduced and its fix verified on the code the worktree holds.
    const earlier = [...reproducedQualification(), ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)];
    const requalifying = ofChanged([
      runRecord({ kind: 'BASELINE', setId: 'qualification-2', state: 'WAITING', waitingFor: 'APPROVAL', queuedAt: at(30) }),
      runRecord({ kind: 'BASELINE', setId: 'qualification-2', state: 'WAITING', waitingFor: 'APPROVAL', queuedAt: at(30) }),
      ...attempt('attempt-2', 'tree-fix', ['OPEN', 'OPEN'], 31)
    ]);

    const rechecking = gateOf([...earlier, ...requalifying]);
    expect(rechecking).toMatchObject({ state: 'VERIFYING', fact: 'Rechecking the bug first', versionId: changed.id, version: 2, baseline: { matched: 0 } });
    expect(rechecking.verdictTreeId).toBeUndefined();
    // The code version 1 verified still owes a verification of the changed expectations.
    expect(verificationCovered(newestFirst([...earlier, ...requalifying]), version.id, 'tree-fix', TOOLCHAIN)).toBe(true);
    expect(verificationCovered(newestFirst(earlier), changed.id, 'tree-fix', TOOLCHAIN)).toBe(false);
    expect(owedRuns(newestFirst(earlier), changed.id)).toEqual([{ kind: 'BASELINE' }, { kind: 'BASELINE' }]);

    // Changed expectations the recorded code does not violate have nothing to verify against.
    const notReproduced = ofChanged([0, 1].map((offset) => runRecord({ kind: 'BASELINE', setId: 'qualification-2', outcome: 'NOT_REPRODUCED', queuedAt: at(40 + offset), settledAt: at(40 + offset) })));
    const refused = gateOf([...earlier, ...notReproduced]);
    expect(refused).toMatchObject({ state: 'NOT_REPRODUCED', versionId: changed.id });
    expect(refused.verdictTreeId).toBeUndefined();
    expect(refused.candidate).toBeUndefined();

    // Reproduced and verified again, the verdict is about the changed expectations.
    const verified = gateOf([...earlier, ...ofChanged([...reproducedQualification('qualification-2', 40), ...attempt('attempt-2', 'tree-fix', ['PASSED', 'PASSED'], 50)])]);
    expect(verified).toMatchObject({ state: 'FIX_VERIFIED', versionId: changed.id, verdictTreeId: 'tree-fix', candidate: { passed: 2, total: 2 } });
  });

  it('states no verdict while the worktree a turn left cannot be read', () => {
    const issue = "Untracked files over 5 MB can't be copied: recording.mov. Ignore or remove them";
    const verified = [...reproducedQualification(), ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)];

    expect(gate(verified, { observedTreeId: 'tree-fix', observedTreeIssue: issue })).toMatchObject({
      state: 'COULDNT_VERIFY',
      fact: `Couldn't verify: untracked files over 5 MB can't be copied: recording.mov. Ignore or remove them`,
      verdictTreeId: 'tree-fix'
    });
    // Before any attempt, the reason is the same: the agent's change cannot be checked.
    expect(gate(reproducedQualification(), { observedTreeIssue: issue })).toMatchObject({ state: 'COULDNT_VERIFY' });
    // A bug that did not reproduce has no fix to verify either way.
    const flaky = [runRecord({ kind: 'BASELINE', setId: 'q', outcome: 'REPRODUCED', queuedAt: at(1) }), runRecord({ kind: 'BASELINE', setId: 'q', outcome: 'NOT_REPRODUCED', queuedAt: at(2) })];
    expect(gate(flaky, { observedTreeIssue: issue }).state).toBe('FLAKY');
  });

  it('decides a due control run by its newest attempt, after a restart cut the first short', () => {
    const runs = [
      ...reproducedQualification(),
      ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10).map((run) => ({ ...run, controlDue: true })),
      runRecord({ kind: 'BASELINE', setId: 'attempt-1', control: true, outcome: 'INTERRUPTED', queuedAt: at(13) }),
      runRecord({ kind: 'BASELINE', setId: 'attempt-1', control: true, outcome: 'REPRODUCED', queuedAt: at(14) })
    ];

    expect(gate(runs, { observedTreeId: 'tree-fix' })).toMatchObject({ state: 'FIX_VERIFIED' });
  });

  it('cannot verify a fix whose attempt ended without a counted result', () => {
    const runs = [...reproducedQualification(), ...attempt('attempt-1', 'tree-fix', ['PASSED'], 10)];
    runs.push(runRecord({ kind: 'CANDIDATE', setId: 'attempt-1', inputTreeId: 'tree-fix', outcome: 'ENV_FILES_CHANGED', queuedAt: at(12), failure: { reason: 'INELIGIBLE', detail: "Couldn't verify: .env changed since the bug was recorded" } }));

    expect(gate(runs, { observedTreeId: 'tree-fix' })).toMatchObject({
      state: 'COULDNT_VERIFY',
      fact: "Couldn't verify: .env changed since the bug was recorded",
      candidate: { passed: 1, total: 2 }
    });
  });
});

describe('Verification coverage', () => {
  const qualification = reproducedQualification();

  it('owes a verification only for code no attempt has decided under this toolchain', () => {
    const runs = newestFirst([...qualification, ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)]);

    expect(verificationCovered(runs, version.id, 'tree-fix', TOOLCHAIN)).toBe(true);
    expect(verificationCovered(runs, version.id, 'tree-other', TOOLCHAIN)).toBe(false);
    // A newer runner or browser decides again.
    expect(verificationCovered(runs, version.id, 'tree-fix', 'toolchain-2')).toBe(false);
  });

  it('owes a new attempt for one a restart cut short, but never loops on one that could not run', () => {
    const interrupted = newestFirst([...qualification, ...attempt('attempt-1', 'tree-fix', ['PASSED', 'INTERRUPTED'], 10)]);
    expect(verificationCovered(interrupted, version.id, 'tree-fix', TOOLCHAIN)).toBe(false);

    const blocked = newestFirst([
      ...qualification,
      runRecord({ kind: 'CANDIDATE', setId: 'attempt-1', inputTreeId: 'tree-fix', outcome: 'PROTECTED_INPUT_CHANGED', queuedAt: at(10) })
    ]);
    expect(verificationCovered(blocked, version.id, 'tree-fix', TOOLCHAIN)).toBe(true);
  });

  it('refills a candidate a restart cut short, a few times at most', () => {
    const interrupted = { state: 'SETTLED' as const, outcome: 'INTERRUPTED' as const, counted: false };
    const passed = { state: 'SETTLED' as const, outcome: 'PASSED' as const, counted: true };

    expect(openSetNeeds([passed, interrupted], 'CANDIDATE')).toBe(1);
    expect(openSetNeeds([interrupted, interrupted, interrupted], 'CANDIDATE')).toBe(0);
    expect(openSetNeeds([passed, { state: 'SETTLED', outcome: 'FAILED', counted: true }], 'CANDIDATE')).toBe(0);
    expect(openSetNeeds([{ state: 'SETTLED', outcome: 'ENV_FILES_CHANGED', counted: false }], 'BASELINE')).toBe(0);
  });
});

describe('Runs a bug still owes', () => {
  it('owes a saved check its first qualification, and nothing twice while a run is open', () => {
    expect(owedRuns([], version.id)).toEqual([{ kind: 'BASELINE' }, { kind: 'BASELINE' }]);

    const failedStart = runRecord({ kind: 'BASELINE', setId: 'q', outcome: 'ENVIRONMENT_FAILED', queuedAt: at(1) });
    const running = runRecord({ kind: 'BASELINE', setId: 'q', state: 'EXECUTING', queuedAt: at(2) });
    expect(owedRuns(newestFirst([failedStart, running]), version.id)).toEqual([]);
    const reproduced = { ...running, state: 'SETTLED' as const, outcome: 'REPRODUCED' as const, counted: true };
    expect(owedRuns(newestFirst([failedStart, reproduced]), version.id)).toEqual([{ kind: 'BASELINE', setId: 'q' }]);
  });

  it('runs a control again when a restart cut it short, a few times at most', () => {
    const passes = attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10).map((run) => ({ ...run, controlDue: true }));
    const control = (minute: number) => runRecord({ kind: 'BASELINE', setId: 'attempt-1', control: true, outcome: 'INTERRUPTED', queuedAt: at(minute) });

    expect(owedRuns(newestFirst([...reproducedQualification(), ...passes]), version.id)).toEqual([{ kind: 'BASELINE', setId: 'attempt-1', control: true }]);
    expect(owedRuns(newestFirst([...reproducedQualification(), ...passes, control(13)]), version.id)).toEqual([{ kind: 'BASELINE', setId: 'attempt-1', control: true }]);
    expect(owedRuns(newestFirst([...reproducedQualification(), ...passes, control(13), control(14), control(15)]), version.id)).toEqual([]);
  });
});
