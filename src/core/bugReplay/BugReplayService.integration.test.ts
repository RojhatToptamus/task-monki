import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PreviewError, type PreviewRuntime, type PreviewSpec, type PreviewStatus } from 'previewhost';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BugReplayGateProjection } from '../../shared/bugReplay';
import type { WorktreeRecord } from '../../shared/contracts';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { CAPTURE_ID, TOTAL_PICK, bugCaseRecord, captureRecord, checkoutCase, checkoutRecording, runFrames, totalDraft, versionRecord } from '../../testSupport/bugReplay/bugReplayFixtures';
import { ReviewSnapshotStore } from '../git/ReviewSnapshotStore';
import { AppEventBus } from '../runner/AppEventBus';
import type { BugReplayFileRecord, StoredBugReplayRun } from './BugReplayRecords';
import { BugRecordingService, type RecordingBrowserHost, type RecordingViewInput } from './BugRecordingService';
import { BugReplayRunner, type BugReplayRunnerRequest, type BugReplayRunnerResult } from './BugReplayRunner';
import { BugReplayService } from './BugReplayService';
import { ReplayAuthorization } from './ReplayAuthorization';
import type { RecorderPickOutcome, RecorderSession } from './recorder/RecorderSession';

/**
 * Bug Replay's queue end to end over real storage and real Git trees: clean runs are admitted,
 * started on a stand-in for Previewhost, replayed by a scripted runner, settled and refilled.
 * What these protect is how runs end (shutdown, cancel, failures) and what is queued after.
 */

const RECIPE = [
  'name: checkout',
  'type: environment',
  'primary: web',
  'services:',
  '  web:',
  '    type: command',
  '    cwd: .',
  '    command: [node, server.js]',
  '    readyPath: /',
  ''
].join('\n');

/** Previewhost as a clean run sees it: names, attempts that become ready, stops and removals. */
class StandInPreviewRuntime {
  readonly statuses = new Map<string, PreviewStatus>();
  readonly started: string[] = [];
  /** `list` fails this many more times, as when Previewhost does not answer. */
  listFailures = 0;
  private attempts = 0;
  readonly keystore = { status: async () => ({ state: 'unlocked' as const }) };

  constructor(private readonly url: string) {}

  async inspect() {
    return { prerequisites: [] };
  }

  async list() {
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error('Previewhost did not answer.');
    }
    return [...this.statuses.values()];
  }

  async get(name: string): Promise<PreviewStatus> {
    const status = this.statuses.get(name);
    if (!status) throw new PreviewError('NOT_FOUND', `${name} does not exist.`);
    return status;
  }

  async start(spec: PreviewSpec): Promise<PreviewStatus> {
    this.attempts += 1;
    const attempt = { id: `attempt-${this.attempts}`, state: 'starting', services: { web: { type: 'command', state: 'starting' } } };
    const status = { name: spec.name, candidate: attempt, latest: attempt } as unknown as PreviewStatus;
    this.statuses.set(spec.name, status);
    this.started.push(spec.name);
    return status;
  }

  async wait(name: string, attemptId: string): Promise<{ state: 'ready' }> {
    const ready = { id: attemptId, state: 'ready', readyAt: new Date().toISOString(), services: { web: { type: 'command', state: 'ready' } } };
    this.statuses.set(name, { name, active: ready, latest: ready, url: this.url } as unknown as PreviewStatus);
    return { state: 'ready' };
  }

  async cancel(): Promise<void> {}

  async stop(name: string): Promise<PreviewStatus> {
    const status = await this.get(name);
    const stopped = { name, latest: (status as { latest?: unknown }).latest } as unknown as PreviewStatus;
    this.statuses.set(name, stopped);
    return stopped;
  }

  async remove(name: string): Promise<boolean> {
    return this.statuses.delete(name);
  }

  async logs() {
    return { text: '', cursor: 0, truncated: false };
  }
}

type Script = (request: BugReplayRunnerRequest) => Promise<BugReplayRunnerResult>;

/** The runner process, scripted: each run takes the next script, then the default one. */
class ScriptedRunner extends BugReplayRunner {
  readonly requests: BugReplayRunnerRequest[] = [];
  readonly scripts: Script[] = [];
  fallback: Script = async (request) => completed(request, '$40.00');

  constructor() {
    super(() => undefined);
  }

  override available(): boolean {
    return true;
  }

  override async run(request: BugReplayRunnerRequest): Promise<BugReplayRunnerResult> {
    this.requests.push(request);
    return (this.scripts.shift() ?? this.fallback)(request);
  }
}

async function completed(request: BugReplayRunnerRequest, total: string): Promise<BugReplayRunnerResult> {
  return { kind: 'completed', frames: runFrames(request.document, total), screenshots: [], browserVersion: '152.0.0.0' };
}

/** A run that works until it is told to stop, as a slow app keeps the runner busy. */
const untilStopped: Script = (request) =>
  new Promise((resolve) => request.signal.addEventListener('abort', () => resolve({ kind: 'canceled' }), { once: true }));

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

