import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignDetailSnapshot, PreviewGenerationRecord } from '../../shared/contracts';
import { codexCapabilities } from '../agent/codex/codexCapabilities';
import {
  createTaskMonkiScenario,
  type TaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';

const scenarios: TaskMonkiScenario[] = [];

afterEach(async () => {
  await Promise.allSettled(
    scenarios.splice(0).map(async (scenario) => {
      await scenario.service.shutdown().catch(() => undefined);
      await fs.rm(scenario.rootDir, { recursive: true, force: true });
    })
  );
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('TaskManagerService Design vertical slice', () => {
  it('fails before Design creation when scoped skill access is unavailable', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-skills-unavailable',
      previewEnabled: true,
      designMode: true
    });
    scenarios.push(scenario);
    vi.spyOn(scenario.agent, 'capabilities').mockResolvedValue(
      codexCapabilities({
        designSkillAccess: { available: false, detail: 'Skill pack is invalid.' }
      })
    );

    await expect(
      scenario.service.createBlankDesign({
        brief: 'Create a compact status page.',
        creationToken: 'design-skills-unavailable'
      })
    ).rejects.toThrow('cannot apply Design instructions and skills safely');
    await expect(scenario.service.listDesigns()).resolves.toEqual([]);
  });

  it('creates, refines, keeps no-change history compact, and preserves the last ready preview on failure', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-vertical',
      previewEnabled: true,
      designMode: true
    });
    scenarios.push(scenario);

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small status page with a clear launch button.',
      creationToken: 'design-vertical-create'
    });
    expect(detail.task.kind).toBe('DESIGN');
    expect(detail.currentRun?.mode).toBe('DESIGN');
    expect(scenario.agent.startedTurns[0]).toMatchObject({
      mode: 'DESIGN',
      instructionProfile: 'DESIGN'
    });

    const worktreePath = requireWorktreePath(detail);
    await fs.writeFile(
      path.join(worktreePath, 'index.html'),
      '<!doctype html><title>First design</title><button>Launch</button>',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The first design is ready.');
    detail = await waitForDesign(scenario, detail.design.id, (candidate) =>
      candidate.revisions.length === 1 && candidate.canvas.state === 'READY'
    );
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('First design');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-refine',
      message: 'Change the title to Refined design.'
    });
    expect(scenario.agent.startedTurns).toHaveLength(2);
    expect(scenario.agent.startedTurns[1].session.localSessionId).toBe(
      scenario.agent.startedTurns[0].session.localSessionId
    );
    await fs.writeFile(
      path.join(worktreePath, 'index.html'),
      '<!doctype html><title>Refined design</title><button>Launch now</button>',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The refinement is ready.');
    detail = await waitForDesign(scenario, detail.design.id, (candidate) =>
      candidate.revisions.length === 2 && candidate.canvas.state === 'READY'
    );
    const lastReadyRevisionId = detail.revisions.at(-1)!.id;
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('Refined design');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-no-change',
      message: 'Keep the result exactly as it is.'
    });
    await scenario.completeRun(requireRunId(detail), 'No source change was needed.');
    detail = await waitForDesign(scenario, detail.design.id, (candidate) =>
      candidate.turns.at(-1)?.outcome === 'NO_CHANGE'
    );
    expect(detail.revisions).toHaveLength(2);

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-failure',
      message: 'Remove the page entry point.'
    });
    await fs.rm(path.join(worktreePath, 'index.html'));
    await scenario.completeRun(requireRunId(detail), 'The entry point was removed.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.turns.at(-1)?.outcome === 'NEEDS_ATTENTION',
      25_000
    );
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions.at(-1)?.id).toBe(lastReadyRevisionId);
    expect(detail.currentPreview?.source).toMatchObject({
      type: 'EXACT_COMMIT',
      designRevisionId: lastReadyRevisionId
    });
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('Refined design');

    const repositoryPath = detail.repository.path;
    await expect(
      scenario.service.deleteTask({ taskId: detail.design.id, removeWorktree: true })
    ).resolves.toMatchObject({ taskId: detail.design.id, removedWorktree: true });
    await expect(scenario.service.listDesigns()).resolves.toEqual([]);
    await expect(fs.stat(repositoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45_000);

  it('does not delete a Design while its Preview restart is running', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-restart-delete',
      previewEnabled: true,
      designMode: true
    });
    scenarios.push(scenario);

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small status page.',
      creationToken: 'design-restart-delete'
    });
    await fs.writeFile(
      path.join(requireWorktreePath(detail), 'index.html'),
      '<!doctype html><title>Ready design</title>',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The Design is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.canvas.state === 'READY'
    );

    const restartEntered = deferred<void>();
    const releaseRestart = deferred<void>();
    const internals = scenario.service as unknown as {
      previews: {
        restartManagedDesign(): Promise<PreviewGenerationRecord>;
        stopTask(taskId: string): Promise<void>;
      };
      designUpdates: {
        withExclusiveAccess<T>(designId: string, operation: () => Promise<T>): Promise<T>;
      };
      taskActionLocks: Map<string, unknown>;
    };
    const restartPreview = vi
      .spyOn(internals.previews, 'restartManagedDesign')
      .mockImplementation(async () => {
        restartEntered.resolve();
        await releaseRestart.promise;
        return requireActivePreview(detail);
      });

    const restart = scenario.service.restartDesignPreview({
      designId: detail.design.id
    });
    await restartEntered.promise;
    try {
      await expect(
        scenario.service.deleteTask({ taskId: detail.design.id, removeWorktree: true })
      ).rejects.toThrow('Design Preview restart is already running');
      await expect(scenario.service.getDesign(detail.design.id)).resolves.toMatchObject({
        design: { id: detail.design.id },
        currentWorktree: { status: 'PRESENT' }
      });
    } finally {
      releaseRestart.resolve();
      await restart;
      restartPreview.mockRestore();
    }

    const coordinatorEntered = deferred<void>();
    const releaseCoordinator = deferred<void>();
    const coordinatorWork = internals.designUpdates.withExclusiveAccess(
      detail.design.id,
      async () => {
        coordinatorEntered.resolve();
        await releaseCoordinator.promise;
      }
    );
    await coordinatorEntered.promise;
    const stopPreview = vi.spyOn(internals.previews, 'stopTask');
    const deletion = scenario.service.deleteTask({
      taskId: detail.design.id,
      removeWorktree: true
    });
    expect(internals.taskActionLocks.has(detail.design.id)).toBe(true);
    expect(stopPreview).not.toHaveBeenCalled();

    releaseCoordinator.resolve();
    await coordinatorWork;
    await expect(deletion).resolves.toMatchObject({
      taskId: detail.design.id,
      removedWorktree: true
    });
    stopPreview.mockRestore();
  }, 30_000);
});

