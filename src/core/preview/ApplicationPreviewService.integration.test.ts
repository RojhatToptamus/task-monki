import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach,expect,it } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { ApplicationPreviewService } from './ApplicationPreviewService';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-application-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const service = new ApplicationPreviewService({ root: path.join(root, 'profile') });
  await service.init();
  cleanup.push(() => service.close());
  async function worktree(content: string): Promise<WorktreeRecord> {
    const id = randomUUID();
    const source = path.join(root, `worktree ${id}`);
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'content.txt'), content);
    await fs.writeFile(path.join(source, 'server.cjs'), `const fs=require('fs');
      console.log('started',process.env.TOKEN??'no token');
      require('http').createServer((q,r)=>r.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT),'127.0.0.1');`);
    await fs.writeFile(path.join(source, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'] }));
    return { id, taskId: randomUUID(), iterationId: randomUUID(), repositoryId: randomUUID(), ownership: 'MANAGED', worktreePath: source, branchName: 'test', baseSha: 'a'.repeat(40), status: 'PRESENT', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
  async function approveAndWait(tree: WorktreeRecord, id: string) {
    await expect.poll(async () => (await service.read(tree)).approval?.attemptId).toBe(id);
    await service.approve(tree, id);
    const result = await service.owner().wait(service.name(tree), id);
    expect(result.state, JSON.stringify(result)).toBe('ready');
    return result;
  }
  return { service, worktree, approveAndWait };
}

it('runs live independent worktrees only after exact approval and preserves the serving app on failed or canceled replacement', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const a = await worktree('first');
  const b = await worktree('neighbor');
  const pendingA = await service.start(a);
  expect(pendingA.projectDirectory).toBe(await fs.realpath(a.worktreePath));
  const pendingB = await service.start(b);
  expect(pendingA.status?.active).toBeUndefined();
  await expect(service.approve(b, pendingA.status!.candidate!.id)).rejects.toThrow('no longer current');
  const readyA = await approveAndWait(a, pendingA.status!.candidate!.id);
  const readyB = await approveAndWait(b, pendingB.status!.candidate!.id);
  await fs.writeFile(path.join(a.worktreePath, 'content.txt'), 'unstaged change');
  expect(await (await fetch(readyA.url!)).text()).toBe('unstaged change');
  const canceled = await service.start(a);
  await service.owner().cancel(service.name(a), canceled.status!.candidate!.id);
  expect(await (await fetch(readyA.url!)).text()).toBe('unstaged change');
  await fs.writeFile(path.join(a.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, '-e', 'process.exit(2)'] }));
  const failure = await service.start(a);
  const failedId = failure.status!.candidate!.id;
  await expect.poll(async () => (await service.read(a)).approval?.attemptId).toBe(failedId);
  await service.approve(a, failedId);
  expect((await service.owner().wait(service.name(a), failedId)).state).toBe('failed');
  expect((await service.read(a)).status?.active?.id).toBe(readyA.id);
  await service.retireWorktree(a);
  await expect(fetch(readyA.url!)).rejects.toThrow();
  expect(await (await fetch(readyB.url!)).text()).toBe('neighbor');
}, 30_000);