/** A checkout app in a Git worktree, a task for it, and Bug Replay over one profile. */
async function openWorkspace() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bug-replay-service-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'shop');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'server.js'), "require('http').createServer((q, s) => s.end('total $40.00')).listen(process.env.PORT);\n");
  await fs.writeFile(path.join(repo, 'preview.yaml'), RECIPE);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'Shop']);

  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runtime = new StandInPreviewRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

  const persistence = await openTestPersistence(path.join(root, 'profile'));
  const repository = await addTestRepository(persistence.tasks, repo);
  const task = await persistence.tasks.createTask({ title: 'Checkout total', prompt: 'Fix the coupon total.', repositoryId: repository.id });
  const snapshots = new ReviewSnapshotStore(path.join(root, 'snapshots'));
  const exportRoot = path.join(root, 'previewhost', 'sources', 'bug-replay');
  const scratchRoot = path.join(root, 'profile', 'bug-replay', 'runs');
  const worktree = { id: 'worktree-1', taskId: task.id, worktreePath: repo } as unknown as WorktreeRecord;
  // The app's one bus: a service opened again after a restart announces on it too.
  const events = new AppEventBus();

  const open = () => {
    const runner = new ScriptedRunner();
    const service = new BugReplayService({
      store: persistence.bugReplay,
      tasks: persistence.tasks,
      events,
      runtime: () => runtime as unknown as PreviewRuntime,
      authorization: new ReplayAuthorization(() => runtime as unknown as PreviewRuntime),
      snapshots,
      exportRoot,
      scratchRoot,
      storeId: 'store-1',
      runner,
      access: {
        context: async (taskId) => ({ task: (await persistence.tasks.getTask(taskId))!, worktree }),
        detail: async () => {
          throw new Error('Not used here.');
        },
        agentRunActive: async () => false,
        agentState: async () => ({ hasRun: true, turn: 'IDLE' as const }),
        handOff: async () => ({}),
        sendHeld: async () => undefined
      },
      toolchain: () => 'toolchain-1',
      available: () => ({ replay: true, record: true })
    });
    onTestFinished(async () => {
      service.beginShutdown();
      await service.drain(10_000);
    });
    return { service, runner };
  };

  const { service, runner } = open();
  await service.init();
  return { root, repo, runtime, persistence, store: persistence.bugReplay, task, snapshots, events, service, runner, open };
}

type Workspace = Awaited<ReturnType<typeof openWorkspace>>;

/** Saves the checkout bug with its check on the recorded code, as a recording would. */
async function savedBug(w: Workspace) {
  const { treeId } = await w.service.freezer.capture(w.repo, w.task.id, 'capture-test');
  const taskId = w.task.id;
  const version = versionRecord({ taskId, baselineTreeId: treeId, document: checkoutCase(), recipe: { name: 'preview.yaml', text: RECIPE, sha256: sha256(RECIPE) } });
  await w.store.write((tx) => {
    w.store.insertCapture(tx, captureRecord({ taskId, sourceTreeId: treeId, recipe: version.recipe }));
    w.store.insertCase(tx, bugCaseRecord({ taskId }));
    w.store.insertVersion(tx, version);
    w.store.insertDecision(tx, { id: 'decision-1', caseId: version.caseId, taskId, kind: 'APPROVED', versionId: version.id, createdAt: version.createdAt });
  });
  return { version, treeId };
}

async function runs(w: Workspace): Promise<StoredBugReplayRun[]> {
  return w.store.read((reader) => w.store.listRuns(reader, { taskId: w.task.id }).filter((run) => run.kind !== 'RECORD'));
}

async function gate(w: Workspace) {
  return w.store.read((reader) => w.service.gateIn(reader, w.task.id));
}

