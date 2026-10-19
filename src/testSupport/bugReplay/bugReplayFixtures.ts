import { compileBugCase } from '../../core/bugReplay/BugCaseCompiler';
import type { BugCaptureRecord, BugCaseRecord, BugCaseVersionRecord, BugRecordedObservation, BugReplayKeptApprovalRecord, StoredBugReplayRun } from '../../core/bugReplay/BugReplayRecords';
import type { BugReplayDomObservation, BugReplayFrame, BugReplayRequestFact } from '../../core/bugReplay/runner/protocol';
import type { BugCaseV1 } from '../../shared/bugCase';
import { BUG_RECORDING_SCHEMA, type BugRecordingLogV1, type BugRecordingPick } from '../../shared/bugRecording';
import type { BugCaptureDraft } from '../../shared/bugReplay';

/**
 * A recorded checkout bug, shaped like the recorder's output: the person opened the shop,
 * typed a coupon, applied it, and marked the cart total, which read $40.00 instead of $45.00.
 */

export const TOTAL_PICK: BugRecordingPick = {
  target: {
    tag: 'span',
    testIds: [{ attribute: 'data-testid', value: 'cart-total' }],
    text: '$40.00',
    context: 'Cart total',
    css: 'html > body > section:nth-of-type(3) > p > span'
  },
  text: '$40.00',
  visible: true,
  count: 1
};

export function checkoutRecording(overrides: { picks?: BugRecordingPick[]; responseDiscount?: number } = {}): BugRecordingLogV1 {
  return {
    schema: BUG_RECORDING_SCHEMA,
    environment: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' },
    roles: ['primary'],
    actions: [
      { index: 0, t: 100, kind: 'navigate', location: { role: 'primary', path: '/', query: [] } },
      {
        index: 1,
        t: 900,
        kind: 'fill',
        value: 'SAVE5',
        target: { tag: 'input', inputType: 'text', testIds: [], label: 'Coupon code', css: '#coupon' }
      },
      {
        index: 2,
        t: 1500,
        kind: 'click',
        target: { tag: 'button', testIds: [], role: 'button', name: 'Apply coupon', text: 'Apply coupon', css: '#apply' }
      }
    ],
    requests: [
      { id: 'r1', t: 120, method: 'GET', role: 'primary', path: '/', queryKeys: [], resourceType: 'document', outcome: 'response', status: 200, fromServiceWorker: false },
      { id: 'r2', t: 300, method: 'GET', role: 'primary', path: '/api/products', queryKeys: [], resourceType: 'fetch', outcome: 'response', status: 200, fromServiceWorker: false },
      {
        id: 'r3',
        t: 1520,
        method: 'POST',
        role: 'primary',
        path: '/api/coupons/apply',
        queryKeys: [],
        resourceType: 'fetch',
        outcome: 'response',
        status: 200,
        fromServiceWorker: false,
        actionIndex: 2,
        requestJson: { code: 'SAVE5' },
        responseJson: { code: 'SAVE5', discount: overrides.responseDiscount ?? 10 }
      }
    ],
    console: [],
    coverage: { complete: true, reasons: [], blockedHosts: [] },
    mark: {
      t: 2500,
      actionIndex: 2,
      window: { startT: 1500, endT: 2500 },
      location: { role: 'primary', path: '/', query: [] },
      picks: overrides.picks ?? [TOTAL_PICK]
    }
  };
}

export function totalDraft(overrides: Partial<BugCaptureDraft> = {}, expected = '$45.00', alsoAfterReload = false): BugCaptureDraft {
  return {
    title: 'Coupon total is wrong',
    statement: 'SAVE5 takes $5 off a $50 cart.',
    checks: [{ pickIndex: 0, template: 'equals', expected, alsoAfterReload }],
    requestRules: [],
    valueChecks: [],
    ...overrides
  };
}

