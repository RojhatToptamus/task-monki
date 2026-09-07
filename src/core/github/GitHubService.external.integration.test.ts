import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { git } from '../git/gitCli';
import { GitHubService } from './GitHubService';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(async () => { await scenarios.dispose(); });

describe('External checkout delivery', () => {
  it('pushes only the verified commit without changing upstream settings, and recovers against the recorded destination', async () => {
    const s = await scenarios.create();
    const remote = path.join(s.rootDir, 'remote.git');
    const other = path.join(s.rootDir, 'other.git');
    await git(s.rootDir, ['init', '--bare', remote]);
    await git(s.rootDir, ['init', '--bare', other]);
    await git(s.repositoryPath, ['remote', 'add', 'origin', remote]);
    await git(s.repositoryPath, ['config', 'push.followTags', 'true']);
    await git(s.repositoryPath, ['tag', '-a', 'private-note', '-m', 'Do not publish this tag']);
    const task = await s.service.importTask({
      repositoryId: s.repositoryId, worktreePath: s.repositoryPath,
      branchName: 'main', baseRef: 'HEAD', title: 'External publication', prompt: 'Existing work.'
    });
    const worktree = (await s.store.getCurrentWorktree(task.id))!;
    const observed = (await s.store.getLatestGitSnapshot(task.id))!;
    const configBefore = await git(s.repositoryPath, ['config', '--local', '--list']);
    const service = new GitHubService();
    const input = {
      task, worktree, remoteName: 'origin', remoteUrl: remote,
      expectedHeadSha: observed.headSha!, expectedGitCommonDir: observed.gitCommonDir
    };
    expect(await service.publishBranch(input)).toMatchObject({ status: 'PUSHED', headSha: observed.headSha, remoteUrl: remote });
    expect(await git(s.repositoryPath, ['config', '--local', '--list'])).toBe(configBefore);
    expect((await git(s.repositoryPath, ['ls-remote', '--refs', remote])).trim()).toBe(`${observed.headSha}\trefs/heads/main`);

    await s.commitFile('newer.txt', 'not the approved commit\n');
    expect(await service.publishBranch(input)).toMatchObject({ status: 'FAILED' });
    await git(s.repositoryPath, ['remote', 'set-url', 'origin', other]);
    expect(await service.reconcileBranchPublication(input)).toMatchObject({ status: 'PUSHED', headSha: observed.headSha, remoteUrl: remote });
    expect(await git(s.repositoryPath, ['ls-remote', other])).toBe('');
  });

  it('discovers one same-repository PR, rejects ambiguous or incomplete results, and preserves lookup errors', async () => {
    const s = await scenarios.create();
    const dataPath = path.join(s.rootDir, 'gh-result.json');
    const logPath = path.join(s.rootDir, 'gh-commands.jsonl');
    const gh = await writeNodeExecutable(s.rootDir, 'fake-gh', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
if (data.error) { process.stderr.write(data.error); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'list') process.stdout.write(JSON.stringify(data.rows));
else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(data.view));
else if (args[0] === 'pr' && args[1] === 'checks') process.stdout.write('[]');
else { process.stderr.write('Unexpected mutation'); process.exit(1); }
`);
    await git(s.repositoryPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const task = await s.service.importTask({
      repositoryId: s.repositoryId, worktreePath: s.repositoryPath, branchName: 'main',
      baseRef: 'HEAD', title: 'Existing PR', prompt: 'Existing work.'
    });
    const worktree = (await s.store.getCurrentWorktree(task.id))!;
    const service = new GitHubService(gh);
    const matching = {
      number: 42, url: 'https://github.com/example/project/pull/42', state: 'OPEN', isDraft: true,
      headRefName: 'main', headRefOid: worktree.headSha, baseRefName: 'release', isCrossRepository: false,
      headRepository: { name: 'project' }, headRepositoryOwner: { login: 'example' }, statusCheckRollup: []
    };
    const fork = { ...matching, number: 43, url: 'https://github.com/example/project/pull/43',
      isCrossRepository: true, headRepositoryOwner: { login: 'someone-else' } };
    await fs.writeFile(dataPath, JSON.stringify({ rows: [fork, matching], view: matching }));
    expect((await service.findOpenPullRequest(worktree))?.pullRequest.number).toBe(42);
    await fs.writeFile(dataPath, JSON.stringify({ rows: [matching, { ...matching, number: 44, url: 'https://github.com/example/project/pull/44' }] }));
    await expect(service.findOpenPullRequest(worktree)).rejects.toThrow('Multiple pull requests');
    await fs.writeFile(dataPath, JSON.stringify({ rows: [{ number: 42 }] }));
    await expect(service.findOpenPullRequest(worktree)).rejects.toThrow('complete pull request identity');
    await fs.writeFile(dataPath, JSON.stringify({ error: 'GitHub is unavailable' }));
    await expect(service.findOpenPullRequest(worktree)).rejects.toThrow();
    const commands = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(commands.every((args) => args[0] === 'pr' && ['list', 'view', 'checks'].includes(args[1]!))).toBe(true);
    expect(commands.every((args) => args.includes('github.com/example/project'))).toBe(true);
  });
});