/** The person allows clean runs from the sheet a waiting run asks with. */
async function allowRuns(w: Workspace, service = w.service): Promise<void> {
  await until(async () => Boolean(await service.pendingLease(w.task.id)), 'a run to ask for permission');
  const lease = (await service.pendingLease(w.task.id))!;
  await service.allowRuns(w.task.id, lease.approvalDigest);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The agent's fix: the coupon takes $5 off once. */
const FIXED_SERVER = "require('http').createServer((q, s) => s.end('total $45.00')).listen(process.env.PORT);\n";
/**
 * The same fix computing the total, at another length than the recorded file, so a capture never
 * takes it for the recorded file by size and time alone.
 */
const COMPUTED_FIX = "require('http').createServer((q, s) => s.end('total $' + (50 - 5).toFixed(2))).listen(process.env.PORT);\n";

/** A run as the store holds it, for writing what an earlier process left behind. */
function storedRun(w: Workspace, fields: Partial<StoredBugReplayRun> & Pick<StoredBugReplayRun, 'kind' | 'state'>): StoredBugReplayRun {
  return {
    id: randomUUID(),
    taskId: w.task.id,
    counted: false,
    name: `br-${randomBytes(6).toString('hex')}`,
    observations: [],
    facts: [],
    fileIds: [],
    queuedAt: new Date().toISOString(),
    revision: 1,
    toolchain: 'toolchain-1',
    ...fields
  };
}

/** The bug as each BUG_ event stored for the task carried it, oldest first. */
async function publishedGates(w: Workspace) {
  const { events } = await w.persistence.tasks.getTaskDetail(w.task.id);
  return events
    .filter((event) => event.type.startsWith('BUG_'))
    .map((event) => ({ type: event.type, ...(event.payload as { gate: BugReplayGateProjection | null; runIds?: string[] }) }));
}

/** The refs that pin trees in the private snapshot store. */
async function snapshotRefs(w: Workspace): Promise<string> {
  const [store] = await fs.readdir(path.join(w.root, 'snapshots'));
  return git(w.root, ['--git-dir', path.join(w.root, 'snapshots', store), 'for-each-ref', '--format=%(refname)']);
}

describe('Clean runs of a recorded bug', () => {
  it('reproduces the bug with two clean runs after the person allows them, and tears every copy down', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);

    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await until(async () => (await runs(w)).every((run) => run.state === 'WAITING' && run.waitingFor === 'APPROVAL'), 'both runs to wait');
    expect(w.runtime.started).toHaveLength(0);

    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');

    expect((await runs(w)).map((run) => run.outcome)).toEqual(['REPRODUCED', 'REPRODUCED']);
    expect((await gate(w))?.baseline).toMatchObject({ matched: 2, total: 2 });
    await until(() => w.runtime.statuses.size === 0, 'the clean copies to be removed');
    expect(w.runtime.started).toHaveLength(2);
  }, 60_000);

  it('records a run that Task Monki closed under as interrupted, never as the person’s cancel, and runs it again after restart', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    w.runner.fallback = untilStopped;
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    await until(() => w.runner.requests.length === 2, 'both runs to replay');

    w.service.beginShutdown();
    await w.service.drain();

    const cut = await runs(w);
    expect(cut.map((run) => [run.outcome, run.failure?.reason])).toEqual([['INTERRUPTED', 'SHUTDOWN'], ['INTERRUPTED', 'SHUTDOWN']]);
    expect((await gate(w))?.state).toBe('REPRODUCING');

    // The next start owes the qualification two new runs, which wait for a new permission.
    const restarted = w.open();
    await restarted.service.init();
    await until(async () => (await runs(w)).filter((run) => run.state === 'WAITING').length === 2, 'the replacements to wait');
    expect((await gate(w))).toMatchObject({ state: 'REPRODUCING', activeRun: { waitingFor: 'APPROVAL' } });

    await allowRuns(w, restarted.service);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce after the restart');
  }, 60_000);

  it('cancels every run of the set, so no half of a pair keeps running', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    w.runner.fallback = untilStopped;
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    await until(() => w.runner.requests.length === 2, 'both runs to replay');

    const [first] = await runs(w);
    await w.service.cancelRun(w.task.id, first.id);

    await until(async () => (await runs(w)).every((run) => run.state === 'SETTLED'), 'both runs to stop');
    expect((await runs(w)).map((run) => run.outcome)).toEqual(['CANCELED', 'CANCELED']);
    expect(await gate(w)).toMatchObject({ state: 'REPRODUCTION_BLOCKED' });
    expect((await gate(w))?.activeRun).toBeUndefined();
    await until(() => w.runtime.statuses.size === 0, 'the clean copies to be removed');
  }, 60_000);

  it('runs a replacement for a run Previewhost did not answer for, in the same set, so the bug still reproduces', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    // Previewhost does not answer while the first run is admitted.
    w.runtime.listFailures = 1;

    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    const set = await runs(w);
    expect(set.map((run) => run.outcome).sort()).toEqual(['ENVIRONMENT_FAILED', 'REPRODUCED', 'REPRODUCED']);
    expect(new Set(set.map((run) => run.setId)).size).toBe(1);
  }, 60_000);

  it('settles a run that could not start only together with the replacement it makes owed', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    // One run of the qualification reproduced the bug; its partner waits to start.
    const setId = randomUUID();
    const started = Date.now();
    const reproduced = storedRun(w, {
      kind: 'BASELINE', state: 'SETTLED', caseId: version.caseId, versionId: version.id, setId, outcome: 'REPRODUCED', counted: true,
      inputTreeId: version.baselineTreeId, queuedAt: new Date(started).toISOString(), settledAt: new Date(started).toISOString()
    });
    const waiting = storedRun(w, { kind: 'BASELINE', state: 'QUEUED', caseId: version.caseId, versionId: version.id, setId, queuedAt: new Date(started + 1).toISOString() });
    await w.store.write((tx) => {
      w.store.insertRun(tx, reproduced);
      w.store.insertRun(tx, waiting);
    });
    w.service.schedule();
    await until(async () => (await runs(w)).find((run) => run.id === waiting.id)?.waitingFor === 'APPROVAL', 'the run to ask for permission');

    // Previewhost does not answer when the run is admitted, and the write that would queue its replacement fails.
    w.runtime.listFailures = Number.MAX_SAFE_INTEGER;
    let refused = 0;
    const insertRun = vi.spyOn(w.store, 'insertRun').mockImplementation(() => {
      refused += 1;
      throw new Error('disk I/O error');
    });
    await allowRuns(w);
    await until(() => refused > 0, 'the settling write to fail');

    // Nothing of that write stays: the run is not recorded as ended without its replacement.
    const kept = await runs(w);
    expect(kept.map((run) => run.id).sort()).toEqual([reproduced.id, waiting.id].sort());
    expect(kept.find((run) => run.id === waiting.id)).toMatchObject({ state: 'WAITING' });

    // Once writes succeed, the next refusal settles it and queues its replacement in one write.
    insertRun.mockRestore();
    w.service.schedule();
    await until(async () => (await runs(w)).find((run) => run.id === waiting.id)?.state === 'SETTLED', 'the run to settle');
    const set = await runs(w);
    expect(set.find((run) => run.id === waiting.id)).toMatchObject({ outcome: 'ENVIRONMENT_FAILED', failure: { reason: 'START_FAILED' } });
    expect(set.filter((run) => run.setId === setId)).toHaveLength(3);
  }, 60_000);

  it('never reopens a run once it settled', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await until(async () => (await runs(w)).every((run) => run.state === 'WAITING'), 'both runs to wait');
    const [stale] = await runs(w);

    await w.service.cancelRun(w.task.id, stale.id);
    const updated = await w.service.updateRun(stale, { state: 'PREPARING_SOURCE', phase: 'Copying source' }, 'BUG_REPLAY_RUN_UPDATED');

    expect(updated.state).toBe('SETTLED');
    expect((await runs(w)).find((run) => run.id === stale.id)).toMatchObject({ state: 'SETTLED', outcome: 'CANCELED' });
  }, 60_000);
});

