import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignDetailSnapshot, PreviewGenerationRecord } from '../../shared/contracts';
import { codexCapabilities } from '../agent/codex/codexCapabilities';
import { git } from '../git/gitCli';
import {
  TaskMonkiScenarioRegistry,
  type TaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';

const scenarioRegistry = new TaskMonkiScenarioRegistry();
const createTaskMonkiScenario = scenarioRegistry.create.bind(scenarioRegistry);

afterEach(async () => {
  await scenarioRegistry.dispose();
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('TaskManagerService Design vertical slice', () => {
  it('uses the provider approval-free write policy for Design work', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-autonomous-policy',
      previewEnabled: true,
      designMode: true
    });
    const capabilities = codexCapabilities();
    vi.spyOn(scenario.agent, 'capabilities').mockResolvedValue({
      ...capabilities,
      executionPolicy: {
        ...capabilities.executionPolicy,
        defaultPresetId: 'ask-for-approval'
      }
    });

    const detail = await scenario.service.createBlankDesign({
      brief: 'Create a small product page.',
      creationToken: 'design-autonomous-policy-create',
      runtimeId: 'codex'
    });

    expect(detail.task.agentSettings).toMatchObject({
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never',
      networkAccess: false
    });
  });

  it('shows a checked candidate while the last Ready route stays available', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-canvas-progress',
      previewEnabled: true,
      designMode: true
    });

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small product page.',
      creationToken: 'design-canvas-progress-create',
      runtimeId: 'codex'
    });
    const worktreePath = requireWorktreePath(detail);
    expect(
      (await fs.readdir(worktreePath)).sort()
    ).toEqual(['.git', 'app.js', 'assets', 'index.html', 'styles.css']);
    await fs.writeFile(
      path.join(worktreePath, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="./styles.css"><title>Ready design</title><main><img src="./assets/mark.svg" alt=""><h1>Ready design</h1></main><script src="./app.js" defer></script>',
      'utf8'
    );
    await fs.writeFile(path.join(worktreePath, 'styles.css'), 'body { color: navy; }\n', 'utf8');
    await fs.writeFile(
      path.join(worktreePath, 'app.js'),
      'document.body.dataset.state = "ready";\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(worktreePath, 'assets', 'mark.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The first page is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.canvas.state === 'READY'
    );
    const ready = requireActivePreview(detail);
    expect(await requestActiveRoute(ready, '/styles.css')).toContain('color: navy');
    expect(await requestActiveRoute(ready, '/app.js')).toContain('state = "ready"');
    expect(await requestActiveRoute(ready, '/assets/mark.svg')).toContain('<svg');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-canvas-progress-refine',
      message: 'Change only the page color.',
      referenceIds: []
    });
    await fs.writeFile(
      path.join(worktreePath, 'styles.css'),
      'body { color: royalblue; }\n',
      'utf8'
    );
    const designUpdates = (
      scenario.service as unknown as {
        designUpdates: {
          inspectDesign(input: {
            runId: string;
            operation: { operation: 'open_candidate' };
          }): Promise<unknown>;
        };
      }
    ).designUpdates;
    await designUpdates.inspectDesign({
      runId: requireRunId(detail),
      operation: { operation: 'open_candidate' }
    });

    detail = await scenario.service.getDesign(detail.design.id);
    expect(detail.canvas).toMatchObject({ state: 'PREVIEWING' });
    expect(detail.revisions).toHaveLength(1);
    expect(detail.currentPreview?.id).toBe(ready.id);
    const firstProgress = await scenario.service.resolveDesignCanvasRoute({
      taskId: detail.design.id,
      generationId: detail.canvas.target!.generationId,
      routeId: detail.canvas.target!.routeId
    });
    expect(await requestResolvedRoute(firstProgress)).toContain('Ready design');
    expect(await requestResolvedRoute(firstProgress, '/styles.css')).toContain('royalblue');
    expect(await requestActiveRoute(ready, '/styles.css')).toContain('color: navy');
    await expect(
      scenario.service.openPreview({
        taskId: detail.design.id,
        generationId: detail.canvas.target!.generationId,
        routeId: detail.canvas.target!.routeId
      })
    ).rejects.toThrow('not available for a Design');

    await fs.writeFile(
      path.join(worktreePath, 'styles.css'),
      'body { color: cornflowerblue; }\n',
      'utf8'
    );
    await designUpdates.inspectDesign({
      runId: requireRunId(detail),
      operation: { operation: 'open_candidate' }
    });
    detail = await scenario.service.getDesign(detail.design.id);
    const finalProgress = await scenario.service.resolveDesignCanvasRoute({
      taskId: detail.design.id,
      generationId: detail.canvas.target!.generationId,
      routeId: detail.canvas.target!.routeId
    });
    expect(finalProgress.generationId).not.toBe(firstProgress.generationId);
    expect(await requestResolvedRoute(finalProgress, '/styles.css')).toContain(
      'cornflowerblue'
    );
    await expect(requestResolvedRoute(firstProgress)).rejects.toThrow('503');
    expect(await requestActiveRoute(ready, '/styles.css')).toContain('color: navy');

    await scenario.completeRun(requireRunId(detail), 'The CSS refinement is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.revisions.length === 2 && candidate.canvas.state === 'READY'
    );
    expect(await requestActiveRoute(requireActivePreview(detail), '/styles.css')).toContain(
      'cornflowerblue'
    );
    await expect(requestResolvedRoute(finalProgress)).rejects.toThrow('503');

    const cssReady = requireActivePreview(detail);
    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-canvas-progress-script-refine',
      message: 'Change only the page behavior.',
      referenceIds: []
    });
    await fs.writeFile(
      path.join(worktreePath, 'app.js'),
      'document.body.dataset.state = "refined";\n',
      'utf8'
    );
    await designUpdates.inspectDesign({
      runId: requireRunId(detail),
      operation: { operation: 'open_candidate' }
    });
    detail = await scenario.service.getDesign(detail.design.id);
    const scriptProgress = await scenario.service.resolveDesignCanvasRoute({
      taskId: detail.design.id,
      generationId: detail.canvas.target!.generationId,
      routeId: detail.canvas.target!.routeId
    });
    expect(await requestResolvedRoute(scriptProgress, '/app.js')).toContain('state = "refined"');
    expect(await requestActiveRoute(cssReady, '/app.js')).toContain('state = "ready"');

    await scenario.completeRun(requireRunId(detail), 'The JavaScript refinement is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.revisions.length === 3 && candidate.canvas.state === 'READY'
    );
    expect(await requestActiveRoute(requireActivePreview(detail), '/app.js')).toContain(
      'state = "refined"'
    );
    expect(await requestActiveRoute(requireActivePreview(detail), '/styles.css')).toContain(
      'cornflowerblue'
    );
  }, 45_000);

  it('fails before Design creation when scoped skill access is unavailable', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-skills-unavailable',
      previewEnabled: true,
      designMode: true
    });
    vi.spyOn(scenario.agent, 'capabilities').mockResolvedValue(
      codexCapabilities({
        designSkillAccess: { available: false, detail: 'Skill pack is invalid.' }
      })
    );

    await expect(
      scenario.service.createBlankDesign({
        brief: 'Create a compact status page.',
        creationToken: 'design-skills-unavailable',
        runtimeId: 'codex'
      })
    ).rejects.toThrow('cannot apply Design instructions and skills safely');
    await expect(scenario.service.listDesigns()).resolves.toEqual([]);
  });

  it('fails before repository creation when the selected model cannot run Design Mode', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-model-unsupported',
      previewEnabled: true,
      designMode: true
    });
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/unsupported-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'unsupported-model',
        displayName: 'Unsupported model',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        designSupport: {
          maturity: 'unsupported',
          detail: 'This model does not report the image and tool capabilities required by Design Mode.'
        },
        isDefault: true
      }
    ]);
    const prepareBlankRepository = vi.spyOn(
      (
        scenario.service as unknown as {
          designSource: { prepareBlankRepository(input: unknown): Promise<unknown> };
        }
      ).designSource,
      'prepareBlankRepository'
    );

    await expect(
      scenario.service.createBlankDesign({
        brief: 'Create a compact status page.',
        creationToken: 'design-model-unsupported',
        runtimeId: 'codex',
        model: 'unsupported-model'
      })
    ).rejects.toThrow(
      'This model does not report the image and tool capabilities required by Design Mode.'
    );
    expect(prepareBlankRepository).not.toHaveBeenCalled();
    await expect(scenario.service.listDesigns()).resolves.toEqual([]);
  });

  it('uses the supported model Design reasoning default', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-reasoning-default',
      previewEnabled: true,
      designMode: true
    });
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/design-low-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'design-low-model',
        displayName: 'Design low model',
        hidden: false,
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        designSupport: {
          maturity: 'stable',
          defaultReasoningEffort: 'low'
        },
        isDefault: true
      }
    ]);

    const detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact status page.',
      creationToken: 'design-reasoning-default',
      runtimeId: 'codex',
      model: 'design-low-model'
    });

    const stored = (await scenario.store.snapshot()).tasks.find(
      (task) => task.id === detail.design.id
    );
    expect(stored?.agentSettings.reasoningEffort).toBe('low');
    expect(scenario.agent.startedTurns[0]?.settings?.reasoningEffort).toBe('low');
  });

  it('lets the Design acceptance harness run a candidate with unreported capabilities', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-model-candidate-qualification',
      previewEnabled: true,
      designMode: true,
      allowCandidateDesignModels: true
    });
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/candidate-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'candidate-model',
        displayName: 'Candidate model',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text'],
        designSupport: {
          maturity: 'unsupported',
          detail: 'This candidate model has not reported Design capabilities.'
        },
        isDefault: true
      }
    ]);

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact status page.',
      creationToken: 'design-model-candidate-qualification',
      runtimeId: 'codex',
      model: 'candidate-model'
    });
    expect(scenario.agent.startedTurns).toHaveLength(1);
    expect(scenario.agent.startedTurns[0]!.settings!.model).toBe('candidate-model');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-model-candidate-qualification-queued',
      message: 'Make the page more spacious.',
      referenceIds: []
    });
    expect(detail.turns.at(-1)?.runId).toBeUndefined();

    await scenario.completeRun(detail.turns[0]!.runId!, 'The first page is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.turns.at(-1)?.runId !== undefined
    );
    expect(detail.turns.at(-1)?.failureReason).toBeUndefined();
    expect(scenario.agent.startedTurns).toHaveLength(2);
    expect(scenario.agent.startedTurns[1]!.settings!.model).toBe('candidate-model');
  }, 15_000);

  it('does not accept a later Design turn after model capability support is withdrawn', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-model-qualification-drift',
      previewEnabled: true,
      designMode: true
    });
    const detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact status page.',
      creationToken: 'design-model-qualification-drift',
      runtimeId: 'codex',
      model: 'scenario-model'
    });
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/scenario-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'scenario-model',
        displayName: 'Scenario model',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        designSupport: {
          maturity: 'unsupported',
          detail: 'This model no longer reports the required Design capabilities.'
        },
        isDefault: true
      }
    ]);

    await expect(
      scenario.service.submitDesignTurn({
        designId: detail.design.id,
        clientMessageId: 'design-model-qualification-drift-turn',
        message: 'Make the page more spacious.',
        referenceIds: []
      })
    ).rejects.toThrow('This model no longer reports the required Design capabilities.');
    expect((await scenario.service.getDesign(detail.design.id)).turns).toHaveLength(1);
  });

  it('does not dispatch a queued Design turn after model capability support is withdrawn', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-queued-qualification-drift',
      previewEnabled: true,
      designMode: true
    });
    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact status page.',
      creationToken: 'design-queued-qualification-drift',
      runtimeId: 'codex',
      model: 'scenario-model'
    });
    const queuedInput = {
      designId: detail.design.id,
      clientMessageId: 'design-queued-qualification-drift-turn',
      message: 'Make the page more spacious.',
      referenceIds: []
    };
    detail = await scenario.service.submitDesignTurn(queuedInput);
    expect(detail.turns.at(-1)?.outcome).toBeUndefined();
    expect(detail.turns.at(-1)?.runId).toBeUndefined();
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/scenario-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'scenario-model',
        displayName: 'Scenario model',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        designSupport: {
          maturity: 'unsupported',
          detail: 'This queued model no longer reports the required Design capabilities.'
        },
        isDefault: true
      }
    ]);

    const retry = await scenario.service.submitDesignTurn(queuedInput);
    expect(retry.turns).toHaveLength(2);
    expect(retry.turns.at(-1)?.id).toBe(detail.turns.at(-1)?.id);

    await scenario.completeRun(detail.turns[0]!.runId!, 'The first page is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.turns.at(-1)?.outcome === 'FAILED'
    );
    expect(detail.turns.at(-1)?.failureReason).toContain(
      'This queued model no longer reports the required Design capabilities.'
    );
    expect(scenario.agent.startedTurns).toHaveLength(1);
  }, 15_000);

  it('delivers adopted references with the first Design turn and preserves them on reopen', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-initial-references',
      previewEnabled: true,
      designMode: true
    });
    vi.spyOn(scenario.agent, 'listModels').mockResolvedValue([
      {
        id: 'codex:openai/scenario-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'scenario-model',
        displayName: 'Scenario model',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text', 'image'],
        designSupport: { maturity: 'stable' },
        isDefault: true
      }
    ]);
    const imageBytes = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    );
    const draft = await scenario.service.stageTaskAttachmentBatch({
      attachments: [
        {
          clientToken: 'design-initial-reference-image',
          displayName: 'layout.png',
          declaredMediaType: 'image/png',
          bytes: imageBytes.buffer
        },
        {
          clientToken: 'design-initial-reference-copy',
          displayName: 'copy.md',
          declaredMediaType: 'text/markdown',
          bytes: new TextEncoder().encode('# Keep the copy direct.').buffer
        }
      ]
    });

    const createInput = {
      brief: 'Create a product page from the supplied direction.',
      creationToken: 'design-initial-references-create',
      runtimeId: 'codex',
      model: 'scenario-model',
      reasoningEffort: 'medium',
      attachmentDraftId: draft.id
    };
    const detail = await scenario.service.createBlankDesign(createInput);
    const retry = await scenario.service.createBlankDesign(createInput);

    expect(retry.design.id).toBe(detail.design.id);
    expect(scenario.agent.startedTurns).toHaveLength(1);
    expect(detail.references).toHaveLength(2);
    expect(detail.references.every(({ state }) => state === 'ACTIVE')).toBe(true);
    expect(detail.conversation[0]?.turn.referenceIds).toEqual(
      detail.references.map(({ id }) => id)
    );
    expect(scenario.agent.startedTurns[0]?.attachments).toEqual([
      expect.objectContaining({ displayName: 'layout.png', kind: 'image' }),
      expect.objectContaining({ displayName: 'copy.md', kind: 'text' })
    ]);
    expect(scenario.agent.startedTurns[0]?.prompt).toContain('layout.png');
    expect(scenario.agent.startedTurns[0]?.prompt).toContain('copy.md');
    const worktreePath = requireWorktreePath(detail);
    expect(
      scenario.agent.startedTurns[0]?.attachments?.every(
        (attachment) => !attachment.path.startsWith(worktreePath)
      )
    ).toBe(true);
    expect(detail.task.agentSettings.networkAccess).toBe(false);

    const reopened = await scenario.service.getDesign(detail.design.id);
    expect(reopened.references).toEqual(detail.references);
    expect(reopened.attachments.map(({ displayName }) => displayName)).toEqual([
      'layout.png',
      'copy.md'
    ]);
  });

  it('creates, refines, keeps no-change history compact, and preserves the last ready preview on failure', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-vertical',
      previewEnabled: true,
      designMode: true
    });

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small status page with a clear launch button.',
      creationToken: 'design-vertical-create',
      runtimeId: 'codex'
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
    const firstReadyRevisionId = detail.revisions[0]!.id;
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('First design');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-refine',
      message: 'Change the title to Refined design.',
      referenceIds: []
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

    detail = await scenario.service.restartDesignPreview({
      designId: detail.design.id,
      revisionId: firstReadyRevisionId
    });
    expect(detail.revisions).toHaveLength(2);
    expect(detail.canvas.target?.revisionId).toBe(firstReadyRevisionId);
    expect(detail.actions).toMatchObject({
      canRefine: false,
      refineDisabledReason: 'Return to the current version before you send a change.'
    });
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('First design');
    await expect(fs.readFile(path.join(worktreePath, 'index.html'), 'utf8')).resolves.toContain(
      'Refined design'
    );

    detail = await scenario.service.restartDesignPreview({
      designId: detail.design.id,
      revisionId: lastReadyRevisionId
    });
    expect(detail.revisions).toHaveLength(2);
    expect(detail.canvas.target?.revisionId).toBe(lastReadyRevisionId);
    expect(detail.actions.canRefine).toBe(true);
    expect(await requestActiveRoute(requireActivePreview(detail))).toContain('Refined design');

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-no-change',
      message: 'Keep the result exactly as it is.',
      referenceIds: []
    });
    await scenario.completeRun(requireRunId(detail), 'No source change was needed.');
    detail = await waitForDesign(scenario, detail.design.id, (candidate) =>
      candidate.turns.at(-1)?.outcome === 'NO_CHANGE'
    );
    expect(detail.revisions).toHaveLength(2);

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-vertical-failure',
      message: 'Remove the page entry point.',
      referenceIds: []
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

  it('adds selected references, imports an editable asset, and keeps inactive provenance', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-references',
      previewEnabled: true,
      designMode: true
    });

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small editorial page.',
      creationToken: 'design-reference-service-create',
      runtimeId: 'codex',
      model: 'scenario-model',
      reasoningEffort: 'medium'
    });
    const worktreePath = requireWorktreePath(detail);
    await fs.writeFile(
      path.join(worktreePath, 'index.html'),
      '<!doctype html><title>Editorial page</title>',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The first page is ready.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.revisions.length === 1 && candidate.canvas.state === 'READY'
    );

    const referenceBytes = new TextEncoder().encode(
      ':root { --brand-accent: #765447; }\n'
    );
    const draft = await scenario.service.stageTaskAttachmentBatch({
      attachments: [{
        clientToken: 'design-service-reference-client',
        displayName: 'brand.css',
        declaredMediaType: 'text/css',
        bytes: referenceBytes.buffer
      }]
    });
    detail = await scenario.service.addDesignReferences({
      designId: detail.design.id,
      attachmentDraftId: draft.id
    });
    const reference = detail.references[0]!;
    expect(reference).toMatchObject({ role: 'REFERENCE', state: 'ACTIVE' });
    expect(detail.task.agentSettings).toMatchObject({
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never'
    });

    detail = await scenario.service.importDesignReferenceAsset({
      designId: detail.design.id,
      referenceId: reference.id
    });
    expect(detail.references[0]).toMatchObject({
      role: 'PROJECT_ASSET_SOURCE',
      projectAssetPath: 'assets/brand.css'
    });
    expect(detail.projectFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'assets/brand.css' }),
        expect.objectContaining({ path: 'index.html' })
      ])
    );

    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-reference-service-refine',
      message: 'Use the imported brand asset and make its accent warmer.',
      referenceIds: [reference.id]
    });
    expect(scenario.agent.startedTurns[1]?.attachments).toEqual([
      expect.objectContaining({
        attachmentId: reference.attachmentId,
        displayName: 'brand.css'
      })
    ]);
    expect(scenario.agent.startedTurns[1]?.attachments?.[0]?.path.startsWith(worktreePath)).toBe(
      false
    );
    expect(scenario.agent.startedTurns[1]?.prompt).toContain(
      'brand.css (editable project asset: assets/brand.css)'
    );
    await fs.writeFile(
      path.join(worktreePath, 'assets', 'brand.css'),
      ':root { --brand-accent: #a05f43; }\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(worktreePath, 'index.html'),
      '<!doctype html><title>Warm editorial page</title>',
      'utf8'
    );
    await scenario.completeRun(requireRunId(detail), 'The imported asset is now warmer.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.revisions.length === 2 && candidate.canvas.state === 'READY'
    );

    detail = await scenario.service.removeDesignReference({
      designId: detail.design.id,
      referenceId: reference.id
    });
    expect(detail.references[0]).toMatchObject({
      state: 'INACTIVE',
      projectAssetPath: 'assets/brand.css'
    });
    detail = await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-reference-service-without-reference',
      message: 'Keep the page unchanged.',
      referenceIds: []
    });
    expect(scenario.agent.startedTurns[2]?.attachments).toEqual([]);
    await scenario.completeRun(requireRunId(detail), 'No source change was needed.');
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => candidate.turns.at(-1)?.outcome === 'NO_CHANGE'
    );

    const reopened = await scenario.service.getDesign(detail.design.id);
    expect(reopened.attachments).toEqual([
      expect.objectContaining({ id: reference.attachmentId, displayName: 'brand.css' })
    ]);
    expect(reopened.references).toEqual([
      expect.objectContaining({
        id: reference.id,
        state: 'INACTIVE',
        projectAssetPath: 'assets/brand.css'
      })
    ]);
    expect(reopened.projectFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'assets/brand.css', byteCount: 35 })
      ])
    );
    const snapshot = await scenario.store.snapshot();
    expect(
      snapshot.agentSessions
        .filter((session) => session.taskId === detail.design.id)
        .every((session) => session.requestedSettings?.networkAccess === false)
    ).toBe(true);
    expect(
      snapshot.runs
        .filter((run) => run.taskId === detail.design.id)
        .every((run) => run.requestedSettings?.networkAccess === false)
    ).toBe(true);
  }, 45_000);

  it('queues follow-up messages, stops active work, and persists an unsent draft', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-long-conversation',
      previewEnabled: true,
      designMode: true
    });

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact reporting page.',
      creationToken: 'design-long-create',
      runtimeId: 'codex',
      model: 'scenario-model',
      reasoningEffort: 'medium'
    });
    const firstRun = detail.currentRun!;
    const attachmentDraft = await scenario.service.stageTaskAttachmentBatch({
      attachments: [{
        clientToken: 'design-long-queued-reference',
        displayName: 'queued-direction.txt',
        declaredMediaType: 'text/plain',
        bytes: new TextEncoder().encode('Make the queued update more spacious.').buffer
      }]
    });
    const draft = await scenario.service.saveDesignDraft({
      designId: detail.design.id,
      expectedRevision: 0,
      body: 'Try a less dense layout.',
      referenceIds: [],
      attachmentDraftId: attachmentDraft.id
    });
    const reopenedDraft = await scenario.service.getDesignDraft(detail.design.id);
    expect(reopenedDraft).toMatchObject({
      ...draft,
      attachmentDraft: {
        id: attachmentDraft.id,
        attachments: [expect.objectContaining({ displayName: 'queued-direction.txt' })]
      }
    });
    const stagedAttachment = reopenedDraft?.attachmentDraft?.attachments[0];
    if (!stagedAttachment) throw new Error('Saved Design draft attachment is missing.');
    const draftContent = await scenario.service.readDesignDraftAttachment({
      designId: detail.design.id,
      attachmentId: stagedAttachment.id
    });
    expect(new TextDecoder().decode(draftContent.bytes)).toBe(
      'Make the queued update more spacious.'
    );

    const resolveExecution = vi.spyOn(scenario.agent, 'resolveExecution');
    const queuedInput = {
      designId: detail.design.id,
      clientMessageId: 'design-long-queued',
      message: 'Use larger section headings.',
      referenceIds: [],
      attachmentDraftId: attachmentDraft.id
    };
    detail = await scenario.service.submitDesignTurn(queuedInput);
    const retry = await scenario.service.submitDesignTurn(queuedInput);
    expect(resolveExecution).toHaveBeenCalledTimes(1);
    expect(scenario.agent.startedTurns).toHaveLength(1);
    expect(retry.turns).toHaveLength(detail.turns.length);
    expect(detail.turns.at(-1)).toMatchObject({ order: 2 });
    expect(detail.turns.at(-1)?.attachmentDraftId).toBe(attachmentDraft.id);
    expect(detail.turns.at(-1)?.referenceIds).toHaveLength(1);
    expect(detail.turns.at(-1)).not.toHaveProperty('runId');
    const queuedReference = detail.references.find(
      (reference) => reference.sourceDraftId === attachmentDraft.id
    );
    expect(detail.turns.at(-1)?.referenceIds).toEqual([queuedReference?.id]);
    expect(detail.actions).toMatchObject({
      canRefine: true,
      queuedTurnCount: 1,
      canStop: true,
      stopTurnId: detail.turns[0]?.id
    });

    detail = await scenario.service.cancelDesignTurn({
      designId: detail.design.id,
      turnId: detail.turns[0]!.id
    });
    expect(detail.currentRun?.status).toBe('INTERRUPTED');
    scenario.events.emit({
      type: 'run.terminal',
      taskId: detail.design.id,
      iterationId: firstRun.iterationId,
      runId: firstRun.id,
      worktreeId: firstRun.worktreeId,
      payload: { status: 'INTERRUPTED' },
      at: new Date().toISOString()
    });
    detail = await waitForDesign(
      scenario,
      detail.design.id,
      (candidate) => scenario.agent.startedTurns.length === 2 && candidate.turns[1]?.runId !== undefined
    );
    expect(detail.turns[0]?.outcome).toBe('CANCELED');
    expect(detail.currentRun?.id).toBe(detail.turns[1]?.runId);
    expect(scenario.agent.startedTurns[1]).toMatchObject({
      mode: 'DESIGN',
      instructionProfile: 'DESIGN'
    });
    expect(scenario.agent.startedTurns[1]?.attachments).toEqual([
      expect.objectContaining({
        attachmentId: queuedReference?.attachmentId,
        displayName: 'queued-direction.txt'
      })
    ]);
    expect(scenario.agent.startedTurns[1]?.prompt).toContain('queued-direction.txt');

    await scenario.service.deleteDesignDraft({
      designId: detail.design.id,
      expectedRevision: draft.recordRevision
    });
    await expect(scenario.service.getDesignDraft(detail.design.id)).resolves.toBeNull();
  }, 30_000);

  it('restores and copies exact Ready states while sharing only the managed repository', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-ready-actions',
      previewEnabled: true,
      designMode: true
    });

    let source = await scenario.service.createBlankDesign({
      brief: 'Create a compact product page.',
      creationToken: 'design-ready-actions-create',
      runtimeId: 'codex'
    });
    const sourceWorktreePath = requireWorktreePath(source);
    await fs.writeFile(
      path.join(sourceWorktreePath, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="./styles.css"><title>First direction</title><h1>First direction</h1><script src="./app.js" defer></script>',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'styles.css'),
      'body { color: navy; }\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'app.js'),
      'document.body.dataset.direction = "first";\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'assets', 'direction.txt'),
      'first asset\n',
      'utf8'
    );
    await scenario.completeRun(requireRunId(source), 'The first direction is ready.');
    source = await waitForDesign(
      scenario,
      source.design.id,
      (candidate) => candidate.revisions.length === 1 && candidate.canvas.state === 'READY'
    );
    const firstRevision = source.revisions[0]!;

    source = await scenario.service.submitDesignTurn({
      designId: source.design.id,
      clientMessageId: 'design-ready-actions-second',
      message: 'Use the second direction.',
      referenceIds: []
    });
    await fs.writeFile(
      path.join(sourceWorktreePath, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="./styles.css"><title>Second direction</title><h1>Second direction</h1><script src="./app.js" defer></script>',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'styles.css'),
      'body { color: seagreen; }\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'app.js'),
      'document.body.dataset.direction = "second";\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(sourceWorktreePath, 'assets', 'direction.txt'),
      'second asset\n',
      'utf8'
    );
    await scenario.completeRun(requireRunId(source), 'The second direction is ready.');
    source = await waitForDesign(
      scenario,
      source.design.id,
      (candidate) => candidate.revisions.length === 2 && candidate.canvas.state === 'READY'
    );
    const secondRevision = source.revisions[1]!;
    const repositoryPath = source.repository.path;
    const sourceBranch = source.currentWorktree!.branchName;

    source = await scenario.service.restoreDesignRevision({
      designId: source.design.id,
      revisionId: firstRevision.id,
      clientActionId: randomUUID()
    });
    expect(source.revisions.at(-1)).toMatchObject({
      ordinal: 3,
      changeSource: 'RESTORE',
      sourceRevisionId: firstRevision.id
    });
    expect(await requestActiveRoute(requireActivePreview(source))).toContain(
      'First direction'
    );
    expect(await fs.readFile(path.join(sourceWorktreePath, 'index.html'), 'utf8')).toContain(
      'First direction'
    );
    await expect(
      fs.readFile(path.join(sourceWorktreePath, 'styles.css'), 'utf8')
    ).resolves.toContain('navy');
    await expect(
      fs.readFile(path.join(sourceWorktreePath, 'app.js'), 'utf8')
    ).resolves.toContain('"first"');
    await expect(
      fs.readFile(path.join(sourceWorktreePath, 'assets', 'direction.txt'), 'utf8')
    ).resolves.toBe('first asset\n');
    expect(await requestActiveRoute(requireActivePreview(source), '/styles.css')).toContain(
      'navy'
    );

    const duplicateActionId = randomUUID();
    let copy = await scenario.service.duplicateDesign({
      designId: source.design.id,
      revisionId: secondRevision.id,
      clientActionId: duplicateActionId
    });
    const copyRetry = await scenario.service.duplicateDesign({
      designId: source.design.id,
      revisionId: secondRevision.id,
      clientActionId: duplicateActionId
    });
    expect(copyRetry.design.id).toBe(copy.design.id);
    expect(copy).toMatchObject({
      turns: [],
      conversation: [],
      sessions: [],
      origin: {
        designId: source.design.id,
        revisionId: secondRevision.id,
        revisionOrdinal: 2
      },
      revisions: [
        expect.objectContaining({
          ordinal: 1,
          commitSha: secondRevision.commitSha,
          changeSource: 'DUPLICATE'
        })
      ],
      canvas: { state: 'READY' }
    });
    expect(copy.repository.id).toBe(source.repository.id);
    expect(copy.currentWorktree?.id).not.toBe(source.currentWorktree?.id);
    expect(copy.currentWorktree?.branchName).not.toBe(sourceBranch);
    expect(await requestActiveRoute(requireActivePreview(copy))).toContain(
      'Second direction'
    );
    expect(await requestActiveRoute(requireActivePreview(copy), '/styles.css')).toContain(
      'seagreen'
    );
    expect(await requestActiveRoute(requireActivePreview(copy), '/app.js')).toContain(
      '"second"'
    );
    expect(await requestActiveRoute(requireActivePreview(copy), '/assets/direction.txt')).toBe(
      'second asset\n'
    );

    copy = await scenario.service.renameDesign({
      designId: copy.design.id,
      title: 'Second direction copy'
    });
    expect(copy.task).toMatchObject({
      title: 'Second direction copy',
      prompt: source.task.prompt
    });
    copy = await scenario.service.archiveDesign({ designId: copy.design.id });
    expect(copy.design.status).toBe('ARCHIVED');

    await scenario.service.deleteTask({
      taskId: source.design.id,
      removeWorktree: true
    });
    await expect(fs.access(repositoryPath)).resolves.toBeUndefined();
    expect(await git(repositoryPath, ['branch', '--list', sourceBranch])).toBe('');
    await expect(scenario.service.getDesign(copy.design.id)).resolves.toMatchObject({
      design: { status: 'ARCHIVED' },
      canvas: { state: 'READY' }
    });

    await scenario.service.deleteTask({ taskId: copy.design.id, removeWorktree: true });
    await expect(fs.access(repositoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(scenario.service.listDesigns()).resolves.toEqual([]);
  }, 60_000);

  it('removes a sent attachment draft left behind by an interrupted composer cleanup', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-adopted-draft-recovery',
      previewEnabled: true,
      designMode: true
    });

    const detail = await scenario.service.createBlankDesign({
      brief: 'Create a compact reporting page.',
      creationToken: 'design-adopted-draft-create',
      runtimeId: 'codex'
    });
    const attachmentDraft = await scenario.service.stageTaskAttachmentBatch({
      attachments: [{
        clientToken: 'design-adopted-draft-reference',
        displayName: 'direction.txt',
        declaredMediaType: 'text/plain',
        bytes: new TextEncoder().encode('Use a quiet visual hierarchy.').buffer
      }]
    });
    const draft = await scenario.service.saveDesignDraft({
      designId: detail.design.id,
      expectedRevision: 0,
      body: 'Apply the attached direction.',
      referenceIds: [],
      attachmentDraftId: attachmentDraft.id
    });
    const attachmentFiles = (
      scenario.store as unknown as {
        attachmentFiles: {
          finalizeDraftForExistingTask(): Promise<void>;
        };
      }
    ).attachmentFiles;
    vi.spyOn(attachmentFiles, 'finalizeDraftForExistingTask').mockResolvedValue();

    await scenario.service.submitDesignTurn({
      designId: detail.design.id,
      clientMessageId: 'design-adopted-draft-turn',
      message: draft.body,
      referenceIds: [],
      attachmentDraftId: attachmentDraft.id
    });
    await expect(scenario.store.listAttachmentDraft(attachmentDraft.id)).resolves.toMatchObject({
      id: attachmentDraft.id
    });

    const internals = scenario.service as unknown as {
      reconcileDesignDrafts(drafts: readonly typeof draft[]): Promise<void>;
    };
    await internals.reconcileDesignDrafts([draft]);

    await expect(scenario.service.getDesignDraft(detail.design.id)).resolves.toBeNull();
    await expect(scenario.store.listAttachmentDraft(attachmentDraft.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_DRAFT_NOT_FOUND'
    });
    const reopened = await scenario.service.getDesign(detail.design.id);
    expect(reopened.turns.at(-1)?.attachmentDraftId).toBe(attachmentDraft.id);
    expect(reopened.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceDraftId: attachmentDraft.id })
      ])
    );
  }, 30_000);

  it('does not delete a Design while its Preview restart is running', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-design-restart-delete',
      previewEnabled: true,
      designMode: true
    });

    let detail = await scenario.service.createBlankDesign({
      brief: 'Create a small status page.',
      creationToken: 'design-restart-delete',
      runtimeId: 'codex'
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

function requestActiveRoute(
  generation: PreviewGenerationRecord,
  requestPath = '/'
): Promise<string> {
  const route = generation.routes.find((candidate) => candidate.state === 'ATTACHED');
  if (!route) throw new Error('Active Preview route is missing.');
  return requestPreviewRoute(route.gatewayPort, route.hostname, requestPath);
}

function requestResolvedRoute(route: { url: string }, requestPath?: string): Promise<string> {
  const parsed = new URL(route.url);
  return requestPreviewRoute(
    Number(parsed.port),
    parsed.host,
    requestPath ?? `${parsed.pathname}${parsed.search}`
  );
}

function requestPreviewRoute(
  port: number,
  host: string,
  requestPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        headers: { host }
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
