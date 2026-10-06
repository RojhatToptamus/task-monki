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
  const pendingA = await service.start(a, 'file');
  const pendingB = await service.start(b, 'file');
  expect(pendingA.status?.active).toBeUndefined();
  await expect(service.approve(b, pendingA.status!.candidate!.id)).rejects.toThrow('no longer current');
  const readyA = await approveAndWait(a, pendingA.status!.candidate!.id);
  const readyB = await approveAndWait(b, pendingB.status!.candidate!.id);
  await fs.writeFile(path.join(a.worktreePath, 'content.txt'), 'unstaged change');
  expect(await (await fetch(readyA.url!)).text()).toBe('unstaged change');
  const canceled = await service.start(a, 'file');
  await service.owner().cancel(service.name(a), canceled.status!.candidate!.id);
  expect(await (await fetch(readyA.url!)).text()).toBe('unstaged change');
  await fs.writeFile(path.join(a.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, '-e', 'process.exit(2)'] }));
  const failure = await service.start(a, 'file');
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
  await expect(service.secrets.create({ id: 'test/dev/token', value: 'duplicate' })).rejects.toThrow('already exists');
  for (const tree of [await worktree('one'), await worktree('two')]) {
    await fs.writeFile(path.join(tree.worktreePath, 'preview.yaml'), JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, 'server.cjs'], env: { TOKEN: { secret: 'test/dev/token' } } }));
    const pending = await service.start(tree, 'file');
    const id = pending.status!.candidate!.id;
    await expect.poll(async () => (await service.read(tree)).approval?.attemptId).toBe(id);
    expect(JSON.stringify(await service.read(tree))).not.toContain(secret);
    expect((await service.owner().logs(service.name(tree), id)).text).not.toContain('started');
    await approveAndWait(tree, id);
    const logs = await service.owner().logs(service.name(tree), id);
    expect(logs.text).not.toContain(secret);
    expect(JSON.stringify(await service.secrets.list())).not.toContain(secret);
  }
  expect(await service.secrets.update({ id: 'test/dev/token', value: 'SYNTHETIC_new_value' })).toBe(true);
  await service.secrets.remove({ id: 'test/dev/token' });
  await service.secrets.lock();
}, 30_000);

it('keeps runtime observation, retained restart, and cleanup available when default configuration files conflict', async () => {
  const { service, worktree, approveAndWait } = await fixture();
  const tree = await worktree('retained application');
  const pending = await service.start(tree, 'file');
  const ready = await approveAndWait(tree, pending.status!.candidate!.id);
  await fs.copyFile(path.join(tree.worktreePath, 'preview.yaml'), path.join(tree.worktreePath, 'preview.yml'));
  await expect(service.read(tree)).resolves.toMatchObject({
    hasConfigurationFile: true,
    status: { active: { id: ready.id, state: 'ready' } }
  });
  await expect(service.start(tree, 'file')).rejects.toThrow('Both preview.yaml and preview.yml exist');
  expect(await (await fetch(ready.url!)).text()).toBe('retained application');
  await service.owner().stop(service.name(tree));
  await expect(fetch(ready.url!)).rejects.toThrow();
  const restarted = await service.start(tree, 'retained');
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
  const pending = await service.start(consumer, 'file');
  const ready = await approveAndWait(consumer, pending.status!.candidate!.id);
  await expect(service.retireWorktree(source)).rejects.toThrow(/source.*in use|uses this source/i);
  expect(await (await fetch(ready.url!)).text()).toBe('shared backend');
  await service.owner().stop(service.name(consumer));
  await service.retireWorktree(source);
  expect(service.owner().sourceRoots()).not.toContain(await fs.realpath(source.worktreePath));
});
