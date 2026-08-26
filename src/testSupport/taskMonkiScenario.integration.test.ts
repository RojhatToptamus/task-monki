import fs from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  createTaskMonkiScenario,
  TaskMonkiScenarioRegistry
} from './taskMonkiScenario';

describe('Task Monki scenario ownership', () => {
  it('shuts down and removes its exact temporary root idempotently', async () => {
    const scenario = await createTaskMonkiScenario({ name: 'scenario-disposal' });
    await expect(fs.access(scenario.rootDir)).resolves.toBeUndefined();

    await Promise.all([scenario.dispose(), scenario.dispose()]);

    await expect(fs.access(scenario.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('disposes every scenario registered by a suite', async () => {
    const registry = new TaskMonkiScenarioRegistry();
    const first = await registry.create({ name: 'scenario-registry-first' });
    const second = await registry.create({ name: 'scenario-registry-second' });

    await registry.dispose();
    await registry.dispose();

    await expect(fs.access(first.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(second.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes its temporary root when construction fails', async () => {
    const name = 'scenario-partial-construction';
    const entriesBefore = new Set(await fs.readdir(os.tmpdir()));
    const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
      new Error('injected repository creation failure')
    );

    try {
      await expect(createTaskMonkiScenario({ name })).rejects.toThrow(
        'injected repository creation failure'
      );
    } finally {
      mkdir.mockRestore();
    }

    const leakedRoots = (await fs.readdir(os.tmpdir())).filter(
      (entry) => entry.startsWith(`${name}-`) && !entriesBefore.has(entry)
    );
    expect(leakedRoots).toEqual([]);
  });
});
