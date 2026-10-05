import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import {
  createScriptedAgentRuntimeFixture,
  TaskMonkiScenarioRegistry
} from '../../testSupport/taskMonkiScenario';
import { AppEventBus } from '../runner/AppEventBus';
import { TaskManagerService } from './TaskManagerService';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

it('reconnects an additional source after restart while retaining access to the task worktree', async () => {
  const scenario = await scenarios.create({ previewEnabled: true });
  const task = await scenario.createTask({ title: 'Reconnect application source' });
  const worktree = await prepareTestWorktree(scenario.service, task.id);
  const unstartedTask = await scenario.createTask({ title: 'No application yet' });
  expect(await scenario.service.listApplicationPreviews()).toEqual([]);
  await fs.mkdir(path.join(worktree.worktreePath, 'public'));
  await fs.writeFile(path.join(worktree.worktreePath, 'public/index.html'), 'primary source');
  const extra = path.join(scenario.rootDir, 'additional source');
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'index.html'), 'connected source');
  await fs.writeFile(path.join(worktree.worktreePath, 'preview.yaml'), JSON.stringify({
    name: 'application', type: 'environment', primary: 'web',
    services: {
      web: { type: 'static', directory: './public' },
      docs: { type: 'static', directory: './public' }
    }
  }));
  await scenario.service.startApplicationPreview({ taskId: task.id, source: 'file' });
  await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).approval).toBeTruthy();
  const initial = await scenario.service.getApplicationPreview({ taskId: task.id });
  expect(await scenario.service.listApplicationPreviews()).toMatchObject([{
    taskId: task.id, worktreeId: worktree.id, isCurrentWorktree: true,
    kind: 'task', title: task.title, branch: worktree.branchName,
    projectDirectory: worktree.worktreePath, approvalPending: true
  }]);
  await scenario.service.approveApplicationPreview({ taskId: task.id, attemptId: initial.approval!.attemptId });
  await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).status?.active?.state).toBe('ready');
  await scenario.service.shutdown();
  await scenario.persistence.close();

  const persistence = await openTestPersistence(path.join(scenario.rootDir, 'profile'));
  const runtime = createScriptedAgentRuntimeFixture(persistence);
  const reopened = new TaskManagerService(persistence.tasks, scenario.repositoryPath, new AppEventBus(), {
    ...runtime.serviceOptions,
    previewEnabled: true,
    previewRoot: path.join(scenario.rootDir, 'preview-runtime'),
    worktreeRoot: path.join(scenario.rootDir, 'worktrees')
  });
  try {
    await reopened.init();
    const restored = await reopened.getApplicationPreview({ taskId: task.id });
    expect(restored.status?.active).toBeUndefined();
    const instances = await reopened.listApplicationPreviews();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ taskId: task.id, approvalPending: false, status: { latest: { state: 'stopped' } } });
    expect(instances.some(instance => instance.taskId === unstartedTask.id)).toBe(false);
    const inspection = await reopened.inspectApplicationPreviewConfiguration({
      taskId: task.id, attemptId: restored.status!.latest!.id, changes: []
    });
    expect(inspection.inspection?.error).toBeUndefined();
    const pending = await reopened.connectApplicationPreviewSource({
      taskId: task.id, attemptId: restored.status!.latest!.id, service: 'docs', directory: extra,
      expected: { active: null, candidate: null, latest: restored.status!.latest!.id }
    });
    const candidateId = pending.status!.candidate!.id;
    await expect.poll(async () => {
      const current = await reopened.getApplicationPreview({ taskId: task.id });
      return current.approval?.attemptId ?? current.status?.latest?.error?.code;
    }).toBe(candidateId);
    await reopened.approveApplicationPreview({ taskId: task.id, attemptId: candidateId });
    await expect.poll(async () => (await reopened.getApplicationPreview({ taskId: task.id })).status?.active?.id).toBe(candidateId);
    const ready = (await reopened.getApplicationPreview({ taskId: task.id })).status!;
    expect(await (await fetch(ready.url!)).text()).toContain('primary source');
    const docs = new URL(ready.active!.services!.docs!.browserUrl!);
    const connected = await new Promise<string>((resolve, reject) => {
      http.get(ready.url!, { headers: { host: docs.host } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(body));
        response.on('error', reject);
      }).on('error', reject);
    });
    expect(connected).toContain('connected source');
  } finally {
    await reopened.shutdown();
    await persistence.close();
  }
}, 20_000);