describe('Whether a verdict is about the files the worktree holds', () => {
  /** A bug reproduced on the recorded code and verified fixed on the worktree's current files. */
  async function verifiedFix(w: Workspace, fix = FIXED_SERVER) {
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    await fs.writeFile(path.join(w.repo, 'server.js'), fix);
    w.runner.fallback = async (request) => completed(request, '$45.00');
    await w.service.verifyAgain(w.task.id);
    await until(async () => (await gate(w))?.state === 'FIX_VERIFIED', 'the fix to verify');
  }

  it('marks a verified fix out of date wherever it shows once a tracked file changes, and current again when the file goes back', async () => {
    const w = await openWorkspace();
    await verifiedFix(w, COMPUTED_FIX);
    const verified = await gate(w);
    // What the board, the Overview and Mark done read.
    const shown = async () => (await w.persistence.tasks.getTask(w.task.id))?.projection.bugReplay;

    await fs.appendFile(path.join(w.repo, 'server.js'), '// a later edit\n');

    const currency = await w.service.checkCurrency(w.task.id);
    expect(currency.state).toBe('STALE');
    expect(currency.treeId).toBeDefined();
    expect(currency.treeId).not.toBe(verified?.verdictTreeId);
    expect(await shown()).toMatchObject({ state: 'STALE', verdictTreeId: verified?.verdictTreeId });

    await fs.writeFile(path.join(w.repo, 'server.js'), COMPUTED_FIX);
    expect(await w.service.checkCurrency(w.task.id)).toEqual({ state: 'CURRENT', treeId: verified?.verdictTreeId });
    expect(await shown()).toMatchObject({ state: 'FIX_VERIFIED', verdictTreeId: verified?.verdictTreeId });
  }, 60_000);

  it('makes no verdict current while the files cannot be copied, and recovers once they can', async () => {
    const w = await openWorkspace();
    await verifiedFix(w);
    const verified = await gate(w);

    // The agent's turn leaves an untracked file too large to copy.
    await fs.writeFile(path.join(w.repo, 'recording.mov'), Buffer.alloc(6 * 1024 * 1024));
    await w.service.onAgentTurnCompleted(w.task.id, 'agent-run-1');

    expect(await gate(w)).toMatchObject({
      state: 'COULDNT_VERIFY',
      fact: "Couldn't verify: untracked files over 5 MB can't be copied: recording.mov. Ignore or remove them"
    });
    expect(await w.service.checkCurrency(w.task.id)).toEqual({ state: 'UNKNOWN' });

    // Removing the file is enough: the next comparison reads the worktree again.
    await fs.rm(path.join(w.repo, 'recording.mov'));
    expect(await w.service.checkCurrency(w.task.id)).toMatchObject({ state: 'CURRENT', treeId: verified?.verdictTreeId });
    expect(await gate(w)).toMatchObject({ state: 'FIX_VERIFIED', verdictTreeId: verified?.verdictTreeId });
  }, 60_000);

  it('keeps a bug verified over many turns bounded, releasing the trees of attempts it forgets', async () => {
    const w = await openWorkspace();
    await verifiedFix(w);
    const before = await runs(w);
    // Seventy older settled attempts, each pinning its own tree.
    const old: StoredBugReplayRun[] = [];
    for (let index = 0; index < 35; index += 1) {
      const setId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await w.service.freezer.pin(w.repo, w.task.id, `attempt-${setId}`, before[0].inputTreeId!);
      for (const offset of [0, 1]) {
        old.push({
          ...before[0],
          id: `00000000-0000-4000-9000-${String(index * 2 + offset).padStart(12, '0')}`,
          setId,
          name: `br-${String(index * 2 + offset).padStart(12, '0')}`,
          queuedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + (index * 2 + offset) * 60_000).toISOString(),
          revision: 1
        });
      }
    }
    await w.store.write((tx) => {
      for (const run of old) w.store.insertRun(tx, run);
    });

    // The next turn's verification prunes what it no longer needs.
    await fs.appendFile(path.join(w.repo, 'server.js'), '// tidy\n');
    await w.service.verifyAgain(w.task.id);
    await until(async () => (await gate(w))?.state === 'FIX_VERIFIED', 'the new code to verify');
    await w.service.drain();

    expect((await runs(w)).length).toBeLessThanOrEqual(60);
    const left = new Set((await runs(w)).map((run) => run.setId));
    expect(left.has(old[0].setId)).toBe(false);
    const refs = await snapshotRefs(w);
    expect(refs).not.toContain(`attempt-${old[0].setId}`);
    expect(refs).toContain(`attempt-${old.at(-1)!.setId}`);
  }, 90_000);
});

describe('Ending a set of runs that has not started', () => {
  it('hands a waiting verification over to a newer turn’s in one step, never showing the older one cut short', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    // The permission ended, so the verification of the agent's fix waits for the person.
    w.service.authorization.clear();
    await fs.writeFile(path.join(w.repo, 'server.js'), COMPUTED_FIX);
    await w.service.verifyAgain(w.task.id);
    const candidates = async () => (await runs(w)).filter((run) => run.kind === 'CANDIDATE');
    await until(async () => (await candidates()).filter((run) => run.waitingFor === 'APPROVAL').length === 2, 'the verification to wait');
    const older = await candidates();
    const before = (await publishedGates(w)).length;

    // The agent's next turn leaves other code while that verification still waits.
    await fs.appendFile(path.join(w.repo, 'server.js'), '// the next turn\n');
    await w.service.verifyAgain(w.task.id);
    const isOlder = (run: StoredBugReplayRun) => older.some((candidate) => candidate.id === run.id);
    await until(async () => (await candidates()).filter((run) => !isOlder(run) && run.waitingFor === 'APPROVAL').length === 2, 'the newer verification to wait');

    const newer = (await candidates()).filter((run) => !isOlder(run));
    const newerTree = newer[0].inputTreeId;
    expect(newerTree).toBeDefined();
    expect(newerTree).not.toBe(older[0].inputTreeId);
    expect((await candidates()).filter(isOlder).map((run) => [run.outcome, run.failure?.detail])).toEqual([
      ['SUPERSEDED', 'A newer turn replaced this check.'],
      ['SUPERSEDED', 'A newer turn replaced this check.']
    ]);
    // Every state published since is the newer verification's: the older pair was never shown
    // half ended, as a check that couldn't run, or as no verification at all.
    const since = (await publishedGates(w)).slice(before);
    expect(since.length).toBeGreaterThan(0);
    for (const published of since) expect(published.gate).toMatchObject({ state: 'VERIFYING', candidate: { treeId: newerTree } });
  }, 60_000);

  it('cancels a waiting pair in one step, never showing half of it', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await until(async () => (await runs(w)).every((run) => run.state === 'WAITING' && run.waitingFor === 'APPROVAL'), 'both runs to wait');
    const pair = await runs(w);
    const before = (await publishedGates(w)).length;

    await w.service.cancelRun(w.task.id, pair[0].id);

    expect((await runs(w)).map((run) => run.outcome)).toEqual(['CANCELED', 'CANCELED']);
    const since = (await publishedGates(w)).slice(before);
    expect(since).toHaveLength(1);
    expect(since[0]).toMatchObject({ type: 'BUG_REPLAY_RUN_SETTLED', runIds: expect.arrayContaining(pair.map((run) => run.id)), gate: { state: 'REPRODUCTION_BLOCKED' } });
    expect(since[0].gate?.activeRun).toBeUndefined();
  }, 60_000);
});

