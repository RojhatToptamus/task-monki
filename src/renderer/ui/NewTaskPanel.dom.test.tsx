import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel, Repository } from '../../shared/contracts';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { NewTaskPanel } from './NewTaskPanel';

type RefinePromptInput = Parameters<
  React.ComponentProps<typeof NewTaskPanel>['onRefinePrompt']
>[0];

describe('mounted NewTaskPanel prompt refinement', () => {
  it('sends the full refinement input and invalidates a proposal when that input changes', async () => {
    const onRefinePrompt = vi.fn(async (_input: RefinePromptInput) => ({
      titleSuggestion: 'Clarify the sync badge',
      prompt: 'Show the saved GitHub sync state in the status badge.',
      source: 'model' as const,
      evidence: emptyEvidence()
    }));
    renderPanel({ onRefinePrompt });

    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));

    await waitFor(() => expect(onRefinePrompt).toHaveBeenCalledOnce());
    expect(onRefinePrompt).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/u),
      repositoryId: 'repository-1',
      input: 'add a sync badge',
      title: 'Sync badge',
      attachmentDraftId: undefined,
      targetRuntimeId: 'codex',
      targetModel: 'test-model',
      targetModelProvider: undefined
    });
    expect(
      screen.getByRole('group', { name: 'Refined description proposal' })
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'add a sync badge, but do not change the status model' }
    });

    expect(
      screen.queryByRole('group', { name: 'Refined description proposal' })
    ).toBeNull();
    expect((screen.getByRole('button', { name: 'Refine' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('cancels the active refinement before closing the composer', async () => {
    let resolveRefinement: (() => void) | undefined;
    const onRefinePrompt = vi.fn(
      (_input: RefinePromptInput) =>
        new Promise<never>(() => {
          resolveRefinement = () => undefined;
        })
    );
    const onCancelPromptRefinement = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderPanel({ onRefinePrompt, onCancelPromptRefinement, onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    await waitFor(() => expect(onRefinePrompt).toHaveBeenCalledOnce());
    expect(resolveRefinement).toBeTypeOf('function');
    const requestId = onRefinePrompt.mock.calls[0]![0].requestId;

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(onCancelPromptRefinement).toHaveBeenCalledWith(requestId);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('shows a specific degraded reason without presenting an unchanged proposal', async () => {
    const warning =
      'The refinement model returned a response Task Monki could not validate. The original request was kept unchanged.';
    renderPanel({
      onRefinePrompt: async () => ({
        titleSuggestion: 'Sync badge',
        prompt: 'add a sync badge',
        source: 'unchanged-fallback',
        evidence: emptyEvidence(),
        warning
      })
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));

    expect(await screen.findByText(warning)).toBeTruthy();
    expect(
      screen.queryByRole('group', { name: 'Refined description proposal' })
    ).toBeNull();
  });
});

function renderPanel(overrides: {
  onRefinePrompt?: React.ComponentProps<typeof NewTaskPanel>['onRefinePrompt'];
  onCancelPromptRefinement?: React.ComponentProps<
    typeof NewTaskPanel
  >['onCancelPromptRefinement'];
  onClose?: () => void;
} = {}) {
  const model: AgentModel = {
    id: 'codex:test-model',
    runtimeId: 'codex',
    model: 'test-model',
    displayName: 'Test model',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    inputModalities: ['text']
  };
  const repository: Repository = {
    id: 'repository-1',
    kind: 'USER_REGISTERED',
    name: 'project',
    path: '/tmp/project',
    status: 'AVAILABLE',
    remotes: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z'
  };
  return render(
    <NewTaskPanel
      repositoryId={repository.id}
      repositories={[repository]}
      models={[model]}
      runtimes={[
        {
          preflight: {
            runtime: CODEX_RUNTIME_DESCRIPTOR,
            readiness: createRuntimeReadiness('READY', 'Codex is ready.'),
            capabilities: codexCapabilities()
          },
          models: [model],
          refreshedAt: '2026-08-27T00:00:00.000Z'
        }
      ]}
      defaultAgentSettings={{ runtimeId: 'codex', model: 'test-model' }}
      initialTextDraft={{ title: 'Sync badge', prompt: 'add a sync badge' }}
      onCreate={async () => undefined}
      onRefinePrompt={
        overrides.onRefinePrompt ??
        (async () => ({
          titleSuggestion: 'Sync badge',
          prompt: 'add a sync badge',
          source: 'model',
          evidence: emptyEvidence()
        }))
      }
      onCancelPromptRefinement={
        overrides.onCancelPromptRefinement ?? (async () => undefined)
      }
      onStageAttachmentBatch={async () => ({
        id: 'draft-1',
        attachments: [],
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z'
      })}
      onDiscardAttachmentDraft={async () => undefined}
      fallbackReturnFocusRef={{ current: null }}
      onClose={overrides.onClose ?? (() => undefined)}
    />
  );
}

function emptyEvidence() {
  return {
    repositoryInspection: 'none' as const,
    repositoryFilesInspected: [],
    attachmentIdsInspected: [],
    attachmentIdsReferenced: []
  };
}