it('keeps synthetic values out of observations and logs and requires each worktree binding approval', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const password = 'SYNTHETIC_test_password';
  const secret = 'SYNTHETIC_test_secret_12345';
  await service.secrets.unlock({ password, confirmation: password, create: true });
  await service.secrets.create({ id: 'test/dev/token', value: secret });
  await expect(service.secrets.create({ id: 'test/dev/token', value: 'duplicate' })).rejects.toThrow(/already exists|changed/);
  for (const tree of [await worktree('one'), await worktree('two')]) {
    await fs.writeFile(path.join(tree.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], env: { TOKEN: { secret: 'test/dev/token' } } }));
    const pending = await service.start(tree);
    const id = pending.status!.candidate!.id;
    await expect.poll(async () => (await service.read(tree)).approval?.attemptId).toBe(id);
    expect(JSON.stringify(await service.read(tree))).not.toContain(secret);
    expect((await service.owner().logs(service.name(tree), id)).text).not.toContain('started');
    await approveAndWait(tree, id);
    const logs = await service.owner().logs(service.name(tree), id);
    expect(logs.text).not.toContain(secret);
    expect(JSON.stringify(await service.secrets.list())).not.toContain(secret);
  }
  const replacement = 'SYNTHETIC_replacement_secret_with_at_least_32_characters';
  expect(await service.secrets.update({ id: 'test/dev/token', value: replacement })).toBe(true);
  const replaced = await worktree('replacement');
  await fs.writeFile(path.join(replaced.worktreePath, 'preview.yaml'), JSON.stringify({
    name: 'app', type: 'environment', primary: 'web', services: {
      check: { type: 'job', cwd: '.', command: [process.execPath, '-e',
        `if (process.env.TOKEN !== ${JSON.stringify(replacement)}) process.exit(1)`], env: { TOKEN: { secret: 'test/dev/token' } } },
      web: { type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], dependsOn: ['check'] }
    }
  }));
  const updated = await service.start(replaced);
  await approveAndWait(replaced, updated.status!.candidate!.id);
  await service.secrets.remove({ id: 'test/dev/token' });
  await service.secrets.lock();
}, 30_000);

it('keeps serving during a file conflict and starts the explicitly selected file after cleanup', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('retained application');
  const pending = await service.start(tree);
  const ready = await approveAndWait(tree, pending.status!.candidate!.id);
  await fs.copyFile(path.join(tree.worktreePath, 'preview.yaml'), path.join(tree.worktreePath, 'preview.yml'));
  await expect(service.read(tree)).resolves.toMatchObject({
    hasConfigurationFile: true,
    status: { active: { id: ready.id, state: 'ready' } }
  });
  await expect(service.start(tree)).rejects.toThrow('Both preview.yaml and preview.yml exist');
  expect(await (await fetch(ready.url!)).text()).toBe('retained application');
  await service.owner().stop(service.name(tree));
  await expect(fetch(ready.url!)).rejects.toThrow();
  const conflict = await service.readFile(tree);
  await service.chooseFile(tree, 'preview.yaml', conflict.files!);
  const restarted = await service.start(tree);
  const restored = await approveAndWait(tree, restarted.status!.candidate!.id);
  expect(await (await fetch(restored.url!)).text()).toBe('retained application');
  await service.retireWorktree(tree);
  await expect(fetch(restored.url!)).rejects.toThrow();
  expect((await service.read(tree)).status).toBeUndefined();
}, 30_000);

it('blocks worktree deletion while another application consumes its source', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const source = await worktree('shared backend');
  const consumer = await worktree('consumer');
  await service.owner().allowSources([source.worktreePath], new AbortController().signal);
  await fs.writeFile(path.join(consumer.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: source.worktreePath, command: [process.execPath, 'server.cjs'] }));
  const pending = await service.start(consumer);
  const ready = await approveAndWait(consumer, pending.status!.candidate!.id);
  await expect(service.retireWorktree(source)).rejects.toThrow(/source.*in use|uses this source/i);
  expect(await (await fetch(ready.url!)).text()).toBe('shared backend');
  await service.owner().stop(service.name(consumer));
  await service.retireWorktree(source);
  expect(service.owner().sourceRoots()).not.toContain(await fs.realpath(source.worktreePath));
});

it('saves a detected first-time configuration without starting or overwriting files', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('first setup');
  await fs.unlink(path.join(tree.worktreePath, 'preview.yaml'));
  await fs.writeFile(path.join(tree.worktreePath, 'index.html'), 'first setup');
  expect((await service.inspectSetup(tree)).recommendations).toMatchObject([{ type: 'static', directory: '.' }]);
  const text = 'name: application\ntype: static\ndirectory: .\n';
  const saved = await service.saveFile(tree, undefined, text);
  expect(saved.hasConfigurationFile).toBe(true);
  expect(saved.status).toBeUndefined();
  expect(saved.approval).toBeUndefined();
  const original = await fs.readFile(path.join(tree.worktreePath, 'preview.yaml'), 'utf8');
  expect(original).not.toContain(service.name(tree));
  await expect(service.saveFile(tree, undefined, text)).rejects.toThrow(/already exists|changed/);
  expect(await fs.readFile(path.join(tree.worktreePath, 'preview.yaml'), 'utf8')).toBe(original);
  const pending = await service.start(tree);
  const ready = await approveAndWait(tree, pending.status!.candidate!.id);
  expect(await (await fetch(ready.url!)).text()).toBe('first setup');
});

