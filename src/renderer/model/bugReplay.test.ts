import { describe, expect, it } from 'vitest';
import type { BugCaptureView, BugReplayGateProjection, BugRecordingSessionView } from '../../shared/bugReplay';
import { makeTaskRecord } from '../../testSupport/rendererRecords';
import { totalDraft } from '../../testSupport/bugReplay/bugReplayFixtures';
import {
  bugActionLabel,
  bugOwnsNowPanel,
  captureSaveState,
  describeBugAttention,
  expectationsDraft,
  expectationsSaveState,
  fitRecordingViewport,
  keepExpectation,
  layoutBugActions,
  openExpectationsEditor,
  recordingHead,
  removeExpectationRow,
  shownExpectationRows
} from './bugReplay';
import { describeTaskAttention } from './taskAttention';
import { finishRequirementsForTask, getFinishEvidenceState } from './taskFinish';

function gate(overrides: Partial<BugReplayGateProjection>): BugReplayGateProjection {
  return { caseId: 'case-1', title: 'Coupon total is wrong', state: 'REPRODUCED', versionId: 'version-1', version: 1, updatedAt: '2026-10-17T10:00:00.000Z', ...overrides };
}

describe('Bug actions', () => {
  it('leads with the decision the bug waits on, then the state step, and keeps the rest in the menu', () => {
    expect(layoutBugActions(['send-to-agent', 'verify-again', 'run-again', 'remove'], 'REPRODUCED')).toEqual({
      primary: 'send-to-agent',
      secondary: [],
      menu: ['verify-again', 'run-again', 'remove']
    });
    expect(layoutBugActions(['allow-runs', 'cancel-run', 'remove'], 'VERIFYING')).toEqual({
      primary: 'allow-runs',
      secondary: ['cancel-run'],
      menu: ['remove']
    });
    // Nothing is owed once the fix is verified: every action waits in the menu.
    expect(layoutBugActions(['verify-again', 'remove'], 'FIX_VERIFIED')).toEqual({ secondary: [], menu: ['verify-again', 'remove'] });
  });

  it('calls the first verification what it is', () => {
    expect(bugActionLabel('verify-again', { keepBrowserStorage: false, gate: {} })).toBe('Verify fix');
    expect(bugActionLabel('verify-again', { keepBrowserStorage: false, gate: { candidate: { passed: 2, total: 2 } } })).toBe('Verify again');
    expect(bugActionLabel('use-new-env-files', { keepBrowserStorage: false, envFilesChanged: ['.env', '.env.local'] })).toBe('Use the new env files');
  });
});

describe('Bug attention', () => {
  it('asks only for what the person owes, with the reason beside the state', () => {
    expect(describeBugAttention(gate({ state: 'COULDNT_VERIFY', fact: "Couldn't verify: .env changed since the bug was recorded" }), false))
      .toEqual({ label: "Couldn't verify the fix", tone: 'warning', detail: '.env changed since the bug was recorded' });
    expect(describeBugAttention(gate({ state: 'VERIFYING', activeRun: { runId: 'run-1', kind: 'BASELINE', waitingFor: 'APPROVAL' } }), false))
      .toMatchObject({ label: 'Replays need approval', tone: 'warning' });
    // The agent is working on it, or nothing is owed: no attention.
    expect(describeBugAttention(gate({ state: 'STILL_FAILING' }), true)).toBeUndefined();
    expect(describeBugAttention(gate({ state: 'FIX_VERIFIED' }), false)).toBeUndefined();
  });

  it('ranks a bug after Git trouble and before the agent review on the board', () => {
    const failing = gate({ state: 'STILL_FAILING', fact: 'After: total showed "$40.00"' });
    const reviewed = { status: 'COMPLETED', result: { verdict: 'REQUEST_CHANGES' } } as never;

    expect(describeTaskAttention(makeTaskRecord({ workflowPhase: 'REVIEW', projection: { bugReplay: failing, agentReview: reviewed } })))
      .toMatchObject({ kind: 'bug', label: 'Bug still failing' });
    expect(describeTaskAttention(makeTaskRecord({ workflowPhase: 'REVIEW', projection: { bugReplay: failing, git: 'CONFLICTED' } })))
      .toMatchObject({ kind: 'git' });
  });
});

