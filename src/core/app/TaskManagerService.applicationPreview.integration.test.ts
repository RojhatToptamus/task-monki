import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import {
  createScriptedAgentRuntimeFixture,
  TaskMonkiScenarioRegistry
} from '../../testSupport/taskMonkiScenario';
import { AppEventBus } from '../runner/AppEventBus';
import { TaskManagerService } from './TaskManagerService';
import { createNodeOpenTargetHost } from '../open/OpenTargetService';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

it('retains source ownership across restart, replacement, and desktop opening', async () => {
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
  await scenario.service.startApplicationPreview({ taskId: task.id });
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
  const toolDirectory = path.join(scenario.rootDir, 'test-bin');
  const editor = path.join(toolDirectory, process.platform === 'win32' ? 'code.EXE' : 'code');
  const openDefault = vi.fn(async (_directory: string) => {});
  const launchExecutable = vi.fn(async (_executable: string, _argv: string[], _cwd?: string) => {});
  const reopened = new TaskManagerService(persistence.tasks, scenario.repositoryPath, new AppEventBus(), {
    ...runtime.serviceOptions,
    openTargetHost: {
      ...createNodeOpenTargetHost(),
      env: { PATH: toolDirectory },
      access: async file => file === editor,
      openDefault,
      launchExecutable
    },
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
    const original = (await reopened.readApplicationPreviewFile({ taskId: task.id })).file!;
    const config = JSON.parse(original.text);
    config.services.docs.directory = extra;
    await reopened.saveApplicationPreviewFile({ taskId: task.id, original, text: JSON.stringify(config) });
    const connectedFolders = await reopened.connectApplicationPreviewSource({
      taskId: task.id, attemptId: restored.status!.latest!.id, service: 'docs', directory: extra,
      expected: { active: null, candidate: null, latest: restored.status!.latest!.id }
    });
    expect(connectedFolders.status?.candidate).toBeUndefined();
    const pending = await reopened.startApplicationPreview({ taskId: task.id });
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

    const sourceIndex = ready.active!.sources.indexOf(await fs.realpath(extra));
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    const target = { type: 'previewSource' as const, taskId: task.id, attemptId: candidateId, sourceIndex };
    await expect(reopened.executeOpenTargetAction({ target, action: 'open', appId: 'default' }))
      .resolves.toEqual({ ok: true });
    expect(openDefault).toHaveBeenLastCalledWith(await fs.realpath(extra));
    await expect(reopened.inspectOpenTarget({ target })).resolves.toMatchObject({ canOpen: true, preferredAppId: 'vscode' });
    await expect(reopened.executeOpenTargetAction({ target, action: 'open', appId: 'vscode' }))
      .resolves.toEqual({ ok: true });
    expect(launchExecutable).toHaveBeenLastCalledWith(editor, [await fs.realpath(extra)], await fs.realpath(extra));

    const edited = (await reopened.readApplicationPreviewFile({ taskId: task.id })).file!;
    config.services.docs.directory = './public';
    await reopened.saveApplicationPreviewFile({ taskId: task.id, original: edited, text: JSON.stringify(config) });
    await reopened.startApplicationPreview({ taskId: task.id });
    await expect.poll(async () => (await reopened.getApplicationPreview({ taskId: task.id })).approval).toBeTruthy();
    const replacement = await reopened.getApplicationPreview({ taskId: task.id });
    await reopened.approveApplicationPreview({ taskId: task.id, attemptId: replacement.approval!.attemptId });
    await expect.poll(async () => (await reopened.getApplicationPreview({ taskId: task.id })).status?.active?.id)
      .toBe(replacement.approval!.attemptId);
    const replaced = (await reopened.getApplicationPreview({ taskId: task.id })).status!;
    expect(replaced.active!.sources).not.toContain(await fs.realpath(extra));
    const historical = replaced.history!.find(attempt => attempt.id === candidateId)!;
    expect(historical.state).toBe('stopped');
    await expect(reopened.executeOpenTargetAction({
      target: { ...target, attemptId: historical.id }, action: 'open', appId: 'default'
    })).resolves.toEqual({ ok: true });
    expect(openDefault).toHaveBeenLastCalledWith(await fs.realpath(extra));

    const otherWorktree = await prepareTestWorktree(reopened, unstartedTask.id);
    await fs.writeFile(path.join(otherWorktree.worktreePath, 'index.html'), 'other task');
    await reopened.saveApplicationPreviewFile({ taskId: unstartedTask.id, text: 'name: application\ntype: static\ndirectory: .\n' });
    expect((await reopened.getApplicationPreview({ taskId: unstartedTask.id })).approval).toBeUndefined();
    await reopened.startApplicationPreview({ taskId: unstartedTask.id });
    await expect.poll(async () => (await reopened.getApplicationPreview({ taskId: unstartedTask.id })).approval).toBeTruthy();
    const other = await reopened.getApplicationPreview({ taskId: unstartedTask.id });
    await reopened.approveApplicationPreview({ taskId: unstartedTask.id, attemptId: other.approval!.attemptId });
    await expect.poll(async () => (await reopened.getApplicationPreview({ taskId: unstartedTask.id })).status?.active?.state).toBe('ready');
    openDefault.mockClear();
    launchExecutable.mockClear();
    for (const invalid of [
      { ...target, taskId: unstartedTask.id },
      { ...target, attemptId: 'unrecorded-attempt' },
      { ...target, sourceIndex: -1 },
      { ...target, sourceIndex: 0.5 },
      { ...target, sourceIndex: ready.active!.sources.length }
    ]) {
      await expect(reopened.inspectOpenTarget({ target: invalid })).rejects.toThrow(/does not belong|source is unavailable/);
      await expect(reopened.executeOpenTargetAction({ target: invalid, action: 'open', appId: 'default' }))
        .resolves.toMatchObject({ ok: false, message: expect.stringMatching(/does not belong|source is unavailable/) });
    }
    expect(openDefault).not.toHaveBeenCalled();
    expect(launchExecutable).not.toHaveBeenCalled();

    await fs.rm(extra, { recursive: true });
    await expect(reopened.inspectOpenTarget({ target })).resolves.toMatchObject({
      target: { kind: 'missing' }, canOpen: false
    });
    await expect(reopened.executeOpenTargetAction({ target, action: 'open', appId: 'default' }))
      .resolves.toMatchObject({ ok: false, message: 'Path is missing.' });
    await fs.writeFile(extra, 'not a source directory');
    await expect(reopened.inspectOpenTarget({ target })).rejects.toThrow('no longer a folder');
    await expect(reopened.executeOpenTargetAction({ target, action: 'copyFileContents' }))
      .resolves.toMatchObject({ ok: false, message: 'The preview source is no longer a folder.' });
    expect(openDefault).not.toHaveBeenCalled();
  } finally {
    await reopened.shutdown();
    await persistence.close();
  }
}, 20_000);