it('blocks approval for the exact missing secret and saving its value does not approve execution', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('secret recovery');
  await fs.writeFile(path.join(tree.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], env: { TOKEN: { secret: 'project/dev/exact-token' } } }));
  const pending = await service.start(tree);
  const id = pending.status!.candidate!.id;
  await expect.poll(async () => (await service.read(tree)).approval?.attemptId).toBe(id);
  await expect(service.approve(tree, id)).rejects.toThrow('project/dev/exact-token');
  const password = 'SYNTHETIC_new_storage';
  await service.secrets.unlock({ password, confirmation: password, create: true });
  expect((await service.read(tree)).approval?.secrets).toEqual([{ id: 'project/dev/exact-token', selected: false, bindings: [{ key: 'TOKEN' }], availability: 'missing' }]);
  await expect(service.approve(tree, id)).rejects.toThrow('missing');
  await service.secrets.create({ id: 'project/dev/exact-token', value: 'SYNTHETIC_private_value' });
  const recovered = await service.read(tree);
  expect(recovered.approval?.attemptId).toBe(id);
  expect(recovered.approval?.secrets[0].availability).toBe('available');
  expect(recovered.status?.active).toBeUndefined();
  expect((await service.owner().logs(service.name(tree), id)).text).not.toContain('started');
  await approveAndWait(tree, id);
});

it('identifies initial external sources and grants access only to an exact explicit connection', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('main');
  const external = await worktree('external');
  const unrelated = await worktree('unrelated');
  await fs.writeFile(path.join(external.worktreePath, 'index.html'), 'connected external');
  await fs.writeFile(path.join(tree.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'environment', primary: 'web', services: { web: { type: 'static', directory: external.worktreePath } } }));
  const root = await fs.realpath(external.worktreePath);
  expect((await service.read(tree)).fileSources).toMatchObject([{ service: 'web', directory: external.worktreePath, connected: false }]);
  const before = service.owner().sourceRoots();
  const input = { taskId: tree.taskId, service: 'web', directory: root, expected: { active: null, candidate: null, latest: null } };
  await expect(service.connectSource(tree, { ...input, directory: unrelated.worktreePath })).rejects.toThrow('configuration changed');
  expect(service.owner().sourceRoots()).toEqual(before);
  const connected = await service.connectSource(tree, input);
  expect(connected.fileSources?.[0].connected).toBe(true);
  expect(connected.status).toBeUndefined();
  expect(connected.approval).toBeUndefined();
  const pending = await service.start(tree);
  const ready = await approveAndWait(tree, pending.status!.candidate!.id);
  expect(await (await fetch(ready.url!)).text()).toBe('connected external');
});

