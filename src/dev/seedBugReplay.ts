import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileBugCase } from '../core/bugReplay/BugCaseCompiler';
import { computeGate } from '../core/bugReplay/BugReplayGate';
import type {
  BugCaptureRecord,
  BugCaseDecisionRecord,
  BugCaseRecord,
  BugCaseVersionRecord,
  StoredBugReplayRun
} from '../core/bugReplay/BugReplayRecords';
import { replayEnvironmentName } from '../core/bugReplay/ReplayDerivation';
import { bugReplayRef, type ReviewSnapshotStore } from '../core/git/ReviewSnapshotStore';
import { createDomainEvent } from '../core/storage/domainEvent';
import type { SqliteBugReplayStore } from '../core/storage/sqlite/SqliteBugReplayStore';
import type { SqliteTaskStore } from '../core/storage/SqliteTaskStore';
import { BUG_RECORDING_SCHEMA, type BugRecordingLogV1 } from '../shared/bugRecording';
import type { BugReplayGateProjection, BugReplayRunOutcome } from '../shared/bugReplay';

const execFileAsync = promisify(execFile);

/**
 * Bug Replay's seeded states: a recorded checkout bug on a task's worktree, with the runs that
 * put it in each state the Overview, the board, the Inbox and the Review show. Nothing runs here:
 * the deterministic seed has no replay browser, and every record is one a real run would store.
 */
export type SeedBugState = 'REPRODUCED' | 'FIX_VERIFIED' | 'STILL_FAILING' | 'COULDNT_VERIFY' | 'STALE' | 'EVIDENCE_ONLY';

export interface SeedBugInput {
  store: SqliteBugReplayStore;
  tasks: SqliteTaskStore;
  snapshots: ReviewSnapshotStore;
  taskId: string;
  worktreeId: string;
  worktreePath: string;
  /** The commit the task started from: the code the bug was recorded on. */
  baseSha: string;
  state: SeedBugState;
  /** Adds a removed bug with its evidence, for Debug's Earlier bugs. */
  earlierBug?: boolean;
}

const SEED_TOOLCHAIN = 'seed-toolchain';
const MINUTE = 60_000;

// A 1×1 white PNG: what the Overview shows as a screenshot.
const SCREENSHOT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

