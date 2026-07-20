import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiscourseWorkspace } from './DiscourseWorkspace';

describe('DiscourseWorkspace', () => {
  it('creates one canonical empty workspace with no writable POSIX bits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-workspace-'));
    const workspace = new DiscourseWorkspace(path.join(root, 'managed'));

    const [first, second] = await Promise.all([
      workspace.prepareEmptyReadOnlyWorkspace(),
      workspace.prepareEmptyReadOnlyWorkspace()
    ]);

    expect(first).toBe(second);
    expect(first).toBe(await fs.realpath(first));
    expect(await fs.readdir(first)).toEqual([]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(first)).mode & 0o222).toBe(0);
      await expect(fs.writeFile(path.join(first, 'forbidden.txt'), 'no')).rejects.toMatchObject({
        code: 'EACCES'
      });
    }
  });

  it('fails closed if data appears in the empty workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-workspace-'));
    const rootDirectory = path.join(root, 'managed');
    const first = new DiscourseWorkspace(rootDirectory);
    const workspacePath = await first.prepareEmptyReadOnlyWorkspace();
    if (process.platform !== 'win32') await fs.chmod(workspacePath, 0o700);
    await fs.writeFile(path.join(workspacePath, 'unexpected.txt'), 'secret', 'utf8');
    if (process.platform !== 'win32') await fs.chmod(workspacePath, 0o500);

    await expect(
      new DiscourseWorkspace(rootDirectory).prepareEmptyReadOnlyWorkspace()
    ).rejects.toThrow('contains unexpected data');
  });

  it('rejects a symlink in place of the managed workspace', async () => {
    if (process.platform === 'win32') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-workspace-'));
    const rootDirectory = path.join(root, 'managed');
    const target = path.join(root, 'target');
    await fs.mkdir(rootDirectory, { recursive: true });
    await fs.mkdir(target);
    await fs.symlink(target, path.join(rootDirectory, 'empty-read-only-v1'));

    await expect(
      new DiscourseWorkspace(rootDirectory).prepareEmptyReadOnlyWorkspace()
    ).rejects.toThrow('must be a real directory');
  });
});