describe('Starting after a crash', () => {
  it('settles what a crash left mid-flight: the run cut short is owed again, queued work and replacements wait for the person, the recording and every copy go', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    // Task Monki closed cleanly; what follows is what a crash leaves behind instead.
    w.service.beginShutdown();
    await w.service.drain();
    const bug = { caseId: version.caseId, versionId: version.id };
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();
    // A qualification whose second run was executing, beside the run that reproduced the bug.
    const qualification = randomUUID();
    const reproduced = storedRun(w, { ...bug, kind: 'BASELINE', state: 'SETTLED', setId: qualification, outcome: 'REPRODUCED', counted: true, inputTreeId: version.baselineTreeId, queuedAt: at(0), settledAt: at(0) });
    const executing = storedRun(w, { ...bug, kind: 'BASELINE', state: 'EXECUTING', setId: qualification, phase: 'Running the steps', inputTreeId: version.baselineTreeId, queuedAt: at(1), startedAt: at(1) });
    // A verification of the agent's fix queued behind it.
    const attemptSet = randomUUID();
    await fs.writeFile(path.join(w.repo, 'server.js'), COMPUTED_FIX);
    const { treeId: fixTree } = await w.service.freezer.capture(w.repo, w.task.id, `attempt-${attemptSet}`);
    const queued = [2, 3].map((offset) => storedRun(w, { ...bug, kind: 'CANDIDATE', state: 'QUEUED', setId: attemptSet, inputTreeId: fixTree, queuedAt: at(offset) }));
    // A recording in progress, with the code it pinned.
    const recording = storedRun(w, { kind: 'RECORD', state: 'EXECUTING', queuedAt: at(4), startedAt: at(4) });
    await w.service.freezer.capture(w.repo, w.task.id, `record-${recording.id}`);
    await w.store.write((tx) => {
      for (const run of [reproduced, executing, ...queued, recording]) w.store.insertRun(tx, run);
    });
    // The executing run's clean copy is still in Previewhost.
    const attempt = { id: 'attempt-crashed', state: 'ready', services: { web: { type: 'command', state: 'ready' } } };
    w.runtime.statuses.set(executing.name, { name: executing.name, active: attempt, latest: attempt } as unknown as PreviewStatus);
    expect(await snapshotRefs(w)).toContain(`record-${recording.id}`);

    const restarted = w.open();
    await restarted.service.init();

    const after = await w.store.read((reader) => w.store.listRuns(reader, { taskId: w.task.id }));
    const stored = (id: string) => after.find((run) => run.id === id);
    expect(stored(executing.id)).toMatchObject({ state: 'SETTLED', outcome: 'INTERRUPTED', failure: { reason: 'SHUTDOWN' } });
    for (const run of queued) expect(stored(run.id)).toMatchObject({ state: 'WAITING', waitingFor: 'APPROVAL' });
    expect(stored(recording.id)).toMatchObject({ state: 'SETTLED', outcome: 'DISCARDED' });
    expect(await snapshotRefs(w)).not.toContain(`record-${recording.id}`);
    // The run the crash cut short is owed again, in its own set.
    const replacements = after.filter((run) => run.setId === qualification && run.id !== reproduced.id && run.id !== executing.id);
    expect(replacements).toEqual([expect.objectContaining({ kind: 'BASELINE' })]);
    await until(async () => (await runs(w)).find((run) => run.id === replacements[0].id)?.waitingFor === 'APPROVAL', 'the replacement to ask for permission');
    await until(() => !w.runtime.statuses.has(executing.name), 'the crash’s clean copy to be torn down');
    // Nothing starts until the person allows runs again.
    expect(w.runtime.started).toEqual([]);
  }, 60_000);
});

/** A recorded page as the in-app browser host would open it, with the bug already marked. */
function stubHost(): RecordingBrowserHost {
  const recorder = {
    title: 'Checkout',
    seal() {},
    unseal() {},
    noteStart() {},
    noteReload() {},
    markIncomplete() {},
    dispose() {},
    log: () => checkoutRecording(),
    pick: async (): Promise<RecorderPickOutcome> => ({ kind: 'picked', pick: TOTAL_PICK }),
    cancelPick: async () => undefined,
    noteShot: async () => undefined,
    showMarks: async () => undefined,
    timeline: () => ({ entries: [], steps: 0, omitted: 0 }),
    onlyStart: () => false,
    restartAt: () => false,
    screenshot: async () => Buffer.from('png')
  };
  return {
    open: async () => ({
      recorder: recorder as unknown as RecorderSession,
      chromium: '152.0.0.0',
      reload: async () => undefined,
      open: async () => undefined,
      close: async () => undefined,
      screenshot: async () => Buffer.from('png')
    })
  };
}

