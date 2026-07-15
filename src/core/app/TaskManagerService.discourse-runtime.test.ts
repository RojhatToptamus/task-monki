import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedAgentProviderAdapter } from '../../testSupport/taskMonkiScenario';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../storage/FileDiscourseStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService discourse runtime composition', () => {
  it('requires the runtime and discourse stores as one capability boundary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-composition-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));

    expect(
      () =>
        new TaskManagerService(taskStore, root, undefined, {
          agentRuntimeStore: new FileAgentRuntimeStore(path.join(root, 'runtime'))
        })
    ).toThrow('must be configured together');
  });

  it('recovers a clean shutdown latch on startup and latches before closing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lifecycle-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));
    const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
    const discourseStore = new FileDiscourseStore(path.join(root, 'discourse'));
    await runtimeStore.init();
    await runtimeStore.setShutdownLatched(true, 'previous-process-shutdown');

    const service = new TaskManagerService(taskStore, root, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(taskStore),
      agentRuntimeStore: runtimeStore,
      discourseStore
    });

    await service.init();
    expect((await runtimeStore.snapshot()).shutdownLatched).toBe(false);

    await service.shutdown();
    expect((await runtimeStore.snapshot()).shutdownLatched).toBe(true);
  });
});
