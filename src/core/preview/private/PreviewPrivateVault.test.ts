import { chmod, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewPrivateVault, type PreviewSecretProtector } from './PreviewPrivateVault';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const protector: PreviewSecretProtector = {
  isAvailable: () => true,
  encrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa)),
  decrypt: async (value) => Buffer.from(value.map((byte) => byte ^ 0xaa))
};

describe('PreviewPrivateVault', () => {
  it('rotates without deleting a leased revision and never stores plaintext', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const vault = new PreviewPrivateVault(root, protector);
    expect(await vault.set('task', 'token', 'canary-one')).toBe('STORED');
    const lease = await vault.acquire('task', ['token']);
    if (Array.isArray(lease)) throw new Error('unexpected blocker');
    expect(lease.values.token).toBe('canary-one');
    await vault.set('task', 'token', 'canary-two');
    expect((await readdir(root)).filter((name) => name.endsWith('.blob'))).toHaveLength(2);
    await lease.release();
    expect((await readdir(root)).filter((name) => name.endsWith('.blob'))).toHaveLength(1);
    for (const name of await readdir(root)) expect(await readFile(path.join(root, name), 'utf8')).not.toContain('canary');
  });
  it('reports missing values without preventing planning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const vault = new PreviewPrivateVault(root, protector);
    expect(await vault.readiness('task', ['token'])).toEqual([{ kind: 'PRIVATE_INPUT_MISSING', inputId: 'token' }]);
  });
  it('retains an exact revision until its durable generation reference is released', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const vault = new PreviewPrivateVault(root, protector);
    await vault.set('task', 'token', 'r1');
    const lease = await vault.acquire('task', ['token']); if (Array.isArray(lease)) throw new Error('unexpected blocker');
    await vault.retainGeneration('generation-1', 'task', lease.revisions);
    await lease.release(); await vault.set('task', 'token', 'r2');
    expect((await readdir(root)).filter((name) => name.endsWith('.blob'))).toHaveLength(2);
    await vault.releaseGeneration('generation-1');
    expect((await readdir(root)).filter((name) => name.endsWith('.blob'))).toHaveLength(1);
  });
  it('sweeps deleted-task references and exact unindexed encrypted orphans', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const vault = new PreviewPrivateVault(root, protector);
    await vault.set('deleted-task', 'token', 'residue');
    await writeFile(path.join(root, '11111111-1111-4111-8111-111111111111.blob'), 'orphan');
    expect(await vault.sweep({ taskIds: new Set(), retainedGenerationIds: new Set() })).toBe('CLEAN');
    expect((await readdir(root)).filter((name) => name.endsWith('.blob'))).toEqual([]);
  });
  it('fails closed on corrupt blob authority without deleting outside the vault', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    roots.push(outside);
    await writeFile(outside, 'keep-me', { mode: 0o600 });
    await writeFile(path.join(root, 'index.json'), JSON.stringify({
      formatVersion: 1,
      current: {},
      revisions: [{
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'task',
        inputId: 'token',
        blobName: `../${path.basename(outside)}`,
        createdAt: new Date().toISOString()
      }],
      references: []
    }), { mode: 0o600 });
    await chmod(path.join(root, 'index.json'), 0o600);
    const vault = new PreviewPrivateVault(root, protector);
    expect(await vault.sweep({ taskIds: new Set(), retainedGenerationIds: new Set() }))
      .toBe('RECOVERY_REQUIRED');
    expect(await readFile(outside, 'utf8')).toBe('keep-me');
  });
  it('refuses a symlink substituted for an encrypted revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tm-vault-')); roots.push(root);
    const vault = new PreviewPrivateVault(root, protector);
    await vault.set('task', 'token', 'canary');
    const blob = (await readdir(root)).find((name) => name.endsWith('.blob'))!;
    const outside = path.join(root, 'outside');
    await writeFile(outside, 'not-ciphertext', { mode: 0o600 });
    await unlink(path.join(root, blob));
    await symlink(outside, path.join(root, blob));
    expect(await vault.acquire('task', ['token'])).toEqual([
      { kind: 'PRIVATE_INPUT_CORRUPT', inputId: 'token' }
    ]);
  });
});
