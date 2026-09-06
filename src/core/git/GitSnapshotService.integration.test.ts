import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecord } from '../../shared/contracts';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import * as gitCli from './gitCli';
import {
  buildDiffEvidence,
  captureGitObservation,
  inspectGitSnapshot,
  inspectGitWorkingTreeFingerprint
} from './GitSnapshotService';

const execFileAsync = promisify(execFile);
const realGit = gitCli.git;
const fixtureRoots: string[] = [];
const pendingReads = new Set<Promise<string>>();
let afterRead: ((args: string[], output: string) => Promise<void>) | undefined;

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  // All commands still execute real Git. The hook places external writes at a
  // deterministic read boundary, without manufacturing Git evidence.
  vi.spyOn(gitCli, 'git').mockImplementation((cwd, args, options) => {
    const read = realGit(cwd, args, options).then(async (output) => {
      await afterRead?.(args, output);
      return output;
    });
    pendingReads.add(read);
    void read.then(() => pendingReads.delete(read), () => pendingReads.delete(read));
    return read;
  });
});

afterEach(async () => {
  while (pendingReads.size > 0) await Promise.allSettled([...pendingReads]);
  afterRead = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('captureGitObservation', () => {
  it.each(['primary', 'linked'] as const)(
    'captures %s external work without changing files, index, upstream, or Git config or running configured helpers',
    async (kind) => {
      const { root, repositoryPath, worktree } = await createFixture(kind);
      const cwd = worktree.worktreePath;
      await fs.writeFile(path.join(cwd, 'committed.txt'), 'committed feature\n');
      await runGit(cwd, ['add', 'committed.txt']);
      await runGit(cwd, ['commit', '-m', 'External commit']);
      await fs.writeFile(path.join(cwd, 'tracked.txt'), 'staged change\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await fs.writeFile(path.join(cwd, 'tracked.txt'), 'unstaged change\n');
      await fs.writeFile(path.join(cwd, 'untracked.txt'), 'untracked content\n');
      await fs.writeFile(path.join(cwd, 'ignored.txt'), 'private ignored content\n');
      const head = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
      await runGit(cwd, ['config', 'remote.origin.url', path.join(root, 'unused-remote')]);
      await runGit(cwd, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      await runGit(cwd, ['config', `branch.${worktree.branchName}.remote`, 'origin']);
      await runGit(cwd, ['config', `branch.${worktree.branchName}.merge`, `refs/heads/${worktree.branchName}`]);
      await runGit(cwd, ['update-ref', `refs/remotes/origin/${worktree.branchName}`, head]);
      const marker = path.join(root, 'helper-executed');
      const helper = await writeNodeExecutable(root, 'diff-helper',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write('converted');`);
      await runGit(cwd, ['config', 'diff.sidecar.textconv', helper]);
      await runGit(cwd, ['config', 'diff.sidecar.cachetextconv', 'true']);
      await runGit(cwd, ['config', 'diff.sidecar.command', helper]);
      await runGit(cwd, ['config', 'core.fsmonitor', helper]);
      const gitDir = path.resolve(cwd, (await runGit(cwd, ['rev-parse', '--git-dir'])).trim());
      const commonDir = path.resolve(cwd, (await runGit(cwd, ['rev-parse', '--git-common-dir'])).trim());
      const files = [
        path.join(gitDir, 'index'), path.join(commonDir, 'config'),
        ...['tracked.txt', 'committed.txt', 'untracked.txt', 'ignored.txt', '.gitattributes', '.gitignore']
          .map((name) => path.join(cwd, name))
      ];
      const before = await Promise.all(files.map((file) => fs.readFile(file)));
      const indexBefore = await fs.stat(path.join(gitDir, 'index'));

      const { snapshot, diffEvidence } = await captureGitObservation(worktree, repositoryPath);
      const fingerprint = await inspectGitWorkingTreeFingerprint(cwd);

      expect(snapshot).toMatchObject({
        worktreePath: cwd, branch: worktree.branchName, headSha: head,
        status: 'DIRTY', stagedCount: 1, unstagedCount: 1, untrackedCount: 1,
        committedDiffFileCount: 1, upstreamSha: head, dirtyFingerprint: fingerprint
      });
      expect(diffEvidence).toContain('+committed feature');
      expect(diffEvidence).toContain('+staged change');
      expect(diffEvidence).toContain('+unstaged change');
      expect(diffEvidence).toContain('+untracked content');
      expect(diffEvidence).not.toContain('private ignored content');
      expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
      expect((await fs.stat(path.join(gitDir, 'index'))).mtimeMs).toBe(indexBefore.mtimeMs);
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await runGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/notes/textconv'])).toBe('');
    }
  );

  it.each(['edit', 'stage', 'untracked edit', 'commit', 'branch switch', 'metadata replacement'] as const)(
    'rejects an external %s between snapshot and diff capture',
    async (change) => {
      const { root, repositoryPath, worktree } = await createFixture();
      const cwd = worktree.worktreePath;
      await fs.writeFile(path.join(cwd, 'untracked.txt'), 'before\n');
      if (change === 'stage') await fs.writeFile(path.join(cwd, 'tracked.txt'), 'stage me\n');
      let changed = false;
      afterRead = async (args) => {
        if (changed || args[0] !== '-c' || !args.includes('--git-dir')) return;
        changed = true;
        if (change === 'edit') await fs.writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
        if (change === 'untracked edit') await fs.writeFile(path.join(cwd, 'untracked.txt'), 'after\n');
        if (change === 'stage') await runGit(cwd, ['add', 'tracked.txt']);
        if (change === 'commit') await runGit(cwd, ['commit', '--allow-empty', '-m', 'External advance']);
        if (change === 'branch switch') await runGit(cwd, ['switch', '-c', 'other-branch']);
        if (change === 'metadata replacement') {
          const oldGit = path.join(root, 'old-git');
          await fs.rename(path.join(cwd, '.git'), oldGit);
          await fs.cp(oldGit, path.join(cwd, '.git'), { recursive: true });
        }
      };

      await expect(captureGitObservation(worktree, repositoryPath)).rejects.toThrow(/changed during observation|Expected branch/);
      expect(changed).toBe(true);
    }
  );

  it('rejects a different repository, switched branch, and detached checkout', async () => {
    const { repositoryPath, worktree } = await createFixture('linked');
    const unrelated = await createFixture();
    await expect(captureGitObservation(worktree, unrelated.repositoryPath)).rejects.toThrow('common Git directory');
    await expect(captureGitObservation({ ...worktree, branchName: 'wrong-branch' }, repositoryPath)).rejects.toThrow('Expected branch');
    await runGit(worktree.worktreePath, ['checkout', '--detach']);
    await expect(captureGitObservation(worktree, repositoryPath)).rejects.toThrow('detached HEAD');
  });

  it.skipIf(process.platform === 'win32')('detects untracked executable and symlink changes even when content bytes stay identical', async () => {
    const { repositoryPath, worktree } = await createFixture();
    const file = path.join(worktree.worktreePath, 'untracked.txt');
    await fs.writeFile(file, 'tracked.txt');
    await fs.chmod(file, 0o644);
    const regular = await captureGitObservation(worktree, repositoryPath);

    for (const mode of ['100755', '120000']) {
      let changed = false;
      afterRead = async (args) => {
        if (changed || args[0] !== '-c' || !args.includes('--git-dir')) return;
        changed = true;
        if (mode === '100755') {
          await fs.chmod(file, 0o755);
        } else {
          await fs.unlink(file);
          await fs.symlink('tracked.txt', file);
        }
      };
      await expect.soft(captureGitObservation(worktree, repositoryPath)).rejects.toThrow('changed during observation');
      expect(changed).toBe(true);
      afterRead = undefined;
      const current = await captureGitObservation(worktree, repositoryPath);
      expect.soft(current.snapshot.dirtyFingerprint).not.toBe(regular.snapshot.dirtyFingerprint);
      expect(current.diffEvidence).toContain(`new file mode ${mode}`);
    }
  });

  it.each([
    ['snapshot', (worktree: WorktreeRecord) => inspectGitSnapshot(worktree)],
    ['diff', (worktree: WorktreeRecord) => buildDiffEvidence(worktree)],
    ['capture', (worktree: WorktreeRecord) => captureGitObservation(worktree, worktree.worktreePath)]
  ] as const)('propagates required %s read errors instead of returning empty evidence', async (_name, read) => {
    const { worktree } = await createFixture();
    await expect(read({ ...worktree, baseSha: 'missing-comparison-commit' })).rejects.toThrow();
  });

  it('still captures a managed worktree through the same API', async () => {
    const { repositoryPath, worktree } = await createFixture('linked');
    const observed = await captureGitObservation({ ...worktree, ownership: 'TASK_MONKI' }, repositoryPath);
    expect(observed.snapshot).toMatchObject({ status: 'CLEAN', headSha: worktree.baseSha });
    expect(observed.diffEvidence).toContain('No committed diff.');
  });

  it('rejects an unreadable untracked diff instead of fabricating an empty added file', async () => {
    const { worktree } = await createFixture();
    const file = path.join(worktree.worktreePath, 'untracked.txt');
    await fs.writeFile(file, 'untracked\n');
    let removed = false;
    afterRead = async (args) => {
      if (removed || !args.includes('--porcelain=v2')) return;
      removed = true;
      await fs.unlink(file);
    };
    await expect(buildDiffEvidence(worktree)).rejects.toThrow();
  });
});

describe('inspectGitWorkingTreeFingerprint', () => {
  it('rejects a file that disappears after Git lists it instead of hashing missing-file metadata', async () => {
    const { worktree } = await createFixture();
    const file = path.join(worktree.worktreePath, 'untracked.txt');
    await fs.writeFile(file, 'untracked\n');
    let removed = false;
    afterRead = async (args) => {
      if (removed || !args.includes('--porcelain=v2')) return;
      removed = true;
      await fs.unlink(file);
    };
    await expect(inspectGitWorkingTreeFingerprint(worktree.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hashes large untracked content even when size and modification time are preserved', async () => {
    const { worktree } = await createFixture();
    const file = path.join(worktree.worktreePath, 'large.bin');
    await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65));
    const stat = await fs.stat(file);
    const before = await inspectGitWorkingTreeFingerprint(worktree.worktreePath);
    await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, 66));
    await fs.utimes(file, stat.atime, stat.mtime);
    expect(await inspectGitWorkingTreeFingerprint(worktree.worktreePath)).not.toBe(before);
  });

  it('rejects an untracked file that grows while its content is being read', async () => {
    const { worktree } = await createFixture();
    const file = path.join(worktree.worktreePath, 'growing.txt');
    await fs.writeFile(file, 'initial content\n');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === file) {
        const createReadStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          const stream = createReadStream(options);
          stream.once('data', () => appendFileSync(file, 'external append\n'));
          return stream;
        });
      }
      return handle;
    });
    await expect(inspectGitWorkingTreeFingerprint(worktree.worktreePath)).rejects.toThrow('changed during observation');
  });

  it.skipIf(process.platform === 'win32')('fingerprints untracked symlink targets without reading outside the checkout', async () => {
    const { root, worktree } = await createFixture();
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'outside before');
    await fs.symlink(outside, path.join(worktree.worktreePath, 'external-link'));
    const before = await inspectGitWorkingTreeFingerprint(worktree.worktreePath);
    await fs.writeFile(outside, 'outside after');
    expect(await inspectGitWorkingTreeFingerprint(worktree.worktreePath)).toBe(before);
  });
});

async function createFixture(kind: 'primary' | 'linked' = 'primary') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-git-observation-'));
  fixtureRoots.push(root);
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'test@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Git Observation Test']);
  await fs.writeFile(path.join(repositoryPath, 'tracked.txt'), 'initial\n');
  await fs.writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repositoryPath, '.gitattributes'), '*.txt diff=sidecar\n');
  await runGit(repositoryPath, ['add', '.']);
  await runGit(repositoryPath, ['commit', '-m', 'Initial']);
  const baseSha = (await runGit(repositoryPath, ['rev-parse', 'HEAD'])).trim();
  const worktreePath = kind === 'primary' ? repositoryPath : path.join(root, 'linked checkout');
  const branchName = kind === 'primary' ? 'main' : 'feature';
  if (kind === 'linked') await runGit(repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath]);
  const now = new Date().toISOString();
  const worktree: WorktreeRecord = {
    id: 'worktree', taskId: 'task', iterationId: 'iteration', repositoryId: 'repository',
    ownership: 'EXTERNAL', worktreePath, branchName, baseSha, status: 'PRESENT',
    createdAt: now, updatedAt: now
  };
  return { root, repositoryPath, worktree };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}