function recording(): BugRecordingLogV1 {
  return {
    schema: BUG_RECORDING_SCHEMA,
    environment: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' },
    roles: ['primary'],
    actions: [
      { index: 0, t: 100, kind: 'navigate', location: { role: 'primary', path: '/', query: [] } },
      { index: 1, t: 900, kind: 'fill', value: 'SAVE5', target: { tag: 'input', inputType: 'text', testIds: [], label: 'Coupon code', css: '#coupon' } },
      { index: 2, t: 1500, kind: 'click', target: { tag: 'button', testIds: [], role: 'button', name: 'Apply coupon', text: 'Apply coupon', css: '#apply' } }
    ],
    requests: [
      { id: 'r1', t: 120, method: 'GET', role: 'primary', path: '/', queryKeys: [], resourceType: 'document', outcome: 'response', status: 200, fromServiceWorker: false },
      { id: 'r2', t: 1520, method: 'POST', role: 'primary', path: '/api/coupons/apply', queryKeys: [], resourceType: 'fetch', outcome: 'response', status: 200, fromServiceWorker: false, actionIndex: 2 }
    ],
    console: [],
    coverage: { complete: true, reasons: [], blockedHosts: [] },
    mark: {
      t: 2500,
      actionIndex: 2,
      window: { startT: 1500, endT: 2500 },
      location: { role: 'primary', path: '/', query: [] },
      picks: [{
        target: { tag: 'span', testIds: [{ attribute: 'data-testid', value: 'cart-total' }], text: '$40.00', context: 'Cart total', css: '#cart-total' },
        text: '$40.00',
        visible: true,
        count: 1
      }]
    }
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Seeds one recorded bug in `state` and publishes its gate on the task, as Bug Replay would. */
export async function seedRecordedBug(input: SeedBugInput): Promise<BugReplayGateProjection | undefined> {
  const { store, taskId } = input;
  const started = Date.now() - 90 * MINUTE;
  const at = (minutes: number) => new Date(started + minutes * MINUTE).toISOString();
  const recipe = { name: 'preview.yaml' as const, text: 'name: checkout\ntype: command\ncommand: [node, server.js]\nreadyPath: /\n', sha256: '' };
  recipe.sha256 = sha256(recipe.text);
  const recordedTree = (await execFileAsync('git', ['rev-parse', `${input.baseSha}^{tree}`], { cwd: input.worktreePath })).stdout.trim();
  const { treeId: currentTree } = await input.snapshots.captureTree(input.worktreePath, bugReplayRef(taskId, 'seed-current'));

  const compiled = compileBugCase(recording(), {
    title: 'Coupon total is wrong',
    statement: 'SAVE5 takes $5 off a $50 cart.',
    checks: [{ pickIndex: 0, template: 'equals', expected: '$45.00', alsoAfterReload: false }],
    requestRules: [],
    valueChecks: []
  });
  const document = compiled.document!;
  const envFiles = input.state === 'COULDNT_VERIFY' ? [{ relativePath: '.env', sha256: sha256('COUPONS=SAVE5\n') }] : [];

  const capture: BugCaptureRecord = {
    id: randomUUID(),
    taskId,
    worktreeId: input.worktreeId,
    recordingRunId: randomUUID(),
    sourceTreeId: recordedTree,
    environment: document.environment,
    engine: { chromium: '152.0.0.0' },
    coverage: input.state === 'EVIDENCE_ONLY'
      ? { complete: false, reasons: ['Recording stopped early: the web service stopped'] }
      : { complete: true, reasons: [] },
    roles: ['primary'],
    recipe,
    templateDigest: sha256(`template:${taskId}`),
    envFiles,
    pageTitle: 'Checkout',
    stepSummaries: ['Open /', 'Type "SAVE5" into "Coupon code"', 'Click "Apply coupon"'],
    fileIds: { screenshots: [] },
    createdAt: at(0)
  };
  const bugCase: BugCaseRecord = {
    id: randomUUID(),
    taskId,
    captureId: capture.id,
    title: input.state === 'EVIDENCE_ONLY' ? 'Checkout froze after Apply coupon' : 'Coupon total is wrong',
    statement: 'SAVE5 takes $5 off a $50 cart.',
    status: 'ACTIVE',
    keepBrowserStorage: false,
    createdAt: at(0),
    updatedAt: at(0),
    revision: 0
  };
  const version: BugCaseVersionRecord | undefined = input.state === 'EVIDENCE_ONLY' ? undefined : {
    id: randomUUID(),
    caseId: bugCase.id,
    taskId,
    version: 1,
    digest: sha256(JSON.stringify(document)),
    revisionKind: 'INITIAL',
    document,
    recipe,
    templateDigest: capture.templateDigest,
    protectedInputs: [],
    sharedSetup: [],
    envFiles,
    baselineTreeId: recordedTree,
    toolchain: SEED_TOOLCHAIN,
    createdAt: at(0)
  };
  const decisions: BugCaseDecisionRecord[] = version
    ? [{ id: randomUUID(), caseId: bugCase.id, taskId, kind: 'APPROVED', versionId: version.id, createdAt: at(0) }]
    : [];

  const runs: StoredBugReplayRun[] = [];
  const assertionId = document.assertions[0].id;
  const run = (fields: {
    kind: 'BASELINE' | 'CANDIDATE';
    setId: string;
    minute: number;
    outcome: BugReplayRunOutcome;
    tree: string;
    observed?: string;
    failure?: StoredBugReplayRun['failure'];
  }) => {
    const counted = ['REPRODUCED', 'NOT_REPRODUCED', 'PASSED', 'FAILED'].includes(fields.outcome);
    runs.push({
      id: randomUUID(),
      taskId,
      kind: fields.kind,
      caseId: bugCase.id,
      versionId: version!.id,
      setId: fields.setId,
      state: 'SETTLED',
      outcome: fields.outcome,
      counted,
      name: replayEnvironmentName(randomBytes(6).toString('hex')),
      inputTreeId: fields.tree,
      observations: fields.observed ? [{ assertionId, passed: fields.outcome === 'PASSED', observed: fields.observed }] : [],
      facts: [],
      fileIds: [],
      queuedAt: at(fields.minute),
      startedAt: at(fields.minute),
      settledAt: at(fields.minute + 1),
      revision: 1,
      toolchain: SEED_TOOLCHAIN,
      ...(fields.failure ? { failure: fields.failure } : {}),
      ...(fields.kind === 'BASELINE' ? { signatureObserved: { [assertionId]: 'Cart total showed "$40.00"' } } : {})
    });
  };

  let observedTreeId: string | undefined;
  if (version) {
    const qualification = randomUUID();
    run({ kind: 'BASELINE', setId: qualification, minute: 1, outcome: 'REPRODUCED', tree: recordedTree, observed: 'Cart total showed "$40.00"' });
    run({ kind: 'BASELINE', setId: qualification, minute: 2, outcome: 'REPRODUCED', tree: recordedTree, observed: 'Cart total showed "$40.00"' });
    const attempt = randomUUID();
    switch (input.state) {
      case 'FIX_VERIFIED':
      case 'STALE': {
        // Out of date: the verdict is about the recorded code, and the worktree now holds the change.
        const tree = input.state === 'STALE' ? recordedTree : currentTree;
        run({ kind: 'CANDIDATE', setId: attempt, minute: 30, outcome: 'PASSED', tree, observed: 'Cart total showed "$45.00"' });
        run({ kind: 'CANDIDATE', setId: attempt, minute: 31, outcome: 'PASSED', tree, observed: 'Cart total showed "$45.00"' });
        observedTreeId = currentTree;
        break;
      }
      case 'STILL_FAILING':
        run({
          kind: 'CANDIDATE',
          setId: attempt,
          minute: 30,
          outcome: 'FAILED',
          tree: currentTree,
          observed: 'Cart total showed "$40.00"',
          failure: { reason: 'CHECK_FAILED', detail: 'After: Cart total showed "$40.00"', assertionId }
        });
        observedTreeId = currentTree;
        break;
      case 'COULDNT_VERIFY':
        run({
          kind: 'CANDIDATE',
          setId: attempt,
          minute: 30,
          outcome: 'ENV_FILES_CHANGED',
          tree: currentTree,
          failure: { reason: 'INELIGIBLE', detail: "Couldn't verify: .env changed since the bug was recorded" }
        });
        observedTreeId = currentTree;
        break;
      case 'REPRODUCED':
        break;
    }
  }

  const screenshot = await store.publishFile({ taskId, ownerKind: 'CAPTURE', ownerId: capture.id, kind: 'SCREENSHOT', mediaType: 'image/png', bytes: SCREENSHOT });
  capture.fileIds = { screenshots: [screenshot.id] };
  const earlier = input.earlierBug ? await earlierRemovedBug(input, at) : undefined;

  const gate = await store.write((tx) => {
    if (earlier) {
      store.insertCapture(tx, earlier.capture);
      store.insertCase(tx, earlier.bugCase);
      store.recordFile(tx, earlier.file);
    }
    store.insertCapture(tx, capture);
    store.insertCase(tx, { ...bugCase, ...(observedTreeId ? { observedTreeId } : {}) });
    if (version) store.insertVersion(tx, version);
    for (const decision of decisions) store.insertDecision(tx, decision);
    for (const record of runs) store.insertRun(tx, record);
    store.recordFile(tx, screenshot);
    return computeGate({
      bugCase,
      state: observedTreeId ? { observedTreeId } : {},
      versions: version ? [version] : [],
      decisions,
      runs: [...runs].sort((left, right) => right.queuedAt.localeCompare(left.queuedAt)),
      toolchain: SEED_TOOLCHAIN,
      now: at(40)
    });
  });
  await input.tasks.appendEvent(createDomainEvent({
    type: version ? 'BUG_REPLAY_RUN_SETTLED' : 'BUG_CAPTURED',
    taskId,
    source: 'replay',
    payload: { gate }
  }));
  return gate;
}

/** A bug the person removed, still holding its recording, for Debug's Earlier bugs. */
async function earlierRemovedBug(input: SeedBugInput, at: (minutes: number) => string) {
  const capture: BugCaptureRecord = {
    id: randomUUID(),
    taskId: input.taskId,
    worktreeId: input.worktreeId,
    recordingRunId: randomUUID(),
    sourceTreeId: (await execFileAsync('git', ['rev-parse', `${input.baseSha}^{tree}`], { cwd: input.worktreePath })).stdout.trim(),
    environment: recording().environment,
    engine: { chromium: '152.0.0.0' },
    coverage: { complete: true, reasons: [] },
    roles: ['primary'],
    recipe: { name: 'preview.yaml', text: 'name: checkout\n', sha256: sha256('name: checkout\n') },
    templateDigest: sha256(`template:${input.taskId}`),
    envFiles: [],
    pageTitle: 'Checkout',
    stepSummaries: ['Open /', 'Click "Checkout"'],
    fileIds: { screenshots: [] },
    createdAt: at(-60)
  };
  const bugCase: BugCaseRecord = {
    id: randomUUID(),
    taskId: input.taskId,
    captureId: capture.id,
    title: 'Checkout hangs with an empty cart',
    status: 'REMOVED',
    keepBrowserStorage: false,
    createdAt: at(-60),
    updatedAt: at(-20),
    revision: 1
  };
  const file = await input.store.publishFile({ taskId: input.taskId, ownerKind: 'CAPTURE', ownerId: capture.id, kind: 'SCREENSHOT', mediaType: 'image/png', bytes: SCREENSHOT });
  capture.fileIds = { screenshots: [file.id] };
  return { capture, bugCase, file };
}