describe('The Now panel and a recorded bug', () => {
  it('leaves the step to Start implementation before the first turn, except a decision about clean runs', () => {
    const reproduced = gate({ state: 'REPRODUCED' });
    const waiting = gate({ state: 'REPRODUCING', activeRun: { runId: 'run-1', kind: 'BASELINE', waitingFor: 'APPROVAL' } });

    expect(bugOwnsNowPanel(reproduced, { agentWorking: false, implementationStarted: true })).toBe(true);
    // Starting the task sends the bug with it: the Now panel offers that start.
    expect(bugOwnsNowPanel(reproduced, { agentWorking: false, implementationStarted: false })).toBe(false);
    expect(bugOwnsNowPanel(waiting, { agentWorking: false, implementationStarted: false })).toBe(true);
    expect(bugOwnsNowPanel(reproduced, { agentWorking: true, implementationStarted: true })).toBe(false);
  });
});

describe('Finishing with a recorded bug', () => {
  it('shows the bug as a fact of finishing and never blocks Mark done on it', () => {
    const verified = makeTaskRecord({ workflowPhase: 'REVIEW', projection: { bugReplay: gate({ state: 'FIX_VERIFIED', verdictTreeId: 'tree-fix' }) } });
    expect(finishRequirementsForTask(verified, 'PASSED')).toContainEqual({ label: 'Bug', fact: 'Fix verified', tone: 'success', unresolved: false });
    // While the worktree is compared with the verdict, the result is not claimed.
    expect(finishRequirementsForTask(verified, 'PASSED', undefined, undefined, undefined, undefined, true))
      .toContainEqual({ label: 'Bug', fact: 'Checking current files', tone: 'info', unresolved: true });

    const failing = makeTaskRecord({ workflowPhase: 'REVIEW', projection: { git: 'CLEAN', bugReplay: gate({ state: 'STILL_FAILING', fact: 'After: total showed "$40.00"' }) } });
    const evidence = getFinishEvidenceState(failing, 'PASSED', 0);
    expect(evidence.mode).toBe('override');
    expect(evidence.warnings).toContainEqual({ title: 'The recorded bug still fails.', detail: 'After: total showed "$40.00"' });
  });

  it('has nothing to say about a bug kept without a check', () => {
    const captured = makeTaskRecord({ workflowPhase: 'REVIEW', projection: { git: 'CLEAN', bugReplay: gate({ state: 'CAPTURED', versionId: undefined }) } });

    expect(finishRequirementsForTask(captured, 'PASSED').map((requirement) => requirement.label)).not.toContain('Bug');
    expect(getFinishEvidenceState(captured, 'PASSED', 0).warnings).toEqual([]);
  });
});

