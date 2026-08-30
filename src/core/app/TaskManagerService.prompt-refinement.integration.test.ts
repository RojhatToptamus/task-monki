import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/agent';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { createScriptedAgentRuntimeFixture } from '../../testSupport/taskMonkiScenario';
import { acpCapabilities } from '../agent/acp/AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../testSupport/acpRuntimeProfile';
import { AgentRuntimeDeliveryError } from '../agent/AgentRuntimeAdapter';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import { MemoryAppSettingsStore } from '../settings/AppSettingsStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';
import { git } from '../git/gitCli';
import {
  PromptRefinementCanceledError,
  PromptRefinementTerminationUnconfirmedError
} from '../prompt/PromptRefinementService';

describe('TaskManagerService prompt refinement', () => {
  it('resolves both models and passes verified staged attachments to one refinement run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refinement-'));
    const repositoryPath = path.join(root, 'repository');
    await fs.mkdir(repositoryPath);
    await initializeRepository(repositoryPath);
    const store = new FileTaskStore(path.join(root, 'store'));
    const runtimeId = 'prompt-refinement-test';
    const descriptor: AgentRuntimeDescriptor = {
      ...TEST_ACP_PROFILE.descriptor,
      id: runtimeId,
      displayName: 'Prompt refinement test runtime'
    };
    const capabilities: AgentRuntimeCapabilities = {
      ...acpCapabilities({ ...TEST_ACP_PROFILE, descriptor }),
      runtimeId,
      readOnlyTurns: {
        maturity: 'stable',
        detail: 'Test-only shared read-only turns.'
      },
      attachmentDelivery: {
        maturity: 'stable',
        detail: 'Test-only managed attachment delivery.'
      },
      executionPolicy: {
        defaultPresetId: 'read-only',
        detail: 'Test-only native mutation denial.',
        presets: [
          {
            id: 'read-only',
            label: 'Read only',
            detail: 'Denies repository mutation for this test runtime.',
            sandbox: 'READ_ONLY',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            repositoryMutation: 'DENY',
            networkAccess: 'DISABLED'
          }
        ]
      }
    };
    const refinementModel = model(runtimeId, 'refiner-model', ['text', 'image']);
    const targetModel = model(runtimeId, 'target-model', ['text', 'image']);
    const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
    const adapter = scriptedRuntime.adapter;
    Object.defineProperty(adapter, 'descriptor', { value: descriptor });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(capabilities);
    vi.spyOn(adapter, 'preflight').mockResolvedValue({
      runtime: descriptor,
      readiness: createRuntimeReadiness('READY', 'Ready.'),
      capabilities
    });
    vi.spyOn(adapter, 'listModels').mockResolvedValue([refinementModel, targetModel]);
    const resolveExecution = vi
      .spyOn(adapter, 'resolveExecution')
      .mockImplementation(async ({ settings }) => {
        const selected = settings.model === 'target-model' ? targetModel : refinementModel;
        return {
          settings: {
            ...settings,
            runtimeId,
            model: selected.model
          },
          model: selected
        };
      });
    const service = new TaskManagerService(store, root, undefined, {
      ...scriptedRuntime.serviceOptions,
      agentRuntimeAdapters: [adapter],
      appSettingsStore: new MemoryAppSettingsStore({
        defaultRuntimeId: runtimeId,
        promptRefinementRuntimeId: runtimeId
      })
    });
    await service.init();
    const repository = await addTestRepository(store, repositoryPath);
    const bytes = new TextEncoder().encode('task evidence').buffer;
    const draft = await service.stageTaskAttachmentBatch({
      attachments: [
        {
          clientToken: 'prompt-refinement-attachment-1',
          displayName: 'context.txt',
          declaredMediaType: 'text/plain',
          bytes
        }
      ]
    });
    adapter.nextRuntimeTurnResult = {
      output: JSON.stringify({
        titleSuggestion: 'Refined task',
        prompt: 'Use context.txt as task evidence.',
        repositoryInspection: 'none',
        repositoryFilesInspected: [],
        attachmentIdsInspected: [draft.attachments[0]!.id],
        attachmentIdsReferenced: [draft.attachments[0]!.id]
      })
    };

    const response = await service.refinePrompt({
      requestId: 'refinement-request-1',
      repositoryId: repository.id,
      input: 'Use the attached context to clarify the task.',
      title: 'Clarify task',
      attachmentDraftId: draft.id,
      runtimeId,
      model: refinementModel.model,
      targetRuntimeId: runtimeId,
      targetModel: targetModel.model
    });

    expect(response.source).toBe('model');
    expect(resolveExecution).toHaveBeenCalledTimes(2);
    expect(resolveExecution).toHaveBeenNthCalledWith(1, {
      settings: expect.objectContaining({ model: refinementModel.model }),
      attachments: [expect.objectContaining({ attachmentId: draft.attachments[0]!.id })]
    });
    expect(resolveExecution).toHaveBeenNthCalledWith(2, {
      settings: expect.objectContaining({ model: targetModel.model }),
      attachments: []
    });
    expect(adapter.startedRuntimeTurns).toHaveLength(1);
    expect(adapter.startedRuntimeTurns[0]).toMatchObject({
      run: { purpose: 'PROMPT_REFINEMENT' },
      executionContext: {
        repositoryAccess: 'READ_ONLY',
        modelSettings: {
          runtimeId,
          model: refinementModel.model,
          reasoningEffort: 'low',
          sandbox: 'READ_ONLY',
          approvalPolicy: 'NEVER',
          networkAccess: false
        }
      },
      attachments: [
        expect.objectContaining({
          attachmentId: draft.attachments[0]!.id,
          displayName: 'context.txt',
          kind: 'text',
          path: expect.stringContaining(path.join('attachments', 'staging', draft.id))
        })
      ]
    });
    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({ id: draft.id });

    const runtimeSnapshot = await scriptedRuntime.runtimeStore.snapshot();
    expect(runtimeSnapshot.sessions).toEqual([]);
    expect(runtimeSnapshot.runs).toEqual([]);
    expect(runtimeSnapshot.queueEntries).toEqual([]);
    expect(runtimeSnapshot.artifacts).toEqual([]);
    await service.shutdown();
  });

  it('cleans up a refinement whose provider turn was definitely not delivered', async () => {
    const fixture = await createPromptRefinementFixture('start-not-delivered');
    const startRuntimeTurn = vi
      .spyOn(fixture.scriptedRuntime.adapter, 'startRuntimeTurn')
      .mockRejectedValueOnce(
        new AgentRuntimeDeliveryError('NOT_DELIVERED', 'Provider rejected the turn before delivery.')
      );

    await expect(
      fixture.service.refinePrompt({
        requestId: 'start-not-delivered',
        repositoryId: fixture.repository.id,
        input: 'Clarify this request.',
        runtimeId: 'codex',
        model: 'scenario-model',
        targetRuntimeId: 'codex',
        targetModel: 'scenario-model'
      })
    ).resolves.toMatchObject({ source: 'unchanged-fallback' });

    expect(startRuntimeTurn).toHaveBeenCalledTimes(1);
    const runtime = await fixture.scriptedRuntime.runtimeStore.snapshot();
    expect(runtime.sessions).toEqual([]);
    expect(runtime.runs).toEqual([]);
    expect(runtime.queueEntries).toEqual([]);
    expect(runtime.artifacts).toEqual([]);
    await fixture.service.shutdown();
  });

  it('fences later refinements when provider start delivery is uncertain', async () => {
    const fixture = await createPromptRefinementFixture('start-ambiguous');
    const startRuntimeTurn = vi
      .spyOn(fixture.scriptedRuntime.adapter, 'startRuntimeTurn')
      .mockRejectedValueOnce(
        new AgentRuntimeDeliveryError('AMBIGUOUS', 'Provider start delivery is uncertain.')
      );

    await expect(
      fixture.service.refinePrompt({
        requestId: 'start-ambiguous',
        repositoryId: fixture.repository.id,
        input: 'Clarify this request.',
        runtimeId: 'codex',
        model: 'scenario-model',
        targetRuntimeId: 'codex',
        targetModel: 'scenario-model'
      })
    ).resolves.toMatchObject({ source: 'unchanged-fallback' });
    await expect(
      fixture.service.refinePrompt({
        requestId: 'blocked-after-ambiguous-start',
        repositoryId: fixture.repository.id,
        input: 'Do not launch another provider turn.',
        runtimeId: 'codex',
        model: 'scenario-model',
        targetRuntimeId: 'codex',
        targetModel: 'scenario-model'
      })
    ).resolves.toMatchObject({
      source: 'unchanged-fallback',
      warning: expect.stringContaining('previous refinement process')
    });

    expect(startRuntimeTurn).toHaveBeenCalledTimes(1);
    expect(
      (await fixture.scriptedRuntime.runtimeStore.snapshot()).runs.find(
        (run) => run.purpose === 'PROMPT_REFINEMENT'
      )
    ).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'AMBIGUOUS'
    });
    await fixture.service.shutdown();
  });

  it('fences later refinements when provider interruption is uncertain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refinement-stop-'));
    const repositoryPath = path.join(root, 'repository');
    await fs.mkdir(repositoryPath);
    await initializeRepository(repositoryPath);
    const store = new FileTaskStore(path.join(root, 'store'));
    const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
    const service = new TaskManagerService(store, root, undefined, {
      ...scriptedRuntime.serviceOptions,
      appSettingsStore: new MemoryAppSettingsStore({
        defaultRuntimeId: 'codex',
        promptRefinementRuntimeId: 'codex'
      })
    });
    await service.init();
    const repository = await addTestRepository(store, repositoryPath);
    const refining = service.refinePrompt({
      requestId: 'uncertain-stop',
      repositoryId: repository.id,
      input: 'Clarify this request.',
      runtimeId: 'codex',
      model: 'scenario-model',
      targetRuntimeId: 'codex',
      targetModel: 'scenario-model'
    });
    const refiningOutcome = refining.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(scriptedRuntime.adapter.startedRuntimeTurns).toHaveLength(1);
    });
    scriptedRuntime.adapter.ambiguousRuntimeInterrupt = true;

    await expect(
      service.cancelPromptRefinement({
        requestId: 'uncertain-stop',
        runtimeId: 'codex'
      })
    ).rejects.toBeInstanceOf(PromptRefinementTerminationUnconfirmedError);
    await expect(
      service.refinePrompt({
        requestId: 'blocked-after-uncertain-stop',
        repositoryId: repository.id,
        input: 'Do not launch another provider turn.',
        runtimeId: 'codex',
        model: 'scenario-model',
        targetRuntimeId: 'codex',
        targetModel: 'scenario-model'
      })
    ).resolves.toMatchObject({
      source: 'unchanged-fallback',
      warning: expect.stringContaining('previous refinement process')
    });
    expect(scriptedRuntime.adapter.startedRuntimeTurns).toHaveLength(1);

    const recovering = (await scriptedRuntime.runtimeStore.snapshot()).runs.find(
      (run) => run.purpose === 'PROMPT_REFINEMENT'
    )!;
    const completedAt = new Date().toISOString();
    const failed = await scriptedRuntime.runtimeStore.updateRun(
      recovering.id,
      recovering.recordRevision,
      {
        status: 'FAILED',
        delivery: 'TERMINAL',
        recoveryState: 'NONE',
        terminalReason: 'Provider interruption was not confirmed.',
        lastEventAt: completedAt,
        endedAt: completedAt
      },
      'settle-uncertain-refinement'
    );
    scriptedRuntime.adapter.emitRuntimeTurnEvent({
      type: 'TERMINAL',
      runId: failed.id,
      providerTurnId: failed.providerTurnId!,
      status: 'failed',
      error: failed.terminalReason,
      completedAt
    });
    expect(await refiningOutcome).toBeInstanceOf(PromptRefinementCanceledError);
    await service.shutdown();
  });
});

async function createPromptRefinementFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-refinement-${name}-`));
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  await initializeRepository(repositoryPath);
  const store = new FileTaskStore(path.join(root, 'store'));
  const scriptedRuntime = createScriptedAgentRuntimeFixture(store);
  const service = new TaskManagerService(store, root, undefined, {
    ...scriptedRuntime.serviceOptions,
    appSettingsStore: new MemoryAppSettingsStore({
      defaultRuntimeId: 'codex',
      promptRefinementRuntimeId: 'codex'
    })
  });
  await service.init();
  return {
    service,
    scriptedRuntime,
    repository: await addTestRepository(store, repositoryPath)
  };
}

async function initializeRepository(repositoryPath: string): Promise<void> {
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Refinement test\n');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
}

function model(
  runtimeId: string,
  modelName: string,
  inputModalities: string[]
): AgentModel {
  return {
    id: `${runtimeId}:${modelName}`,
    runtimeId,
    model: modelName,
    displayName: modelName,
    hidden: false,
    isDefault: modelName === 'refiner-model',
    supportedReasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    inputModalities
  };
}
