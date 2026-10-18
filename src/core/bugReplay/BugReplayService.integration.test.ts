import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PreviewError, type PreviewRuntime, type PreviewSpec, type PreviewStatus } from 'previewhost';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import type { BugRecordingPick } from '../../shared/bugRecording';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { TOTAL_PICK, bugCaseRecord, captureRecord, checkoutCase, checkoutRecording, runFrames, totalDraft, versionRecord } from '../../testSupport/bugReplay/bugReplayFixtures';
import { ReviewSnapshotStore } from '../git/ReviewSnapshotStore';
import { AppEventBus } from '../runner/AppEventBus';
import type { BugReplayFileRecord, StoredBugReplayRun } from './BugReplayRecords';
import { BugRecordingService, type RecordingBrowserHost } from './BugRecordingService';
import { BugReplayRunner, type BugReplayRunnerRequest, type BugReplayRunnerResult } from './BugReplayRunner';
import { BugReplayService } from './BugReplayService';
import { ReplayAuthorization } from './ReplayAuthorization';
import type { RecorderSession } from './recorder/RecorderSession';

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

  const open = () => {
    const runner = new ScriptedRunner();
    const service = new BugReplayService({
      store: persistence.bugReplay,
      tasks: persistence.tasks,
      events: new AppEventBus(),
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
  return { root, repo, runtime, persistence, store: persistence.bugReplay, task, snapshots, service, runner, open };
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
  await service.allowRuns(w.task.id, lease.templateDigest);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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

  it('queues the replacement for a run that could not start in the same step that settles it', async () => {
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
  async function verifiedFix(w: Workspace) {
    const { version } = await savedBug(w);
    await w.service.queueQualification(w.task.id, version.caseId, version.id);
    await allowRuns(w);
    await until(async () => (await gate(w))?.state === 'REPRODUCED', 'the bug to reproduce');
    await fs.writeFile(path.join(w.repo, 'server.js'), "require('http').createServer((q, s) => s.end('total $45.00')).listen(process.env.PORT);\n");
    w.runner.fallback = async (request) => completed(request, '$45.00');
    await w.service.verifyAgain(w.task.id);
    await until(async () => (await gate(w))?.state === 'FIX_VERIFIED', 'the fix to verify');
  }

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
    const refs = git(w.root, ['--git-dir', (await fs.readdir(path.join(w.root, 'snapshots'))).map((name) => path.join(w.root, 'snapshots', name))[0], 'for-each-ref', '--format=%(refname)']);
    expect(refs).not.toContain(`attempt-${old[0].setId}`);
    expect(refs).toContain(`attempt-${old.at(-1)!.setId}`);
  }, 90_000);
});

describe('Saving a recording', () => {
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
      pick: async (): Promise<BugRecordingPick> => TOTAL_PICK,
      cancelPick: async () => undefined,
      screenshot: async () => Buffer.from('png')
    };
    return {
      open: async () => ({
        recorder: recorder as unknown as RecorderSession,
        chromium: '152.0.0.0',
        reload: async () => undefined,
        close: async () => undefined,
        screenshot: async () => Buffer.from('png')
      })
    };
  }

  it('keeps the capture when saving fails, leaves nothing behind, and saves with its first clean runs on retry', async () => {
    const w = await openWorkspace();
    const recording = new BugRecordingService(w.service, () => stubHost(), async () => undefined);
    w.service.attachRecording(recording);
    await recording.start(w.task.id);
    await until(() => recording.sessionView(w.task.id)?.phase === 'NEEDS_APPROVAL', 'the recording to ask for permission');
    await w.service.allowRuns(w.task.id, recording.sessionView(w.task.id)!.lease!.templateDigest);
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
