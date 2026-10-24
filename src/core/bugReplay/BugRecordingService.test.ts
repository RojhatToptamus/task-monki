import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ignoredEnvFiles } from './BugRecordingService';

describe('Env files a recording offers', () => {
  it('offers only ignored env files Git does not track, since a tracked one comes with the code', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bug-env-files-'));
    onTestFinished(() => fs.rm(repo, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    });
    git('init', '-q', '-b', 'main');
    // `.env` was committed before the ignore rule that now matches it.
    await fs.writeFile(path.join(repo, '.env'), 'PORT=3000\n');
    git('add', '.env');
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\n.env.local\n');
    await fs.writeFile(path.join(repo, '.env.local'), 'DEBUG=1\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'Initial');

    expect(await ignoredEnvFiles(repo, 'name: app\ntype: command\ncwd: .\ncommand: [node, server.js]\n')).toEqual([
      { name: '.env.local', directory: '.', include: true }
    ]);
  });
});