it('does not recommend an incomplete command for a fresh dependency-based project', async () => {
  const { service, worktree } = await fixture();
  const tree = await worktree('fresh Next.js project');
  await fs.unlink(path.join(tree.worktreePath, 'preview.yaml'));
  await fs.writeFile(path.join(tree.worktreePath, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev --experimental-https -p 8000' } }));
  await fs.mkdir(path.join(tree.worktreePath, 'web'));
  await fs.writeFile(path.join(tree.worktreePath, 'web/index.html'), '<div id=app></div>');
  expect((await service.inspectSetup(tree)).recommendations).toEqual([]);
  await fs.writeFile(path.join(tree.worktreePath, 'package.json'), '{invalid');
  expect((await service.inspectSetup(tree)).recommendations).toEqual([]);
  await expect(fs.access(path.join(tree.worktreePath, 'preview.yaml'))).rejects.toThrow();
});

it('reviews live-folder jobs before stopping and consumes approval only for the captured restart specification', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('serving before restart');
  const initial = await service.start(tree);
  const ready = await approveAndWait(tree, initial.status!.candidate!.id);
  const neighbor = await worktree('new preview with shared install folder');
  await fs.writeFile(path.join(neighbor.worktreePath, 'preview.yaml'), JSON.stringify({
    name: 'neighbor', type: 'environment', primary: 'web', services: {
      install: { type: 'job', cwd: tree.worktreePath, command: [process.execPath, '-e', "require('fs').writeFileSync('unapproved.txt','changed')"] },
      web: { type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], dependsOn: ['install'] }
    }
  }));
  const neighborStart = await service.start(neighbor);
  await expect.poll(async () => (await service.read(neighbor)).approval?.attemptId).toBe(neighborStart.status!.candidate!.id);
  expect((await service.read(neighbor)).approval).toMatchObject({
    affected: [{ job: 'install', directory: await fs.realpath(tree.worktreePath), previews: ['another preview'] }]
  });
  await service.cancel(neighbor, neighborStart.status!.candidate!.id);
  await expect(fs.access(path.join(tree.worktreePath, 'unapproved.txt'))).rejects.toThrow();
  expect(await (await fetch(ready.url!)).text()).toBe('serving before restart');
  const file = (await service.readFile(tree)).file!;
  const replacement = JSON.stringify({ name: 'readable-project', type: 'environment', primary: 'web', services: {
    install: { type: 'job', cwd: '.', command: [process.execPath, '-e', "require('fs').writeFileSync('installed.txt',process.env.MODE)"], env: { MODE: 'reviewed-value' } },
    web: { type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], dependsOn: ['install'] }
  } });
  await service.saveFile(tree, file, replacement);
  const review = await service.start(tree);
  expect(review.restartReview?.affected).toMatchObject([{ job: 'install', previews: ['this preview'] }]);
  expect(review.status?.candidate).toBeUndefined();
  expect(await (await fetch(ready.url!)).text()).toBe('serving before restart');
  await service.cancel(tree, review.restartReview!.id);
  expect(await (await fetch(ready.url!)).text()).toBe('serving before restart');
  await expect(fs.access(path.join(tree.worktreePath, 'installed.txt'))).rejects.toThrow();
  const approved = await service.start(tree);
  // An edit after review must not alter the already reviewed execution input.
  await fs.writeFile(path.join(tree.worktreePath, 'preview.yaml'), replacement.replace('"reviewed-value"', '{"secret":"not-in-reviewed-restart"}'));
  expect((await service.read(tree)).requirements?.secrets).toEqual([]);
  await service.approve(tree, approved.restartReview!.id);
  await expect.poll(async () => (await service.read(tree)).status?.active?.id, { timeout: 10_000 }).not.toBe(ready.id);
  await expect.poll(async () => (await service.read(tree)).status?.active?.state, { timeout: 10_000 }).toBe('ready');
  expect(await fs.readFile(path.join(tree.worktreePath, 'installed.txt'), 'utf8')).toBe('reviewed-value');
  expect((await service.read(tree)).configurationChanged).toBe(true);
  expect((await service.read(tree)).approval).toBeUndefined();
  await expect(service.approve(tree, approved.restartReview!.id)).rejects.toThrow('no longer current');
}, 30_000);

it('uses the edited file after a failed replacement and refuses a stale save without altering it', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('file remains authoritative');
  const original = (await service.readFile(tree)).file!;
  const pending = await service.start(tree);
  await approveAndWait(tree, pending.status!.candidate!.id);
  await service.saveFile(tree, original, original.text.replace('server.cjs', 'missing.cjs'));
  const failure = await service.start(tree);
  await expect.poll(async () => (await service.read(tree)).approval?.attemptId).toBe(failure.status!.candidate!.id);
  await service.approve(tree, failure.status!.candidate!.id);
  expect((await service.owner().wait(service.name(tree), failure.status!.candidate!.id)).state).toBe('failed');
  await service.owner().stop(service.name(tree));
  const failedFile = (await service.readFile(tree)).file!;
  await service.saveFile(tree, failedFile, original.text);
  await expect(service.saveFile(tree, failedFile, failedFile.text)).rejects.toThrow('changed');
  expect((await service.readFile(tree)).file?.text).toBe(original.text);
  const restarted = await service.start(tree);
  const ready = await approveAndWait(tree, restarted.status!.candidate!.id);
  expect(await (await fetch(ready.url!)).text()).toBe('file remains authoritative');
});