describe('Saving a recording', () => {
  it('keeps the name and notes the person wrote where a panel mounting again reads them, announcing only a change', async () => {
    const w = await openWorkspace();
    const recording = new BugRecordingService(w.service, () => stubHost(), async () => undefined);
    w.service.attachRecording(recording);
    await recording.start(w.task.id);
    await until(() => recording.sessionView(w.task.id)?.phase === 'NEEDS_APPROVAL', 'the recording to ask for permission');
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.approvalDigest);
    await until(() => recording.sessionView(w.task.id)?.phase === 'RECORDING', 'the page to open');
    const { sessionId } = recording.sessionView(w.task.id)!;
    await recording.mark(sessionId);
    await until(() => recording.sessionView(w.task.id)?.phase === 'MARKING' && !recording.sessionView(w.task.id)?.detail, 'the pick');

    // What the renderer hears: each update of the task's bug, as the app's bus carries it.
    let announced = 0;
    const stop = w.events.on((event) => {
      if (event.type === 'bugReplay.updated' && event.taskId === w.task.id) announced += 1;
    });
    onTestFinished(stop);
    const named = totalDraft({ title: 'Coupon is applied twice', statement: 'Seen at checkout.' });
    recording.preview(sessionId, named);
    expect(announced).toBe(1);
    expect(recording.sessionView(w.task.id)?.capture?.draft).toMatchObject({ title: 'Coupon is applied twice', statement: 'Seen at checkout.' });

    // The same draft again changes nothing and says nothing.
    recording.preview(sessionId, { ...named });
    expect(announced).toBe(1);
    await recording.cancel(sessionId);
  }, 60_000);

  it('keeps the capture when saving fails, leaves nothing behind, and saves with its first clean runs on retry', async () => {
    const w = await openWorkspace();
    const recording = new BugRecordingService(w.service, () => stubHost(), async () => undefined);
    w.service.attachRecording(recording);
    await recording.start(w.task.id);
    await until(() => recording.sessionView(w.task.id)?.phase === 'NEEDS_APPROVAL', 'the recording to ask for permission');
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.approvalDigest);
    await until(() => recording.sessionView(w.task.id)?.phase === 'RECORDING', 'the page to open');
    const { sessionId } = recording.sessionView(w.task.id)!;
    await recording.mark(sessionId);
    await until(() => recording.sessionView(w.task.id)?.phase === 'MARKING' && !recording.sessionView(w.task.id)?.detail, 'the pick');
    const revision = recording.sessionView(w.task.id)!.capture!.draftRevision;

    // The disk fills up after two of the evidence files were written.
    const published: BugReplayFileRecord[] = [];
    const publish = w.store.publishFile.bind(w.store);
    const spy = vi.spyOn(w.store, 'publishFile').mockImplementation(async (input) => {
      if (published.length === 2) throw new Error('No space left on device');
      const file = await publish(input);
      published.push(file);
      return file;
    });
    await expect(recording.save(sessionId, revision, totalDraft(), true)).rejects.toThrow('No space left on device');

    expect(recording.sessionView(w.task.id)).toMatchObject({ phase: 'MARKING' });
    for (const file of published) {
      await expect(fs.access(path.join(w.persistence.paths.managedFilesRoot, file.storageKey))).rejects.toThrow();
    }
    expect(await w.store.read((reader) => w.store.activeCase(reader, w.task.id))).toBeUndefined();

    spy.mockRestore();
    w.runner.fallback = untilStopped;
    await recording.save(sessionId, revision, totalDraft(), true);

    expect(recording.sessionView(w.task.id)).toBeUndefined();
    const saved = await runs(w);
    expect(saved.map((run) => run.kind)).toEqual(['BASELINE', 'BASELINE']);
    expect(new Set(saved.map((run) => run.setId)).size).toBe(1);
    expect(await gate(w)).toMatchObject({ state: 'REPRODUCING', title: 'Coupon total is wrong' });
    await until(() => !w.runtime.statuses.has(w.runtime.started[0]), 'the recording’s clean copy to be removed');
  }, 60_000);
});

describe('A recording that stops while the bug is marked', () => {
  it('keeps what was marked markable, and stops there once the person goes back to recording', async () => {
    let notify: RecordingViewInput['notify'] | undefined;
    const base = stubHost();
    const host: RecordingBrowserHost = {
      open: async (input) => {
        notify = input.notify;
        return base.open(input);
      }
    };
    const w = await openWorkspace();
    const recording = new BugRecordingService(w.service, () => host, async () => undefined);
    w.service.attachRecording(recording);
    await recording.start(w.task.id);
    await until(() => recording.sessionView(w.task.id)?.phase === 'NEEDS_APPROVAL', 'the recording to ask for permission');
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.approvalDigest);
    await until(() => recording.sessionView(w.task.id)?.phase === 'RECORDING', 'the page to open');
    const { sessionId } = recording.sessionView(w.task.id)!;
    await recording.mark(sessionId);
    await until(() => recording.sessionView(w.task.id)?.phase === 'MARKING' && !recording.sessionView(w.task.id)?.detail, 'the pick');

    notify!({ kind: 'interrupted', reason: 'The recording view closed (crashed)' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recording.sessionView(w.task.id)).toMatchObject({ phase: 'MARKING' });

    await recording.returnToRecording(sessionId);
    expect(recording.sessionView(w.task.id)).toMatchObject({ phase: 'INTERRUPTED', failure: { title: 'The recording view closed (crashed)' } });
    await recording.cancel(sessionId);
  }, 60_000);
});

