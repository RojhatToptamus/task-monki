import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PreviewError } from 'previewhost';
import { expect, it, vi } from 'vitest';
import { openScriptedTaskManagerPersistence } from '../../testSupport/taskMonkiScenario';
import { AppEventBus } from '../runner/AppEventBus';
import { ApplicationPreviewService } from '../preview/ApplicationPreviewService';
import { DesignPreviewService } from './DesignPreviewService';

const execute = promisify(execFile);

it('keeps pending Design candidates, publishes exact commits only after settlement, and recovers stopped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monki-design-preview-'));
  const fixture = await openScriptedTaskManagerPersistence(path.join(root, 'profile'));
  let allowSource!: () => void;
  const sourceApproval = new Promise<void>(resolve => { allowSource = resolve; });
  const applications: ApplicationPreviewService = new ApplicationPreviewService({ root: path.join(root, 'runtime'), authorizeDesign: async spec => {
    await sourceApproval;
    return service.authorizes(spec);
  } });
  const service = new DesignPreviewService(fixture.store, new AppEventBus(), () => applications.owner(), path.join(root, 'sources'));
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  const git = async (...args: string[]) => (await execute('git', ['-C', repositoryPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await fs.writeFile(path.join(repositoryPath, 'index.html'), '<h1>First committed version</h1>');
  await git('add', 'index.html');
  await git('-c', 'user.name=Local test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const firstCommit = await git('rev-parse', 'HEAD');
  const bundle = await fixture.store.createDesignBundle({
    request: { brief: 'Build a local page.', creationToken: randomUUID(), runtimeId: 'scripted' },
    agentSettings: { runtimeId: 'scripted', model: 'scenario-model', sandbox: 'WORKSPACE_WRITE', networkAccess: false, approvalPolicy: 'never', approvalsReviewer: 'user' },
    repository: { id: randomUUID(), name: 'Local Design', path: repositoryPath, headSha: firstCommit, branch: 'main', checkedAt: new Date().toISOString() }
  });
  const { iteration, worktree } = await fixture.store.createIterationAndWorktree({ task: bundle.task, branchName: 'main', worktreePath: repositoryPath, baseSha: firstCommit });
  const context = { task: bundle.task, iteration, worktree };
  const session = await fixture.createSession(context);
  let turn = bundle.turn;
  async function candidate(commitSha: string) {
    const run = await fixture.createRun({ task: bundle.task, session, mode: 'DESIGN', generationKey: turn.id, prompt: turn.id });
    await fixture.store.linkDesignTurnRun({ designId: bundle.task.id, turnId: turn.id, runId: run.id });
    await fixture.transitionRun(run.id, { status: 'STARTING' });
    await fixture.transitionRun(run.id, { status: 'COMPLETED', endedAt: new Date().toISOString() });
    const evidence = await fixture.store.recordGitSnapshot({ taskId: bundle.task.id, iterationId: iteration.id, worktreeId: worktree.id,
      worktreePath: repositoryPath, repoRoot: repositoryPath, gitCommonDir: path.join(repositoryPath, '.git'), headSha: commitSha,
      branch: 'main', baseSha: firstCommit, aheadCount: 0, behindCount: 0, stagedCount: 0, unstagedCount: 0,
      untrackedCount: 0, conflictedCount: 0, commitsAheadOfBase: 0, committedDiffFileCount: 0, workingDiffFileCount: 0,
      diffStat: '', dirtyFingerprint: 'clean', status: 'CLEAN' }, '');
    await fixture.transitionRun(run.id, { status: 'COMPLETED', afterGitSnapshotId: evidence.id });
    await fixture.store.updateDesignTurnCheckpoint({ designId: bundle.task.id, turnId: turn.id, checkpoint: { boundary: 'POST_RUN_EVIDENCE_RECORDED', gitSnapshotId: evidence.id } });
    const prepared = await service.prepareManagedDesignExactCommit({ context, commitSha });
    // A late provider cancellation must not abort publication after the run completed.
    await service.abortManagedDesignCandidateStartups(run.id);
    const generation = await service.executeManagedDesignCandidate(prepared, { designId: bundle.task.id, async onCandidateReady(item) {
      await fixture.store.updateDesignTurnCheckpoint({ designId: bundle.task.id, turnId: turn.id,
        checkpoint: { boundary: 'PREVIEW_CANDIDATE_READY', previewGenerationId: item.id, commitSha } });
    } });
    return { generation, settlement: { kind: 'AGENT_TURN' as const, turnId: turn.id, runId: run.id } };
  }
  let commits = 0;
  let rollbacks = 0;
  const fence = { async begin() { return { async commit() { commits++; }, async rollback() { rollbacks++; } }; } };
  try {
    await applications.init();
    const wait = applications.owner().wait.bind(applications.owner());
    let observationTimedOut = false;
    // A bounded observation can expire while authorization is still pending.
    // Use the real runtime deadline without delaying this scenario for 30 seconds.
    vi.spyOn(applications.owner(), 'wait').mockImplementationOnce(async (name, id, options) => {
      try { return await wait(name, id, { ...options, timeoutMs: 1 }); }
      catch (error) {
        observationTimedOut = error instanceof PreviewError && error.code === 'TIMEOUT';
        throw error;
      } finally { allowSource(); }
    });
    await fs.writeFile(path.join(repositoryPath, 'index.html'), '<h1>Uncommitted content must not be served</h1>');
    const first = await candidate(firstCommit);
    expect(observationTimedOut).toBe(true);
    const lease = await service.openManagedDesignBrowserLease(first.generation.id);
    expect(await proxyRequest(lease.proxyUrl, `${lease.origin}/`)).toEqual({ status: 200, text: '<h1>First committed version</h1>' });
    expect((await proxyRequest(lease.proxyUrl, 'http://127.0.0.1:1/')).status).toBe(403);
    expect((await proxyRequest(lease.proxyUrl, 'https://example.invalid/')).status).toBe(403);
    const firstReady = await service.cutoverManagedDesignCandidate({ generationId: first.generation.id, designId: bundle.task.id, settlement: first.settlement, fence });
    const stableUrl = firstReady.routes[0]!.url;
    expect((await fixture.store.getDesignDetail(bundle.task.id)).revisions).toHaveLength(1);

    await fs.writeFile(path.join(repositoryPath, 'index.html'), '<h1>Second committed version</h1>');
    await git('add', 'index.html');
    await git('-c', 'user.name=Local test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'next fixture');
    const secondCommit = await git('rev-parse', 'HEAD');
    turn = await fixture.store.createInlineDesignTurn({ designId: bundle.task.id, clientMessageId: randomUUID(), message: 'Update the page.', referenceIds: [] });
    const second = await candidate(secondCommit);
    await service.publishManagedDesignCandidateCanvas(second.generation.id);
    const candidateUrl = await service.resolveExternalUrl({ taskId: bundle.task.id, generationId: second.generation.id, routeId: 'app' });
    expect(await (await fetch(candidateUrl)).text()).toContain('Second committed');
    expect(await (await fetch(stableUrl)).text()).toContain('First committed');
    await expect(service.cutoverManagedDesignCandidate({ generationId: second.generation.id, designId: bundle.task.id,
      settlement: { ...second.settlement, runId: randomUUID() }, fence })).rejects.toThrow('settlement ownership');
    expect(await (await fetch(stableUrl)).text()).toContain('First committed');
    expect((await fixture.store.getDesignDetail(bundle.task.id)).revisions).toHaveLength(1);
    expect(rollbacks).toBe(1);
    const secondReady = await service.cutoverManagedDesignCandidate({ generationId: second.generation.id, designId: bundle.task.id, settlement: second.settlement, fence });
    expect(secondReady.routes[0]!.url).toBe(stableUrl);
    expect(await (await fetch(stableUrl)).text()).toContain('Second committed');
    expect((await fixture.store.getDesignDetail(bundle.task.id)).revisions).toHaveLength(2);
    expect(await fixture.store.getPreviewGeneration(first.generation.id)).toMatchObject({ state: 'STOPPED', routingState: 'RETIRED' });
    await expect(fs.stat(first.generation.workspacePath)).rejects.toThrow();
    expect(commits).toBe(2);
    expect(applications.owner().sourceRoots()).toHaveLength(2); // profile root and the serving capture only
    await service.shutdown();
    await applications.close();
    await applications.init();
    await service.init();
    expect(await fixture.store.getPreviewGeneration(second.generation.id)).toMatchObject({ state: 'STOPPED' });
    await expect(fetch(stableUrl)).rejects.toThrow();
  } finally {
    await service.shutdown();
    await applications.close();
    await fixture.persistence.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

function proxyRequest(proxy: string, target: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(proxy, { path: target }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, text }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
