import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewRecipeGenerationService } from '../preview/generation/PreviewRecipeGenerationService';
import { PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION } from '../preview/generation/PreviewRecipeGenerationSupport';
import {
  TaskMonkiScenarioRegistry
} from '../../testSupport/taskMonkiScenario';

const scenarioRegistry = new TaskMonkiScenarioRegistry();
const createTaskMonkiScenario = scenarioRegistry.create.bind(scenarioRegistry);

afterEach(async () => {
  await scenarioRegistry.dispose();
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

  it('uses the configured capable runtime and exact model without a Codex fallback', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'preview-recipe-generation-configured-runtime',
      previewEnabled: true
    });
    await scenario.commitFile(
      'package.json',
      JSON.stringify({ scripts: { dev: 'node server.mjs' } })
    );
    await scenario.commitFile(
      'server.mjs',
      'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n'
    );
    const task = await scenario.createTask({ title: 'Generate Preview recipe' });
    await scenario.service.prepareWorktree({ taskId: task.id });
    const internals = scenario.service as unknown as {
      appSettings: Record<string, unknown>;
    };
    internals.appSettings = {
      ...internals.appSettings,
      previewRecipeGenerationRuntimeId: scenario.agent.descriptor.id,
      previewRecipeGenerationModel: 'chosen-preview-model',
      previewRecipeGenerationModelProvider: 'chosen-provider'
    };
    scenario.agent.nextRuntimeTurnResult = {
      status: 'completed',
      output: JSON.stringify({
        schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
        status: 'insufficient-evidence',
        yaml: null,
        summary: 'The selected model inspected the bounded repository evidence.',
        evidence: [],
        assumptions: [],
        omissions: [],
        unresolvedDecisions: ['This fixture does not return a complete recipe.'],
        publicEnvironmentDecisions: []
      })
    };
    const resolveExecution = vi.spyOn(scenario.agent, 'resolveExecution');

    await expect(
      scenario.service.generatePreviewRecipe({ taskId: task.id })
    ).resolves.toMatchObject({ status: 'NEEDS_INPUT' });
    expect(resolveExecution).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        runtimeId: scenario.agent.descriptor.id,
        model: 'chosen-preview-model',
        modelProvider: 'chosen-provider'
      }),
      attachments: []
    });
    expect(scenario.agent.startedRuntimeTurns).toHaveLength(1);
    expect(scenario.agent.startedRuntimeTurns[0]?.run.purpose).toBe(
      'PREVIEW_RECIPE_GENERATION'
    );
    expect(scenario.agent.startedRuntimeTurns[0]?.attachments).toEqual([]);
  });

  it('shows the configured runtime error without starting another provider', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'preview-recipe-generation-disabled-runtime',
      previewEnabled: true
    });
    const task = await scenario.createTask({ title: 'Generate Preview recipe' });
    await scenario.service.prepareWorktree({ taskId: task.id });
    const internals = scenario.service as unknown as {
      appSettings: Record<string, unknown>;
    };
    internals.appSettings = {
      ...internals.appSettings,
      previewRecipeGenerationRuntimeId: scenario.agent.descriptor.id,
      disabledRuntimeIds: [scenario.agent.descriptor.id]
    };

    await expect(
      scenario.service.generatePreviewRecipe({ taskId: task.id })
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'AGENT_UNAVAILABLE',
      message: expect.stringContaining('disabled')
    });
    expect(scenario.agent.startedRuntimeTurns).toHaveLength(0);
  });

  it('blocks retry and deletion while an earlier Preview generation stop is uncertain', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'preview-recipe-generation-uncertain-recovery',
      previewEnabled: true
    });
    const task = await scenario.createTask({ title: 'Recover Preview generation' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    scenario.agent.ambiguousRuntimeInterrupt = true;
    const internals = scenario.service as unknown as {
      startPreviewRecipeGenerationRuntimeTurn(input: {
        taskId: string;
        generationId: string;
        cwd: string;
        instruction: string;
      }): Promise<{ result: Promise<string>; cancel(): Promise<void> }>;
    };
    const abandoned = await internals.startPreviewRecipeGenerationRuntimeTurn({
      taskId: task.id,
      generationId: 'uncertain-generation',
      cwd: worktree.worktreePath,
      instruction: 'Return one Preview recipe envelope.'
    });
    void abandoned.result.catch(() => undefined);

    await expect(abandoned.cancel()).rejects.toThrow(
      'could not confirm that Preview recipe generation stopped'
    );
    await expect(
      scenario.service.generatePreviewRecipe({ taskId: task.id })
    ).rejects.toThrow('still recovering');
    await expect(
      scenario.service.deleteTask({ taskId: task.id })
    ).rejects.toThrow('still recovering');

    expect(
      (await scenario.runtimeStore.snapshot()).runs.some(
        (candidate) => candidate.owner.kind === 'PREVIEW_RECIPE_GENERATION'
      )
    ).toBe(true);
  });
});
