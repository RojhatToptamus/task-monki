import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { git } from '../core/git/gitCli';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { WorktreeService, listGitWorktrees } from '../core/worktree/WorktreeService';
import { createScriptedAgentRuntimeFixture } from './taskMonkiScenario';

const [mode, root] = process.argv.slice(2);
if (!mode || !root) {
  throw new Error('Task Manager restart fixture requires a mode and root.');
}

const repositoryPath = path.join(root, 'repository');
const storePath = path.join(root, 'store');
const worktreeRoot = path.join(root, 'worktrees');

if (mode === 'prepare') {
  await fs.mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'restart@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Restart Fixture']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Restart fixture\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial fixture commit']);

  const store = new FileTaskStore(storePath);
  const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
  const service = new TaskManagerService(store, repositoryPath, undefined, {
    worktreeRoot,
    ...scriptedRuntime.serviceOptions
  });
  await service.init();
  const repository = await service.addRepository(repositoryPath);
  const task = await service.createTask({
    title: 'Restart fixture task',
    prompt: 'Recover interrupted work.',
    repositoryId: repository.id
  });
  const baseSha = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
  const records = await store.createIterationAndWorktree({
    task,
    branchName: 'task-monki/process-restart',
    worktreePath: path.join(worktreeRoot, task.id),
    baseRef: 'main',
    baseSha
  });
  const actual = await new WorktreeService(worktreeRoot).create(
    records.worktree,
    repositoryPath
  );
  await fs.writeFile(path.join(actual.worktreePath, 'crash.txt'), 'persisted by Git\n');
  await git(actual.worktreePath, ['add', 'crash.txt']);
  await git(actual.worktreePath, ['commit', '-m', 'Commit before abrupt exit']);
  const headSha = (await git(actual.worktreePath, ['rev-parse', 'HEAD'])).trim();
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      taskId: task.id,
      worktreeId: records.worktree.id,
      headSha
    })}\n`
  );
  setInterval(() => undefined, 30_000);
} else if (mode === 'recover') {
  const store = new FileTaskStore(storePath);
  const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
  const service = new TaskManagerService(store, repositoryPath, undefined, {
    worktreeRoot,
    ...scriptedRuntime.serviceOptions
  });
  await service.init();
  const snapshot = await store.snapshot();
  const task = snapshot.tasks[0];
  const worktree = snapshot.worktrees.find(
    (candidate) => candidate.id === task?.currentWorktreeId
  );
  const gitSnapshot = snapshot.gitSnapshots
    .filter((candidate) => candidate.taskId === task?.id)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  const registered = await listGitWorktrees(repositoryPath);
  process.stdout.write(
    `${JSON.stringify({
      taskId: task?.id,
      worktreeId: worktree?.id,
      worktreeStatus: worktree?.status,
      headSha: gitSnapshot?.headSha,
      registeredPaths: registered.map((candidate) => candidate.path)
    })}\n`
  );
  await service.shutdown();
} else {
  throw new Error(`Unknown restart fixture mode: ${mode}`);
}