function requireRunId(detail: DesignDetailSnapshot): string {
  if (!detail.currentRun) throw new Error('Design run is missing.');
  return detail.currentRun.id;
}

function requireWorktreePath(detail: DesignDetailSnapshot): string {
  if (!detail.currentWorktree) throw new Error('Design worktree is missing.');
  return detail.currentWorktree.worktreePath;
}

function requireActivePreview(detail: DesignDetailSnapshot): PreviewGenerationRecord {
  if (
    !detail.currentPreview ||
    detail.currentPreview.state !== 'READY' ||
    detail.currentPreview.routingState !== 'ACTIVE'
  ) {
    throw new Error('Ready Design preview is missing.');
  }
  return detail.currentPreview;
}

async function waitForDesign(
  scenario: TaskMonkiScenario,
  designId: string,
  predicate: (detail: DesignDetailSnapshot) => boolean,
  timeoutMs = 10_000
): Promise<DesignDetailSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let detail = await scenario.service.getDesign(designId);
  while (!predicate(detail)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Design state: ${JSON.stringify(detail.design)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    detail = await scenario.service.getDesign(designId);
  }
  return detail;
}

function requestActiveRoute(generation: PreviewGenerationRecord): Promise<string> {
  const route = generation.routes.find((candidate) => candidate.state === 'ATTACHED');
  if (!route) throw new Error('Active Preview route is missing.');
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: route.gatewayPort,
        path: '/',
        headers: { host: route.hostname }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            reject(new Error(`Preview returned ${response.statusCode}: ${body}`));
            return;
          }
          resolve(body);
        });
      }
    );
    request.on('error', reject);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
