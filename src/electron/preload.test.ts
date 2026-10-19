import { describe, expect, it, vi } from 'vitest';
import type { TaskManagerApi } from '../shared/contracts';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api)
  },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }
}));

import './preload';

describe('preload IPC', () => {
  it('rejects renderer calls with the handler message, not Electron remote-method text', async () => {
    const api = electron.exposed.get('taskManager') as TaskManagerApi;
    // What Electron gives the renderer when a main-process handler throws.
    electron.invoke
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'github:refresh': RemoteWorkError: GitHub CLI is not signed in to github.com."
      ))
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'settings:get': Error: ENOENT: no such file or directory, open '/data/settings.json'"
      ))
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'settings:tools:status': TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received undefined"
      ));

    await expect(api.refreshGitHub({ taskId: 'task-1' }))
      .rejects.toEqual(new Error('GitHub CLI is not signed in to github.com.'));
    await expect(api.getAppSettings())
      .rejects.toEqual(new Error("ENOENT: no such file or directory, open '/data/settings.json'"));
    await expect(api.getExternalToolStatus())
      .rejects.toEqual(new Error('The "path" argument must be of type string. Received undefined'));
  });
});
