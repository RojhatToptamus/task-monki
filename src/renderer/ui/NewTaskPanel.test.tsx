import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../shared/contracts';
import { ATTACHMENT_FILE_INPUT_ACCEPT } from '../../shared/attachments';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  capAttachmentValidationFailures,
  getOrCreateTaskCreationToken,
  imageAttachmentModelError,
  reserveClipboardAttachmentRead,
  shouldPreventDefaultAttachmentPaste,
  taskCreationNeedsUnchangedRetry
} from '../model/taskAttachmentComposer';
import {
  clampNewTaskPanelWidth,
  dragNewTaskCanvas,
  getNewTaskPanelWidthBounds,
  newTaskCanvasPanPosition,
  resizeNewTaskPanelFromPointer,
  shouldInterruptNewTaskCanvasPanForWheel
} from '../model/newTaskPanel';
import { AttachmentChip, NewTaskPanel } from './NewTaskPanel';

describe('NewTaskPanel', () => {
  it('keeps the dock resize width within desktop and narrow viewport bounds', () => {
    expect(getNewTaskPanelWidthBounds(1440)).toEqual({ min: 500, max: 760 });
    expect(clampNewTaskPanelWidth(420, 1440)).toBe(500);
    expect(clampNewTaskPanelWidth(820, 1440)).toBe(760);
    expect(getNewTaskPanelWidthBounds(460)).toEqual({ min: 460, max: 460 });
    expect(clampNewTaskPanelWidth(660, 460)).toBe(460);
    expect(resizeNewTaskPanelFromPointer(520, 600, 500, 1440)).toBe(620);
    expect(resizeNewTaskPanelFromPointer(520, 600, 200, 1440)).toBe(760);
    expect(resizeNewTaskPanelFromPointer(520, 600, 700, 1440)).toBe(500);
    expect(newTaskCanvasPanPosition(0, 520, 0)).toBe(0);
    expect(newTaskCanvasPanPosition(0, 520, 180)).toBe(260);
    expect(newTaskCanvasPanPosition(0, 520, 360)).toBe(520);
    expect(dragNewTaskCanvas(0, 600, 450, 520)).toBe(150);
    expect(dragNewTaskCanvas(520, 450, 600, 520)).toBe(370);
  });

  it('only interrupts an automatic canvas pan for intentional horizontal wheel input', () => {
    expect(shouldInterruptNewTaskCanvasPanForWheel(0, 160, false)).toBe(false);
    expect(shouldInterruptNewTaskCanvasPanForWheel(2, 160, false)).toBe(false);
    expect(shouldInterruptNewTaskCanvasPanForWheel(80, 12, false)).toBe(true);
    expect(shouldInterruptNewTaskCanvasPanForWheel(0, 80, true)).toBe(true);
    expect(shouldInterruptNewTaskCanvasPanForWheel(0.2, 0.1, false)).toBe(false);
  });

  it('reuses one task creation token across response-loss retries', () => {
    const holder: { current: string | undefined } = { current: undefined };
    let generated = 0;
    const createUuid = () => {
      generated += 1;
      return 'task-create-renderer-retry-0001';
    };

    expect(getOrCreateTaskCreationToken(holder, createUuid)).toBe(
      'task-create-renderer-retry-0001'
    );
    expect(getOrCreateTaskCreationToken(holder, createUuid)).toBe(
      'task-create-renderer-retry-0001'
    );
    expect(generated).toBe(1);
  });

  it('locks only ambiguous task-creation failures to an unchanged retry', () => {
    expect(taskCreationNeedsUnchangedRetry(new Error('connection lost'))).toBe(true);
    expect(taskCreationNeedsUnchangedRetry({ status: 503 })).toBe(true);
    expect(
      taskCreationNeedsUnchangedRetry({ status: 409, code: 'TASK_CREATION_CONFLICT' })
    ).toBe(true);
    expect(taskCreationNeedsUnchangedRetry({ status: 400, code: 'INVALID_REQUEST' })).toBe(
      false
    );
  });

  it('preserves non-empty text paste while also attaching clipboard files', () => {
    expect(shouldPreventDefaultAttachmentPaste(1, 'pasted text', false)).toBe(false);
    expect(shouldPreventDefaultAttachmentPaste(1, '', false)).toBe(true);
    expect(shouldPreventDefaultAttachmentPaste(0, '', true)).toBe(true);
  });

  it('blocks images until an explicitly image-capable model is selected', () => {
    expect(imageAttachmentModelError(true, undefined)).toContain('not reported');
    expect(
      imageAttachmentModelError(true, {
        id: 'text-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'text-model',
        displayName: 'Text model',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        inputModalities: ['text']
      })
    ).toContain('does not accept images');
    expect(
      imageAttachmentModelError(true, {
        id: 'vision-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'vision-model',
        displayName: 'Vision model',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        inputModalities: ['text', 'image']
      })
    ).toBeUndefined();
  });

  it('keeps validation chips bounded', () => {
    const bounded = capAttachmentValidationFailures([
      { id: 'ready' },
      { id: 'rejected-1', failureOperation: 'validation' as const },
      { id: 'rejected-2', failureOperation: 'validation' as const },
      { id: 'ready-2' },
      { id: 'rejected-3', failureOperation: 'validation' as const },
      { id: 'rejected-4', failureOperation: 'validation' as const }
    ]);

    expect(bounded.map(({ id }) => id)).toEqual([
      'ready',
      'rejected-2',
      'ready-2',
      'rejected-3',
      'rejected-4'
    ]);
  });

  it('reserves native clipboard reads synchronously and publishes no late previews', () => {
    const pending = { current: false };

    expect(reserveClipboardAttachmentRead(pending, false)).toBe(true);
    expect(pending.current).toBe(true);
    expect(reserveClipboardAttachmentRead(pending, false)).toBe(false);
  });

  it('announces attachment validation errors with the file', () => {
    const failedAttachment = renderToStaticMarkup(
      <AttachmentChip
        item={{
          clientId: 'attachment-1',
          clientToken: 'client-token-renderer-0001',
          file: new File(['select 1'], 'query.sql', { type: 'text/plain' }),
          kind: 'text',
          status: 'error',
          error: 'This file is not supported.',
          failureOperation: 'validation'
        }}
        disabled={false}
        onRemove={() => undefined}
      />
    );

    expect(failedAttachment).toContain('role="alert"');
    expect(failedAttachment).toContain('aria-live="assertive"');
    expect(failedAttachment).toContain('aria-label="Remove query.sql"');
  });

  it('offers retry for an explicitly activated catalog that already failed', () => {
    const discoverModels = vi.fn(async () => undefined);
    const capabilities = codexCapabilities();
    const html = renderToStaticMarkup(
      <NewTaskPanel
        defaultRepositoryPath="/tmp/project"
        models={[]}
        runtimes={[
          {
            preflight: {
              runtime: {
                id: 'cursor-agent-acp',
                displayName: 'Cursor Agent',
                kind: 'ACP_AGENT',
                transport: 'STDIO',
                lifecycleScope: 'APPLICATION'
              },
              readiness: createRuntimeReadiness('FAILED', 'Model discovery failed.', {
                checks: { modelCatalog: 'FAILED' }
              }),
              capabilities: {
                ...capabilities,
                runtimeId: 'cursor-agent-acp',
                modelCatalog: {
                  ...capabilities.modelCatalog,
                  activation: 'EXPLICIT'
                }
              }
            },
            models: [],
            refreshedAt: '2026-07-18T00:00:00.000Z'
          }
        ]}
        onCreate={async () => undefined}
        onRefinePrompt={async () => ({
          titleSuggestion: 'Task',
          prompt: 'Do the task.',
          source: 'deterministic-fallback'
        })}
        onStageAttachmentBatch={async () => ({
          id: 'draft-1',
          attachments: [],
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z'
        })}
        onDiscardAttachmentDraft={async () => undefined}
        onDiscoverAgentRuntimeModels={discoverModels}
        onClose={() => undefined}
      />
    );

    expect(discoverModels).not.toHaveBeenCalled();
    expect(html).toContain('Retry model discovery');
    expect(html).not.toContain('>Load models<');
  });

  it('shows task-level controls and the attachment composer without raw Codex fields', () => {
    const models: AgentModel[] = [
      {
        id: 'model-1',
        runtimeId: 'codex',
        modelProvider: 'openai',
        model: 'fake-model',
        displayName: 'Fake model',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text']
      },
      {
        id: 'opencode:anthropic/claude-sonnet',
        runtimeId: 'opencode',
        modelProvider: 'anthropic',
        model: 'claude-sonnet',
        displayName: 'OpenCode-only model',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
        inputModalities: ['text']
      }
    ];

    const capabilities = codexCapabilities();
    const discoverAgentRuntimeModels = vi.fn(async () => undefined);
    const renderPanel = (
      attachmentsEnabled = true,
      defaultPresetId = capabilities.executionPolicy.defaultPresetId
    ) => renderToStaticMarkup(
      <NewTaskPanel
        defaultRepositoryPath="/tmp/project"
        models={models}
        runtimes={[
          {
            preflight: {
              runtime: CODEX_RUNTIME_DESCRIPTOR,
              readiness: createRuntimeReadiness('READY', 'Codex is ready.', {
                diagnostics: [
                  {
                    code: 'PROVIDER_PROCESS_NOT_SANDBOXED',
                    severity: 'WARNING',
                    stage: 'SECURITY',
                    message: 'Provider commands run outside a Task Monki sandbox.'
                  },
                  {
                    code: 'RUNTIME_RESTART_REQUIRED',
                    severity: 'WARNING',
                    stage: 'CONFIGURATION',
                    message: 'The saved runtime change will apply after this turn.'
                  },
                  {
                    code: 'ACP_CLIENT_TOOLS_DISABLED',
                    severity: 'INFO',
                    stage: 'SECURITY',
                    message: 'Internal ACP client-tool notice.'
                  }
                ]
              }),
              capabilities: {
                ...capabilities,
                executionPolicy: {
                  ...capabilities.executionPolicy,
                  defaultPresetId
                }
              },
            },
            models: models.filter((model) => model.runtimeId === 'codex'),
            refreshedAt: '2026-07-10T00:00:00.000Z'
          },
          {
            preflight: {
              runtime: {
                id: 'opencode',
                displayName: 'OpenCode',
                kind: 'HTTP_AGENT',
                transport: 'HTTP_SSE',
                lifecycleScope: 'SESSION'
              },
              readiness: createRuntimeReadiness('READY', 'OpenCode is ready.'),
              capabilities: { ...codexCapabilities(), runtimeId: 'opencode' },
            },
            models: models.filter((model) => model.runtimeId === 'opencode'),
            refreshedAt: '2026-07-10T00:00:00.000Z'
          }
        ]}
        attachmentsEnabled={attachmentsEnabled}
        onCreate={async () => undefined}
        onRefinePrompt={async () => ({
          titleSuggestion: 'Task',
          prompt: 'Do the task.',
          source: 'deterministic-fallback'
        })}
        onStageAttachmentBatch={async () => ({
          id: 'draft-1',
          attachments: [],
          createdAt: '2026-07-10T00:00:00.000Z',
          updatedAt: '2026-07-10T00:00:00.000Z'
        })}
        onDiscardAttachmentDraft={async () => undefined}
        onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
        onClose={() => undefined}
      />
    );
    const html = renderPanel();

    expect(discoverAgentRuntimeModels).not.toHaveBeenCalled();
    expect(html).toContain('Execution policy');
    expect(html).toContain('Restricted');
    expect(html).toContain('<option value="restricted" selected="">Restricted</option>');
    expect(html).toContain('Ask for approval');
    expect(html).toContain('Approve for me');
    expect(html).toContain('Full access');
    expect(html).toContain('Network access');
    expect(html).toContain('Add files');
    expect(html).toContain(
      'title="Stored locally and shared read-only with Codex for this task."'
    );
    expect(html).toContain('Paste or drop files');
    expect(html).not.toContain('After validation, Task Monki stores');
    expect(html).toContain(`accept="${ATTACHMENT_FILE_INPUT_ACCEPT}"`);
    expect(html).toContain('aria-labelledby="task-network-access-label"');
    expect(html).toContain('<details class="newtask-settings">');
    expect(html).toContain('>Agent<');
    expect(html).toContain('aria-label="Agent runtime"');
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Execution policy"');
    expect(html).toContain('OpenCode');
    expect(html).not.toContain('OpenCode-only model');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize new task panel"');
    expect(html).not.toContain('slideover__scrim');
    expect(html).not.toContain('>Sandbox<');
    expect(html).not.toContain('Approval policy');
    expect(html).toContain('Provider commands run outside a Task Monki sandbox.');
    expect(html).toContain('The saved runtime change will apply after this turn.');
    expect(html).not.toContain('Internal ACP client-tool notice.');
    expect(html).not.toContain('Reasoning effort');

    const fullAccessHtml = renderPanel(true, 'full-access');
    expect(fullAccessHtml).toContain('Required by this execution policy.');

    const gatedHtml = renderPanel(false);
    expect(gatedHtml).toContain('Unavailable in this build');
    expect(gatedHtml).toContain('Attachments require file-read isolation between tasks.');
  });
});
