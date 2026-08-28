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
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import { MemoryAppSettingsStore } from '../settings/AppSettingsStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService prompt refinement', () => {
  it('resolves both models and passes verified staged attachments to one refinement run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refinement-'));
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
      promptRefinement: {
        maturity: 'stable',
        detail: 'Test-only prompt refinement.'
      },
      attachmentDelivery: {
        maturity: 'stable',
        detail: 'Test-only managed attachment delivery.'
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
    const refinePrompt = vi.fn(async () => ({
      titleSuggestion: 'Refined task',
      prompt: 'Use context.txt as task evidence.',
      source: 'model' as const,
      evidence: {
        repositoryInspection: 'none' as const,
        repositoryFilesInspected: [],
        attachmentIdsInspected: [],
        attachmentIdsReferenced: []
      }
    }));
    const cancelPromptRefinement = vi.fn(async () => undefined);
    Object.defineProperties(adapter, {
      refinePrompt: { value: refinePrompt },
      cancelPromptRefinement: { value: cancelPromptRefinement }
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
    const repository = await addTestRepository(store, root);
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
      attachments: []
    });
    expect(resolveExecution).toHaveBeenNthCalledWith(2, {
      settings: expect.objectContaining({ model: targetModel.model }),
      attachments: []
    });
    expect(refinePrompt).toHaveBeenCalledWith({
      requestId: 'refinement-request-1',
      repositoryPath: repository.path,
      input: 'Use the attached context to clarify the task.',
      title: 'Clarify task',
      settings: expect.objectContaining({
        runtimeId,
        model: refinementModel.model,
        reasoningEffort: 'low',
        sandbox: 'READ_ONLY',
        networkAccess: false
      }),
      refinementModel,
      targetModel,
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

    await service.cancelPromptRefinement({
      requestId: 'refinement-request-1',
      runtimeId
    });
    expect(cancelPromptRefinement).toHaveBeenCalledWith('refinement-request-1');
    await service.shutdown();
  });
});

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
