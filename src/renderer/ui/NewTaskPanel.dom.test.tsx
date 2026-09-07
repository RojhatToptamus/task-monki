import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel, ExistingWorktree, Repository } from '../../shared/contracts';
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

describe('mounted existing-work import', () => {
  it('imports the selected named checkout without requiring an available agent or starting new work', async () => {
    const onImport = vi.fn(async () => undefined);
    const onCreate = vi.fn();
    renderPanel({
      models: [], runtimes: [], onImport, onCreate,
      onListExistingWorktrees: async () => [{ worktreePath: '/tmp/project', branchName: 'feature' }]
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import existing work', pressed: false }));
    await screen.findByRole('option', { name: 'feature · /tmp/project' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Checkout' }), { target: { value: '/tmp/project' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Compare against' }), { target: { value: 'HEAD' } });
    fireEvent.submit(screen.getByRole('form', { name: 'New task' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repository-1', worktreePath: '/tmp/project', branchName: 'feature', baseRef: 'HEAD',
      title: 'Sync badge', prompt: 'add a sync badge'
    }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('ignores an obsolete list and opens a duplicate task without importing again', async () => {
    let resolveOld!: (items: ExistingWorktree[]) => void;
    const onListExistingWorktrees = vi.fn()
      .mockImplementationOnce(() => new Promise<ExistingWorktree[]>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue([{ worktreePath: '/tmp/current', branchName: 'feature', existingTaskId: 'archived-task' }]);
    const onImport = vi.fn();
    const onOpenExistingTask = vi.fn(async () => undefined);
    renderPanel({ onImport, onOpenExistingTask, onListExistingWorktrees });
    fireEvent.click(screen.getByRole('button', { name: 'Import existing work', pressed: false }));
    fireEvent.click(screen.getByRole('button', { name: 'New work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import existing work', pressed: false }));
    await screen.findByRole('option', { name: 'feature · /tmp/current' });
    await act(async () => resolveOld([{ worktreePath: '/tmp/old', branchName: 'wrong' }]));
    expect(screen.queryByRole('option', { name: 'wrong · /tmp/old' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Checkout' }), { target: { value: '/tmp/current' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open existing task' }));
    await waitFor(() => expect(onOpenExistingTask).toHaveBeenCalledWith('archived-task'));
    expect(onImport).not.toHaveBeenCalled();
  });
});

function renderPanel(overrides: Partial<React.ComponentProps<typeof NewTaskPanel>> = {}) {
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
      {...overrides}
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