describe('Starting a recording on another page', () => {
  it('moves the start only to a page that opened and that a replay can open', async () => {
    const restartAt = vi.fn(() => true);
    // The app sends /account to a sign-in page on another site: the navigation guard stops it.
    const open = vi.fn(async (target: string) => {
      if (target.startsWith('/account')) throw new Error("That page didn't open.");
    });
    const recorder = {
      title: 'Checkout',
      seal() {},
      unseal() {},
      noteStart() {},
      noteReload() {},
      markIncomplete() {},
      dispose() {},
      log: () => checkoutRecording(),
      pick: async (): Promise<RecorderPickOutcome> => ({ kind: 'stopped' }),
      cancelPick: async () => undefined,
      noteShot: async () => undefined,
      showMarks: async () => undefined,
      timeline: () => ({ entries: [], steps: 1, omitted: 0 }),
      onlyStart: () => true,
      restartAt,
      now: () => 4_200
    };
    const host: RecordingBrowserHost = {
      open: async () => ({
        recorder: recorder as unknown as RecorderSession,
        chromium: '152.0.0.0',
        reload: async () => undefined,
        open,
        close: async () => undefined,
        screenshot: async () => Buffer.from('png')
      })
    };
    const w = await openWorkspace();
    const recording = new BugRecordingService(w.service, () => host, async () => undefined);
    w.service.attachRecording(recording);
    await recording.start(w.task.id);
    await until(() => recording.sessionView(w.task.id)?.phase === 'NEEDS_APPROVAL', 'the recording to ask for permission');
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.approvalDigest);
    await until(() => recording.sessionView(w.task.id)?.phase === 'RECORDING', 'the page to open');
    const { sessionId } = recording.sessionView(w.task.id)!;

    // What a replay could not open is refused before anything moves.
    await expect(recording.openPage(sessionId, '/.//x')).rejects.toThrow('Write a path such as /checkout.');
    await expect(recording.openPage(sessionId, '/cart?=1')).rejects.toThrow('Write a path such as /checkout.');
    await expect(recording.openPage(sessionId, 'https://example.com/cart')).rejects.toThrow('Open a page of this app.');
    expect(open).not.toHaveBeenCalled();

    // A page that did not open leaves the start where it was.
    await expect(recording.openPage(sessionId, '/account')).rejects.toThrow("That page didn't open.");
    expect(restartAt).not.toHaveBeenCalled();

    // A page that opened becomes the start, timed from before its load.
    await recording.openPage(sessionId, '/checkout?step=2');
    expect(restartAt).toHaveBeenCalledWith('/checkout', [['step', '2']], 'primary', 4_200);
    // The page's bar shows where it is, query included.
    expect(recording.sessionView(w.task.id)?.routePath).toBe('/checkout?step=2');
    await recording.cancel(sessionId);
  }, 60_000);
});

describe('Replay approvals kept for a repository', () => {
  /** Starts recording the task and waits until it either asks for approval or opens the page. */
  async function recordUntilAsked(w: Workspace, service = w.service, taskId = w.task.id) {
    const recording = new BugRecordingService(service, () => stubHost(), async () => undefined);
    service.attachRecording(recording);
    await recording.start(taskId);
    await until(() => ['NEEDS_APPROVAL', 'RECORDING', 'FAILED'].includes(recording.sessionView(taskId)?.phase ?? ''), 'the recording to ask or open the page');
    return recording;
  }

  async function keepFrom(w: Workspace, recording: BugRecordingService) {
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.approvalDigest, true);
    await until(() => recording.sessionView(w.task.id)?.phase === 'RECORDING', 'the page to open');
    await recording.cancel(recording.sessionView(w.task.id)!.sessionId);
  }

  it('records and replays without asking after a restart, and asks again for a changed recipe or once revoked', async () => {
    const w = await openWorkspace();
    const first = await recordUntilAsked(w);
    expect(first.sessionView(w.task.id)?.phase).toBe('NEEDS_APPROVAL');
    await keepFrom(w, first);

    // Task Monki quits, and the next start finds the approval kept for the repository.
    w.service.beginShutdown();
    await w.service.drain();
    const restarted = w.open();
    await restarted.service.init();
    const second = await recordUntilAsked(w, restarted.service);
    expect(second.sessionView(w.task.id)?.phase).toBe('RECORDING');
    await second.cancel(second.sessionView(w.task.id)!.sessionId);

    // The bug's replays run the same recipe, so they start without asking too.
    const { version } = await savedBug(w);
    await restarted.service.queueQualification(w.task.id, version.caseId, version.id);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce without asking');

    // A recipe that runs something else asks again.
    await fs.writeFile(path.join(w.repo, 'preview.yaml'), RECIPE.replace('[node, server.js]', '[node, --trace-warnings, server.js]'));
    const changed = await recordUntilAsked(w, restarted.service);
    expect(changed.sessionView(w.task.id)?.phase).toBe('NEEDS_APPROVAL');
    await changed.cancel(changed.sessionView(w.task.id)!.sessionId);
    await fs.writeFile(path.join(w.repo, 'preview.yaml'), RECIPE);

    // Revoked, it ends at once, not at the next restart: the kept recipe's replays wait for the person.
    const [kept] = await restarted.service.keptApprovals();
    expect(kept).toMatchObject({ repositoryId: w.task.repositoryId, repositoryName: 'shop', commands: [{ service: 'web', command: 'node server.js', directory: '.' }] });
    await restarted.service.revokeApproval(kept.id);
    expect(await restarted.service.keptApprovals()).toEqual([]);
    await restarted.service.runAgain(w.task.id);
    await until(async () => (await gate(w))?.activeRun?.waitingFor === 'APPROVAL', 'the replays to ask again');
  }, 90_000);

  it('keeps only what the task asks to approve, and only for the task’s own repository', async () => {
    const w = await openWorkspace();
    // A digest the task is not asking about keeps nothing.
    await expect(w.service.allowRuns(w.task.id, 'f'.repeat(64), true)).rejects.toThrow('What replays run has changed. Read it again.');
    expect(await w.service.keptApprovals()).toEqual([]);
    await keepFrom(w, await recordUntilAsked(w));

    // Another repository that runs the very same recipe is asked for its own approval.
    const fork = await addTestRepository(w.persistence.tasks, path.join(w.root, 'fork'));
    const forkTask = await w.persistence.tasks.createTask({ title: 'Checkout total', prompt: 'Fix it in the fork.', repositoryId: fork.id });
    const forked = await recordUntilAsked(w, w.service, forkTask.id);
    expect(forked.sessionView(forkTask.id)?.phase).toBe('NEEDS_APPROVAL');
    await forked.cancel(forked.sessionView(forkTask.id)!.sessionId);
  }, 60_000);
});

