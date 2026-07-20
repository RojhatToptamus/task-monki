import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewRecipeGenerationService } from '../preview/generation/PreviewRecipeGenerationService';
import { PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION } from '../preview/generation/PreviewRecipeGenerationSupport';
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

describe('TaskManagerService Preview recipe generation', () => {
  it('projects missing setup, emits transient progress, and only resolves after explicit acceptance', async () => {
    const generator = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(JSON.stringify({
        schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
        status: 'draft',
        yaml: `version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
`,
        summary: 'Runs the proven server entry point.',
        evidence: [
          { path: 'package.json', finding: 'The dev script runs node server.mjs.' },
          { path: 'server.mjs', finding: 'The server listens on the injected PORT.' }
        ],
        assumptions: [],
        omissions: ['No HTTP health endpoint was evidenced.'],
        unresolvedDecisions: [],
        publicEnvironmentDecisions: []
      })),
      cancel: async () => {}
    }));
    const scenario = await createTaskMonkiScenario({
      name: 'preview-recipe-generation-service',
      previewEnabled: true,
      previewRecipeGenerator: generator
    });
    scenarios.push(scenario);
    await scenario.commitFile(
      'package.json',
      JSON.stringify({ scripts: { dev: 'node server.mjs' } })
    );
    await scenario.commitFile(
      'server.mjs',
      'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n'
    );
    const task = await scenario.createTask({ title: 'Generate Preview recipe' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const generationStatuses: string[] = [];
    const unsubscribe = scenario.events.on((event) => {
      if (event.type === 'preview.recipe-generation.updated') {
        generationStatuses.push((event.payload as { status: string }).status);
      }
    });

    await expect(scenario.service.resolvePreview({ taskId: task.id })).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      reasonCode: 'RECIPE_MISSING'
    });
    const generated = await scenario.service.generatePreviewRecipe({ taskId: task.id });
    expect(generated.status).toBe('READY');
    await expect(
      fs.access(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'))
    ).rejects.toThrow();
    expect((await scenario.store.snapshot()).previewPlans).toEqual([]);

    const accepted = await scenario.service.acceptPreviewRecipeDraft({
      taskId: task.id,
      draftId: generated.draft!.id,
      yaml: generated.draft!.yaml
    });

    expect(accepted).toMatchObject({
      recipePath: '.taskmonki/preview.yaml',
      resolution: { status: 'PLAN' }
    });
    expect(await fs.readFile(
      path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'),
      'utf8'
    )).toBe(generated.draft!.yaml);
    const snapshot = await scenario.store.snapshot();
    expect(snapshot.previewPlans).toHaveLength(1);
    expect(snapshot.previewApprovals).toEqual([]);
    expect(snapshot.previewGenerations).toEqual([]);
    expect(generationStatuses).toEqual([
      'GENERATING',
      'GENERATING',
      'GENERATING',
      'READY',
      'EMPTY'
    ]);
    unsubscribe();
  });
});