/** The compiled case of the checkout recording and what the recording showed, as saving stores them. */
export function checkoutCompiled(alsoAfterReload = false): { document: BugCaseV1; recorded: Record<string, BugRecordedObservation> } {
  const compiled = compileBugCase(checkoutRecording(), totalDraft({}, '$45.00', alsoAfterReload));
  if (!compiled.document || !compiled.recorded) throw new Error(`The checkout fixture did not compile: ${compiled.reason}`);
  return { document: compiled.document, recorded: compiled.recorded };
}

/** The compiled case of the checkout recording, as saving it would store it. */
export function checkoutCase(alsoAfterReload = false): BugCaseV1 {
  return checkoutCompiled(alsoAfterReload).document;
}

// Runner frames

export function totalObservation(text: string, expected = '$45.00'): BugReplayDomObservation {
  const held = text === expected;
  return { kind: 'dom', found: true, candidateIndex: 0, count: 1, text, visible: true, matched: held, held };
}

export function requestFact(overrides: Partial<BugReplayRequestFact> = {}): BugReplayRequestFact {
  return {
    method: 'POST',
    role: 'primary',
    path: '/api/coupons/apply',
    queryKeys: [],
    resourceType: 'fetch',
    fromServiceWorker: false,
    outcome: 'response',
    status: 200,
    startedAtMs: 40,
    ...overrides
  };
}

/**
 * A run that completed every step and observed the total as `text`, then after reload as
 * `afterReload`, held against what the document expects of it.
 */
export function runFrames(document: BugCaseV1, text: string, afterReload?: string): BugReplayFrame[] {
  const assertion = document.assertions[0];
  const expected = assertion.kind === 'dom.text' ? assertion.value : undefined;
  const frames: BugReplayFrame[] = [
    { type: 'run-started', planSha256: 'a'.repeat(64), browserVersion: '152.0.0.0' },
    ...document.steps.map((step, index): BugReplayFrame => ({ type: 'step', stepId: step.id, index, status: 'done', candidateIndex: 0, atMs: 10 * (index + 1) })),
    { type: 'window', phase: 'main', startedAtMs: 30, endedAtMs: 1200, quiet: true },
    { type: 'requests', phase: 'main', requests: [requestFact()] },
    { type: 'assertion', assertionId: assertion.id, phase: 'main', observation: totalObservation(text, expected) }
  ];
  if (afterReload !== undefined) {
    frames.push(
      { type: 'window', phase: 'afterReload', startedAtMs: 1300, endedAtMs: 2200, quiet: true },
      { type: 'assertion', assertionId: assertion.id, phase: 'afterReload', observation: totalObservation(afterReload, expected) }
    );
  }
  frames.push({ type: 'run-finished', steps: document.steps.length, assertions: 1, frames: frames.length + 1 });
  return frames;
}

// Stored records

export const TOOLCHAIN = 'toolchain-1';
// Stored records use UUIDs, as Task Monki writes them; the task store refuses anything else.
export const CASE_ID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
export const CAPTURE_ID = '7a2d3b4c-5e6f-4a71-9b82-a3c4d5e6f708';
export const VERSION_ID = '8b3e4c5d-6f70-4b82-8c93-b4d5e6f70819';
const BASE_TIME = Date.parse('2026-10-17T10:00:00.000Z');

export function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

export function captureRecord(overrides: Partial<BugCaptureRecord> = {}): BugCaptureRecord {
  return {
    id: CAPTURE_ID,
    taskId: 'task-1',
    worktreeId: 'worktree-1',
    recordingRunId: 'record-run-1',
    sourceTreeId: 'tree-recorded',
    environment: checkoutRecording().environment,
    engine: { chromium: '152.0.0.0' },
    coverage: { complete: true, reasons: [] },
    roles: ['primary'],
    recipe: { name: 'preview.yaml', text: 'name: checkout\ntype: command\ncommand: [node, server.js]\n', sha256: 'e'.repeat(64) },
    templateDigest: 'f'.repeat(64),
    envFiles: [],
    pageTitle: 'Checkout',
    stepSummaries: ['Open /', 'Type "SAVE5" into "Coupon code"', 'Click "Apply coupon"'],
    fileIds: { screenshots: [] },
    createdAt: at(0),
    ...overrides
  };
}