describe('Changing a saved bug’s expectations', () => {
  /** Replays the recorded code as the recording saw it and the worktree's code as the fix left it. */
  function replayByKind(w: Workspace, fix: (request: BugReplayRunnerRequest) => Promise<BugReplayRunnerResult>): void {
    w.runner.fallback = async (request) => {
      const run = await w.store.read((reader) => w.store.getRun(reader, request.runId));
      return run?.kind === 'CANDIDATE' ? fix(request) : completed(request, '$40.00');
    };
  }

  it('saves the next version, stops replays of the old one, and verifies the fix only after the bug reproduces again', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    const taskId = w.task.id;
    const total = version.document.assertions[0].id;
    replayByKind(w, untilStopped);
    await w.service.queueQualification(taskId, version.caseId, version.id);
    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    // The agent's fix shows $45.00 and is being verified when the person changes the expectation.
    await fs.writeFile(path.join(w.repo, 'server.js'), "require('http').createServer((q, s) => s.end('total $45.00')).listen(process.env.PORT);\n");
    await w.service.verifyAgain(taskId);
    await until(async () => (await runs(w)).filter((run) => run.kind === 'CANDIDATE' && run.state === 'EXECUTING').length === 2, 'the fix to replay');

    // An expectation the recording already shows describes no bug, and changes nothing.
    await expect(w.service.reviseExpectations(taskId, { versionId: version.id, expectations: [{ kind: 'element', id: total, template: 'equals', expected: '$40.00', alsoAfterReload: false }] }))
      .rejects.toThrow('Cart total matches the recording.');
    expect(await w.store.read((reader) => w.store.listVersions(reader, version.caseId))).toHaveLength(1);

    replayByKind(w, (request) => completed(request, '$45.00'));
    await w.service.reviseExpectations(taskId, { versionId: version.id, expectations: [{ kind: 'element', id: total, template: 'equals', expected: '$46.00', alsoAfterReload: false }] });

    const versions = await w.store.read((reader) => w.store.listVersions(reader, version.caseId));
    expect(versions.map((item) => [item.version, item.revisionKind, item.reason])).toEqual([
      [1, 'INITIAL', undefined],
      [2, 'EXPECTATION_CHANGED', 'Cart total should read "$46.00"']
    ]);
    const changed = versions[1];
    expect(changed.document.failureSignature).toEqual([{ assertionId: total, mode: 'CAPTURED', captured: { kind: 'text', token: '$40.00' } }]);
    // Replays of the old expectations stop: their result would be about other expectations.
    await until(async () => (await runs(w)).filter((run) => run.versionId === version.id).every((run) => run.state === 'SETTLED'), 'the old replays to stop');
    const stopped = (await runs(w)).filter((run) => run.versionId === version.id && run.kind === 'CANDIDATE');
    expect(stopped.map((run) => [run.outcome, run.failure?.detail])).toEqual([['SUPERSEDED', 'The expectations changed'], ['SUPERSEDED', 'The expectations changed']]);
    // A save against the version the editor showed before is refused.
    await expect(w.service.reviseExpectations(taskId, { versionId: version.id, expectations: [{ kind: 'keep', id: total }] })).rejects.toThrow('The expectations changed after they were shown');

    await until(async () => (await gate(w))?.state === 'STILL_FAILING', 'the fix to be verified against the changed expectation');
    const final = await runs(w);
    const qualification = final.filter((run) => run.versionId === changed.id && run.kind === 'BASELINE');
    const candidates = final.filter((run) => run.versionId === changed.id && run.kind === 'CANDIDATE');
    expect(qualification.map((run) => run.outcome)).toEqual(['REPRODUCED', 'REPRODUCED']);
    // The fix was replayed only once the changed expectation reproduced on the recorded code.
    const reproducedAt = qualification.map((run) => run.settledAt!).sort().at(-1)!;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate.startedAt! >= reproducedAt).toBe(true);
    expect(await gate(w)).toMatchObject({ versionId: changed.id, version: 2, state: 'STILL_FAILING' });

    // The agent's next brief states the changed expectation, never the replaced one.
    const brief = await w.service.brief(taskId, { caseId: version.caseId, captureId: CAPTURE_ID, versionId: version.id });
    expect(brief).toContain('Cart total should read "$46.00"');
    expect(brief).not.toContain('should read "$45.00"');
  }, 90_000);

  it('shows the replaced version’s results as earlier context, never as the current verdict', async () => {
    const w = await openWorkspace();
    const { version } = await savedBug(w);
    const taskId = w.task.id;
    const total = version.document.assertions[0].id;
    replayByKind(w, (request) => completed(request, '$45.00'));
    await w.service.queueQualification(taskId, version.caseId, version.id);
    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    await fs.writeFile(path.join(w.repo, 'server.js'), "require('http').createServer((q, s) => s.end('total $45.00')).listen(process.env.PORT);\n");
    await w.service.verifyAgain(taskId);
    await until(async () => (await gate(w))?.state === 'FIX_VERIFIED', 'the fix to verify');

    // The changed expectation's replays wait for the person, so the snapshot holds both versions.
    w.service.authorization.clear();
    await w.service.reviseExpectations(taskId, { versionId: version.id, expectations: [{ kind: 'element', id: total, template: 'equals', expected: '$46.00', alsoAfterReload: false }] });
    await until(async () => (await gate(w))?.activeRun?.waitingFor === 'APPROVAL', 'the changed version to wait for approval');
    const snapshot = await w.service.snapshot(taskId);
    const view = snapshot.activeCase!;

    expect(view.gate).toMatchObject({ state: 'VERIFYING', fact: 'Rechecking the bug first', version: 2 });
    expect(view.gate.verdictTreeId).toBeUndefined();
    // The table's After column and picture are the current version's, and it has none yet.
    expect(view.version?.checks).toEqual([expect.objectContaining({ statement: 'Cart total should read "$46.00"', before: { held: false, value: '"$40.00"' } })]);
    expect(view.version?.checks[0].after).toBeUndefined();
    expect(view.shots.after).toBeUndefined();
    // The fix verified against the old expectation is listed, tied to the expectation it checked.
    const passed = snapshot.runs.filter((run) => run.outcome === 'PASSED');
    expect(passed).toHaveLength(2);
    expect(passed.every((run) => run.versionId === version.id)).toBe(true);
    expect(view.earlierVersions).toEqual([{ id: version.id, version: 1, checks: [{ id: total, statement: 'Cart total should read "$45.00"' }] }]);
    expect(view.actions).toContain('edit-expectations');
  }, 90_000);
});
