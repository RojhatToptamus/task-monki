import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
import { AttachmentChip, NewTaskPanel } from './NewTaskPanel';

describe('NewTaskPanel', () => {
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

    const renderPanel = (attachmentsEnabled = true) => renderToStaticMarkup(
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
              capabilities: codexCapabilities(),
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
        onClose={() => undefined}
      />
    );
    const html = renderPanel();

    expect(html).toContain('Permission mode');
    expect(html).toContain('Sandboxed');
    expect(html).toContain('<option value="sandboxed" selected="">Sandboxed</option>');
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
    expect(html).toContain('Agent runtime');
    expect(html).toContain('aria-label="Agent runtime"');
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain('OpenCode');
    expect(html).not.toContain('OpenCode-only model');
    expect(html).not.toContain('>Sandbox<');
    expect(html).not.toContain('Approval policy');
    expect(html).toContain('Provider commands run outside a Task Monki sandbox.');
    expect(html).toContain('The saved runtime change will apply after this turn.');
    expect(html).not.toContain('Internal ACP client-tool notice.');

    const gatedHtml = renderPanel(false);
    expect(gatedHtml).toContain('Unavailable in this build');
    expect(gatedHtml).toContain('Attachments require file-read isolation between tasks.');
  });
});