describe('Recording workspace', () => {
  const recording = (overrides: Partial<BugRecordingSessionView>): BugRecordingSessionView => ({
    sessionId: 'session-1',
    runId: 'run-1',
    phase: 'RECORDING',
    startedAt: '2026-10-17T10:00:00.000Z',
    ...overrides
  });

  it('names one state in the bar, in neutral ink, and leaves decisions and failures to the card in the page\'s place', () => {
    // The page's path belongs to the page's own bar, not the workspace's.
    expect(recordingHead(recording({ phase: 'RECORDING', routePath: '/checkout' }))).toEqual({ title: 'Recording', tone: 'neutral', working: false });
    expect(recordingHead(recording({ phase: 'MARKING', detail: 'Point at what is wrong' }))).toEqual({ title: "Point at what's wrong", tone: 'neutral', working: false });
    expect(recordingHead(recording({ phase: 'MARKING' }))).toMatchObject({ title: 'Mark the bug' });
    expect(recordingHead(recording({ phase: 'STARTING' }))).toEqual({ title: 'Starting the app', tone: 'neutral', working: true });
    for (const phase of ['NEEDS_APPROVAL', 'CHOOSING_ENV_FILES', 'FAILED'] as const) {
      expect(recordingHead(recording({ phase, failure: { title: 'The web service stopped', detail: 'x' } }))).toEqual({ title: 'Record a bug', tone: 'neutral', working: false });
    }
    // A recording that stopped says so; the page's place says why.
    expect(recordingHead(recording({ phase: 'INTERRUPTED', failure: { title: 'The web service stopped', detail: 'x' } }))).toEqual({ title: 'Recording stopped', tone: 'neutral', working: false });
  });

  it('fits the recorded viewport into the space without enlarging it', () => {
    expect(fitRecordingViewport({ width: 624, height: 568 })).toEqual({ width: 624, height: 390 });
    expect(fitRecordingViewport({ width: 2000, height: 1400 })).toEqual({ width: 1280, height: 800 });
    expect(fitRecordingViewport({ width: 0, height: 500 })).toEqual({ width: 0, height: 0 });
  });

  it('offers Save and reproduce only for the draft the latest preview describes', () => {
    const capture = { draftRevision: 3 } as BugCaptureView;
    const preview = { draftRevision: 3, reproducible: true, checks: [], valueRows: [] };

    expect(captureSaveState(totalDraft({ title: ' ' }), preview, capture)).toMatchObject({ reproducible: false, reason: 'Name the bug first', canSaveEvidence: false });
    expect(captureSaveState(totalDraft({}, ''), preview, capture)).toMatchObject({ reproducible: false, reason: 'Write what it should read' });
    // A verdict about other picks says nothing about these.
    expect(captureSaveState(totalDraft(), { ...preview, draftRevision: 2 }, capture)).toEqual({ reproducible: false, canSaveEvidence: true });
    expect(captureSaveState(totalDraft(), preview, capture)).toEqual({ reproducible: true, canSaveEvidence: true });
  });
});

describe('Changing a saved bug’s expectations', () => {
  const editor = () => openExpectationsEditor({
    id: 'version-1',
    expectations: [
      { kind: 'element', id: 'a1', name: 'Cart total', recorded: 'Showed "$40.00"', template: 'equals', expected: '$45.00', alsoAfterReload: false, field: false },
      { kind: 'request', name: 'POST /api/orders', recorded: '200', failed: false, write: true, status: { id: 'r2', check: 'answered' }, sentOnceId: 'r3', valueIds: ['v4'] },
      { kind: 'value', id: 'v4', name: 'POST /api/orders returns total', recorded: 'Was 40', expected: '45' }
    ]
  });

  it('removes a request with the values that read its answer, and lists a request while any of its expectations stays', () => {
    const opened = editor();
    const request = opened.rows[1];

    const withoutRequest = removeExpectationRow(opened, request);
    expect(expectationsDraft(withoutRequest).expectations).toEqual([
      { kind: 'element', id: 'a1', template: 'equals', expected: '$45.00', alsoAfterReload: false }
    ]);
    expect(shownExpectationRows(withoutRequest).map(({ row }) => row.kind)).toEqual(['element']);

    // Without Sent once the request still expects a status, so it stays listed.
    const withoutSentOnce = keepExpectation(opened, 'r3', false);
    expect(shownExpectationRows(withoutSentOnce).map(({ row }) => row.kind)).toEqual(['element', 'request', 'value']);
    expect(expectationsDraft(withoutSentOnce).expectations.map((edit) => [edit.kind, edit.id])).toEqual([['element', 'a1'], ['status', 'r2'], ['value', 'v4']]);
  });

  it('saves only a change the recording still shows a bug against, and explains only a change it refuses', () => {
    // An untouched form and its disabled Save need no words.
    expect(expectationsSaveState(false, undefined)).toEqual({ canSave: false });
    // While the first answer is on its way nothing is claimed either way.
    expect(expectationsSaveState(true, undefined)).toEqual({ canSave: false });
    // Typed, but the same as the case reads it.
    expect(expectationsSaveState(true, { versionId: 'version-1', changed: false, reproducible: true, checks: [] })).toEqual({ canSave: false, reason: 'No changes' });
    expect(expectationsSaveState(true, { versionId: 'version-1', changed: true, reproducible: false, reason: 'No expectation failed in the recording', checks: [] }))
      .toEqual({ canSave: false, reason: 'No expectation failed in the recording' });
    expect(expectationsSaveState(true, { versionId: 'version-1', changed: true, reproducible: true, checks: [] })).toEqual({ canSave: true });
  });
});