export function bugCaseRecord(overrides: Partial<BugCaseRecord> = {}): BugCaseRecord {
  return {
    id: CASE_ID,
    taskId: 'task-1',
    captureId: CAPTURE_ID,
    title: 'Coupon total is wrong',
    statement: 'SAVE5 takes $5 off a $50 cart.',
    status: 'ACTIVE',
    keepBrowserStorage: false,
    createdAt: at(0),
    updatedAt: at(0),
    revision: 0,
    ...overrides
  };
}

export function versionRecord(overrides: Partial<BugCaseVersionRecord> = {}): BugCaseVersionRecord {
  return {
    id: VERSION_ID,
    caseId: CASE_ID,
    taskId: 'task-1',
    version: 1,
    digest: 'd'.repeat(64),
    revisionKind: 'INITIAL',
    ...checkoutCompiled(),
    recipe: { name: 'preview.yaml', text: 'name: checkout\n', sha256: 'e'.repeat(64) },
    templateDigest: 'f'.repeat(64),
    protectedInputs: [],
    sharedSetup: [],
    envFiles: [],
    baselineTreeId: 'tree-recorded',
    toolchain: TOOLCHAIN,
    createdAt: at(0),
    ...overrides
  };
}

/** Replays of the checkout recipe the person kept approved for its repository. */
export function keptApprovalRecord(overrides: Partial<BugReplayKeptApprovalRecord> = {}): BugReplayKeptApprovalRecord {
  return {
    id: '7f4c1a52-0d6e-4b8a-9c3f-2e1d5a6b7c8d',
    repositoryId: 'repository-1',
    approvalDigest: 'a'.repeat(64),
    commands: [
      { service: 'install', command: 'npm ci --no-audit --no-fund', directory: '.' },
      { service: 'web', command: 'node server.js', directory: '.' }
    ],
    envFiles: [],
    calls: [],
    keptAt: at(0),
    ...overrides
  };
}

let runNumber = 0;

/** A settled run of a set; pass `state` to leave it open. */
export function runRecord(overrides: Partial<StoredBugReplayRun> & Pick<StoredBugReplayRun, 'kind' | 'setId'>): StoredBugReplayRun {
  runNumber += 1;
  const outcome = overrides.outcome;
  return {
    id: `run-${runNumber}`,
    taskId: 'task-1',
    caseId: CASE_ID,
    versionId: VERSION_ID,
    state: 'SETTLED',
    counted: outcome === 'REPRODUCED' || outcome === 'NOT_REPRODUCED' || outcome === 'PASSED' || outcome === 'FAILED',
    name: `br-${String(runNumber).padStart(12, '0')}`,
    observations: [],
    facts: [],
    fileIds: [],
    queuedAt: at(runNumber),
    revision: 1,
    toolchain: TOOLCHAIN,
    ...overrides
  };
}

/** Two baseline runs that reproduced the bug on the recorded code. */
export function reproducedQualification(setId = 'qualification-1', minute = 1): StoredBugReplayRun[] {
  return [0, 1].map((offset) =>
    runRecord({ kind: 'BASELINE', setId, outcome: 'REPRODUCED', queuedAt: at(minute + offset), settledAt: at(minute + offset), signatureObserved: { a1: '$40.00' } })
  );
}

/** A verification attempt of `treeId` whose two candidates ended with `outcomes`. */
export function attempt(setId: string, treeId: string, outcomes: Array<StoredBugReplayRun['outcome'] | 'OPEN'>, minute: number): StoredBugReplayRun[] {
  return outcomes.map((outcome, offset) =>
    outcome === 'OPEN'
      ? runRecord({ kind: 'CANDIDATE', setId, inputTreeId: treeId, state: 'QUEUED', queuedAt: at(minute + offset) })
      : runRecord({ kind: 'CANDIDATE', setId, inputTreeId: treeId, outcome, queuedAt: at(minute + offset), settledAt: at(minute + offset) })
  );
}

/** Newest first, as the store lists runs. */
export function newestFirst(runs: StoredBugReplayRun[]): StoredBugReplayRun[] {
  return [...runs].sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
}
