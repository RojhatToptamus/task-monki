import { describe, expect, it } from 'vitest';
import type { BugCaptureView, BugReplayGateProjection, BugRecordingSessionView } from '../../shared/bugReplay';
import { makeTaskRecord } from '../../testSupport/rendererRecords';
import { totalDraft } from '../../testSupport/bugReplay/bugReplayFixtures';
import {
  bugActionLabel,
  bugOwnsNowPanel,
  captureSaveState,
  describeBugAttention,
  fitRecordingViewport,
  layoutBugActions,
  recordingHead
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
      .toMatchObject({ label: 'Clean runs need approval', tone: 'warning' });
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

  it('names one state in the toolbar and leaves decisions and failures to the block below', () => {
    expect(recordingHead(recording({ phase: 'RECORDING', routePath: '/checkout' }))).toMatchObject({ title: 'Recording', detail: '/checkout', detailMono: true });
    expect(recordingHead(recording({ phase: 'MARKING', detail: 'Point at what is wrong' }))).toMatchObject({ title: "Point at what's wrong", tone: 'action' });
    expect(recordingHead(recording({ phase: 'MARKING' }))).toMatchObject({ title: 'Mark the bug' });
    for (const phase of ['NEEDS_APPROVAL', 'CHOOSING_ENV_FILES', 'FAILED'] as const) {
      expect(recordingHead(recording({ phase, failure: { title: 'The web service stopped', detail: 'x' } }))).toEqual({ title: 'Record a bug', tone: 'neutral', working: false });
    }
    // A recording that stopped says so; the block below says why.
    expect(recordingHead(recording({ phase: 'INTERRUPTED', failure: { title: 'The web service stopped', detail: 'x' } }))).toEqual({ title: 'Recording stopped', tone: 'action', working: false });
  });

  it('fits the recorded viewport into the space without enlarging it', () => {
    expect(fitRecordingViewport({ width: 624, height: 568 })).toEqual({ width: 624, height: 390 });
    expect(fitRecordingViewport({ width: 2000, height: 1400 })).toEqual({ width: 1280, height: 800 });
    expect(fitRecordingViewport({ width: 0, height: 500 })).toEqual({ width: 0, height: 0 });
  });

  it('offers Save and reproduce only for the draft the latest preview describes', () => {
    const capture = { draftRevision: 3 } as BugCaptureView;
    const preview = { draftRevision: 3, reproducible: true, checks: [], valueRows: [] };

    expect(captureSaveState(totalDraft({ title: ' ' }), preview, capture, false)).toMatchObject({ reproducible: false, reason: 'Name the bug first', canSaveEvidence: false });
    expect(captureSaveState(totalDraft({}, ''), preview, capture, false)).toMatchObject({ reproducible: false, reason: 'Write what it should read' });
    expect(captureSaveState(totalDraft(), { ...preview, draftRevision: 2 }, capture, false)).toEqual({ reproducible: false, canSaveEvidence: true });
    expect(captureSaveState(totalDraft(), preview, capture, true)).toEqual({ reproducible: false, canSaveEvidence: true });
    expect(captureSaveState(totalDraft(), preview, capture, false)).toEqual({ reproducible: true, canSaveEvidence: true });
  });
});
