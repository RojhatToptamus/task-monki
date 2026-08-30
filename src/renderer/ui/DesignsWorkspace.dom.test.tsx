import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentRuntimeState,
  InteractionRequestRecord,
  DesignListItem
} from '../../shared/contracts';
import type { AttachmentDraftSnapshot } from '../../shared/attachments';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import type { DesignProjectDetail } from '../model/designs';
import { DesignsWorkspace, type DesignsWorkspaceProps } from './DesignsWorkspace';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mounted Design workspace', () => {
  it('keeps Design history on its own title-aligned control', () => {
    const onHistoryCollapsedChange = vi.fn();
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({ onHistoryCollapsedChange })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide Design history' }));
    expect(onHistoryCollapsedChange).toHaveBeenCalledWith(true);

    view.rerender(
      <DesignsWorkspace
        {...workspaceProps({ historyCollapsed: true, onHistoryCollapsedChange })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show Design history' }));
    expect(onHistoryCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it('waits for the first list read before it shows the blank form', () => {
    const props = workspaceProps({
      designs: [],
      selectedDesignId: undefined,
      project: undefined,
      loading: true
    });
    const view = render(<DesignsWorkspace {...props} />);

    expect(screen.getByText('Loading Design')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New Design' })).toBeNull();

    view.rerender(<DesignsWorkspace {...props} loading={false} />);
    expect(screen.getByRole('heading', { name: 'New Design' })).toBeTruthy();
  });

  it('creates one blank Design with the selected compatible model', async () => {
    const onCreateBlankDesign = vi.fn(() => new Promise<void>(() => undefined));
    render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onCreateBlankDesign
        })}
      />
    );

    expect(screen.getByRole('heading', { name: 'New Design' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Design: Codex · Luna/ })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: '  Build a calm project portfolio.  ' }
    });
    const create = screen.getByRole('button', { name: 'Create Design' });
    fireEvent.click(create);
    fireEvent.click(create);

    await waitFor(() => expect(onCreateBlankDesign).toHaveBeenCalledOnce());
    expect(onCreateBlankDesign).toHaveBeenCalledWith({
      brief: 'Build a calm project portfolio.',
      creationToken: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/u),
      runtimeId: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium'
    });
  });

  it('keeps an unqualified model visible but creates only with a qualified model', async () => {
    const reason = 'This exact provider version and model failed Design verification.';
    const unqualifiedModel: AgentModel = {
      ...designModel,
      id: 'codex:unqualified',
      model: 'unqualified',
      displayName: 'Unqualified',
      isDefault: true,
      designSupport: { maturity: 'unsupported', detail: reason }
    };
    const onCreateBlankDesign = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          models: [unqualifiedModel, { ...designModel, isDefault: false }],
          defaultAgentSettings: {
            runtimeId: 'codex',
            model: 'unqualified',
            reasoningEffort: 'medium'
          },
          onCreateBlankDesign
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Design: Codex · Luna/ }));
    const unavailableOption = screen.getByRole('menuitemradio', {
      name: `Unqualified Unavailable ${reason}`
    });
    expect(unavailableOption).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build with the qualified model.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));

    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeId: 'codex', model: 'gpt-5.6-luna' })
      )
    );
  });

  it('keeps the blank brief ready when Design models load after the form mounts', async () => {
    const onCreateBlankDesign = vi.fn(async () => undefined);
    const initial = workspaceProps({
      designs: [],
      selectedDesignId: undefined,
      project: undefined,
      models: [],
      runtimes: [],
      onCreateBlankDesign
    });
    const view = render(<DesignsWorkspace {...initial} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build after the agent catalog is ready.' }
    });
    expect(
      (screen.getByRole('button', { name: 'Create Design' }) as HTMLButtonElement).disabled
    ).toBe(true);

    view.rerender(
      <DesignsWorkspace
        {...initial}
        models={[designModel]}
        runtimes={[designRuntime]}
      />
    );

    expect(screen.getByRole('button', { name: /Design: Codex · Luna/ })).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create Design' });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({
          brief: 'Build after the agent catalog is ready.',
          model: 'gpt-5.6-luna',
          reasoningEffort: 'medium'
        })
      )
    );
  });

  it('creates a Design with one selected image reference', async () => {
    installSafeImageDecoder();
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('initial-image-draft')
    );
    const onCreateBlankDesign = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onCreateBlankDesign
        })}
      />
    );
    const input = designReferenceInput(view.container);
    const image = attachmentFile('reference.png', 'image/png', 'image bytes');

    fireEvent.change(input, { target: { files: [image] } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Use this image as the visual direction.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));

    await waitFor(() => expect(onStageAttachmentBatch).toHaveBeenCalledOnce());
    expect(onStageAttachmentBatch.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({ displayName: 'reference.png', declaredMediaType: 'image/png' })
    ]);
    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentDraftId: 'initial-image-draft' })
      )
    );
  });

  it('creates a Design with multiple supported references', async () => {
    installSafeImageDecoder();
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('multiple-reference-draft')
    );
    const onCreateBlankDesign = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onCreateBlankDesign
        })}
      />
    );
    const files = [
      attachmentFile('direction.md', 'text/markdown', '# Direction'),
      attachmentFile('layout.webp', 'image/webp', 'image bytes')
    ];

    fireEvent.change(designReferenceInput(view.container), { target: { files } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build the page from both references.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));

    await waitFor(() => expect(onStageAttachmentBatch).toHaveBeenCalledOnce());
    expect(onStageAttachmentBatch.mock.calls[0]?.[0].attachments.map(({ displayName }) => displayName))
      .toEqual(['direction.md', 'layout.webp']);
    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentDraftId: 'multiple-reference-draft' })
      )
    );
  });

  it('creates a Design with a dropped initial reference', async () => {
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('dropped-reference-draft')
    );
    const onCreateBlankDesign = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onCreateBlankDesign
        })}
      />
    );
    const composer = view.container.querySelector<HTMLElement>('.tm-design-create__composer');
    if (!composer) throw new Error('The Design composer was not rendered.');
    const file = attachmentFile('dropped.txt', 'text/plain', 'Dropped direction');

    fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.getByText('Drop to attach')).toBeTruthy();
    fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [file] } });

    expect(screen.getByText('dropped.txt')).toBeTruthy();
    expect(screen.getByText(/1 file/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build from the dropped direction.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentDraftId: 'dropped-reference-draft' })
      )
    );
  });

  it('creates a Design with a pasted initial image', async () => {
    installSafeImageDecoder();
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('pasted-reference-draft')
    );
    const onCreateBlankDesign = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onCreateBlankDesign
        })}
      />
    );
    const image = attachmentFile('pasted.png', 'image/png', 'pasted image');

    fireEvent.paste(screen.getByRole('textbox', { name: 'Brief' }), {
      clipboardData: {
        getData: () => '',
        items: [{ kind: 'file', getAsFile: () => image }]
      }
    });

    expect(screen.getByText('pasted.png')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Use the pasted image.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    await waitFor(() =>
      expect(onCreateBlankDesign).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentDraftId: 'pasted-reference-draft' })
      )
    );
  });

  it('reuses the creation token and staged references after an ambiguous request', async () => {
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('retry-reference-draft')
    );
    const onCreateBlankDesign = vi
      .fn<DesignsWorkspaceProps['onCreateBlankDesign']>()
      .mockRejectedValueOnce(new Error('Connection lost.'))
      .mockResolvedValueOnce(undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onCreateBlankDesign
        })}
      />
    );

    fireEvent.change(designReferenceInput(document.body), {
      target: { files: [attachmentFile('retry.txt', 'text/plain', 'Retry reference')] }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build a calm project portfolio.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Connection lost.');

    expect(screen.getByRole('textbox', { name: 'Brief' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Design: Codex · Luna/ })).toHaveProperty(
      'disabled',
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry creation' }));
    await waitFor(() => expect(onCreateBlankDesign).toHaveBeenCalledTimes(2));

    expect(onStageAttachmentBatch).toHaveBeenCalledOnce();
    expect(onCreateBlankDesign.mock.calls[1]?.[0].creationToken).toBe(
      onCreateBlankDesign.mock.calls[0]?.[0].creationToken
    );
    expect(onCreateBlankDesign.mock.calls[1]?.[0].attachmentDraftId).toBe(
      onCreateBlankDesign.mock.calls[0]?.[0].attachmentDraftId
    );
  });

  it('discards a staged draft after a definite creation failure', async () => {
    const onStageAttachmentBatch = vi
      .fn()
      .mockResolvedValueOnce(attachmentDraft('failed-reference-draft'))
      .mockResolvedValueOnce(attachmentDraft('replacement-reference-draft'));
    const invalidRequest = Object.assign(new Error('The request is invalid.'), {
      status: 400,
      code: 'TASK_CREATION_INVALID_REQUEST'
    });
    const onCreateBlankDesign = vi
      .fn<DesignsWorkspaceProps['onCreateBlankDesign']>()
      .mockRejectedValueOnce(invalidRequest)
      .mockResolvedValueOnce(undefined);
    const onDiscardAttachmentDraft = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          designs: [],
          selectedDesignId: undefined,
          project: undefined,
          onStageAttachmentBatch,
          onDiscardAttachmentDraft,
          onCreateBlankDesign
        })}
      />
    );

    fireEvent.change(designReferenceInput(view.container), {
      target: { files: [attachmentFile('recover.txt', 'text/plain', 'Recover reference')] }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build a recoverable Design.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));

    await waitFor(() =>
      expect(onDiscardAttachmentDraft).toHaveBeenCalledWith({
        draftId: 'failed-reference-draft'
      })
    );
    expect(screen.getByRole('textbox', { name: 'Brief' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    await waitFor(() => expect(onCreateBlankDesign).toHaveBeenCalledTimes(2));
    expect(onCreateBlankDesign.mock.calls[1]?.[0].attachmentDraftId).toBe(
      'replacement-reference-draft'
    );
  });

  it('renders the ready conversation and sends one trimmed refinement', async () => {
    const onSubmitRefinement = vi.fn(() => new Promise<void>(() => undefined));
    render(
      <DesignsWorkspace
        {...workspaceProps({ onSubmitRefinement })}
      />
    );

    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getByText('Built the first page.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Conversation' })).toBeNull();
    expect(screen.queryByText(/Codex\s*·\s*scenario-model\s*·\s*low/)).toBeNull();
    const composer = screen.getByRole('textbox', { name: 'Refine this Design' });
    fireEvent.change(composer, { target: { value: '  Increase the title contrast.  ' } });
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => expect(onSubmitRefinement).toHaveBeenCalledOnce());
    expect(onSubmitRefinement).toHaveBeenCalledWith(
      'design-1',
      'Increase the title contrast.',
      [],
      undefined
    );
  });

  it('keeps an existing Design readable when its exact model is no longer qualified', () => {
    const reason = 'This exact provider version and model failed Design verification.';
    const onSubmitRefinement = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          models: [{
            ...designModel,
            designSupport: { maturity: 'unsupported', detail: reason }
          }],
          onSubmitRefinement
        })}
      />
    );

    expect(screen.getByText('Build a calm project portfolio.')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    const composer = screen.getByRole('textbox', { name: 'Refine this Design' });
    expect(composer).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
      'disabled',
      true
    );
    expect(onSubmitRefinement).not.toHaveBeenCalled();
  });

  it('loads an explicit provider model catalog when an existing Design reopens', async () => {
    const onDiscoverAgentRuntimeModels = vi.fn(async () => undefined);
    const explicitRuntime: AgentRuntimeState = {
      ...designRuntime,
      preflight: {
        ...designRuntime.preflight,
        readiness: {
          ...designRuntime.preflight.readiness,
          checks: {
            ...designRuntime.preflight.readiness.checks,
            modelCatalog: 'UNKNOWN'
          }
        },
        capabilities: {
          ...designRuntime.preflight.capabilities,
          modelCatalog: {
            ...designRuntime.preflight.capabilities.modelCatalog,
            activation: 'EXPLICIT'
          }
        }
      },
      models: []
    };
    const props = workspaceProps({
      models: [],
      runtimes: [explicitRuntime],
      onDiscoverAgentRuntimeModels
    });
    const view = render(<DesignsWorkspace {...props} />);

    await waitFor(() =>
      expect(onDiscoverAgentRuntimeModels).toHaveBeenCalledWith('codex')
    );
    expect(screen.getByText('Build a calm project portfolio.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Refine this Design' })).toHaveProperty(
      'disabled',
      true
    );

    view.rerender(
      <DesignsWorkspace
        {...props}
        runtimes={[{ ...explicitRuntime }]}
      />
    );
    expect(onDiscoverAgentRuntimeModels).toHaveBeenCalledTimes(1);

    view.rerender(
      <DesignsWorkspace
        {...props}
        models={[designModel]}
        runtimes={[explicitRuntime]}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Refine this Design' })).toHaveProperty(
      'disabled',
      false
    );

    view.rerender(
      <DesignsWorkspace
        {...props}
        runtimes={[{ ...explicitRuntime }]}
      />
    );
    await waitFor(() =>
      expect(onDiscoverAgentRuntimeModels).toHaveBeenCalledTimes(2)
    );
  });

  it('attaches a file to a later refinement without inheriting it on the next message', async () => {
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('later-message-draft')
    );
    const onSubmitRefinement = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({ onStageAttachmentBatch, onSubmitRefinement })}
      />
    );

    fireEvent.change(conversationReferenceInput(view.container), {
      target: {
        files: [attachmentFile('later-direction.txt', 'text/plain', 'Later direction')]
      }
    });
    expect(screen.getByText('later-direction.txt')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Use the attached direction.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenNthCalledWith(
        1,
        'design-1',
        'Use the attached direction.',
        [],
        'later-message-draft'
      )
    );
    await waitFor(() => expect(screen.queryByText('later-direction.txt')).toBeNull());
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Make the next change without a reference.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenNthCalledWith(
        2,
        'design-1',
        'Make the next change without a reference.',
        [],
        undefined
      )
    );
    expect(onStageAttachmentBatch).toHaveBeenCalledOnce();
  });

  it('does not restore its own newly saved staging batch while the message is sending', async () => {
    const bytes = new TextEncoder().encode('Owned by the current composer');
    const staged = stagedAttachmentDraft(
      'current-composer-draft',
      'current-composer.txt',
      'text/plain',
      bytes.byteLength
    );
    const onReadDesignDraftAttachment = vi.fn(async () => {
      throw new Error('The current composer must not restore its own staged file.');
    });
    const onSubmitRefinement = vi.fn(async () => undefined);

    function StatefulWorkspace() {
      const [draft, setDraft] = useState<DesignsWorkspaceProps['draft']>(null);
      return (
        <DesignsWorkspace
          {...workspaceProps({
            draft,
            onStageAttachmentBatch: async () => staged,
            onReadDesignDraftAttachment,
            onSubmitRefinement,
            onSaveDraft: async (
              designId,
              body,
              referenceIds,
              attachmentDraftId,
              expectedRevision
            ) => {
              const saved = {
                designId,
                body,
                referenceIds,
                attachmentDraftId,
                attachmentDraft: staged,
                recordRevision: expectedRevision + 1,
                updatedAt: '2026-08-20T10:00:00.000Z'
              };
              setDraft(saved);
              return saved;
            }
          })}
        />
      );
    }

    const view = render(<StatefulWorkspace />);
    fireEvent.change(conversationReferenceInput(view.container), {
      target: { files: [attachmentFile('current-composer.txt', 'text/plain', 'Owned')] }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Send the current staged file.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSubmitRefinement).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('current-composer.txt')).toBeNull());
    expect(onReadDesignDraftAttachment).not.toHaveBeenCalled();
  });

  it('supports paste, drop, preview removal, and one exact staged batch in the conversation', async () => {
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('conversation-interaction-draft')
    );
    const onSubmitRefinement = vi.fn(async () => undefined);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({ onStageAttachmentBatch, onSubmitRefinement })}
      />
    );
    const pasted = attachmentFile('pasted.png', 'image/png', 'pasted image');
    const dropped = attachmentFile('dropped.txt', 'text/plain', 'dropped copy');
    const textbox = screen.getByRole('textbox', { name: 'Refine this Design' });
    const composer = view.container.querySelector<HTMLElement>('.tm-design-composer__shell');
    if (!composer) throw new Error('The Design conversation attachment shell was not rendered.');

    fireEvent.paste(textbox, {
      clipboardData: {
        getData: () => '',
        items: [{ kind: 'file', getAsFile: () => pasted }]
      }
    });
    fireEvent.dragEnter(composer, {
      dataTransfer: { types: ['Files'], files: [dropped] }
    });
    expect(screen.getByText('Drop to attach')).toBeTruthy();
    fireEvent.drop(composer, {
      dataTransfer: { types: ['Files'], files: [dropped] }
    });
    expect(screen.getByText('pasted.png')).toBeTruthy();
    expect(screen.getByText('dropped.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted.png' }));
    expect(screen.queryByText('pasted.png')).toBeNull();

    fireEvent.change(textbox, { target: { value: 'Use only the dropped file.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onStageAttachmentBatch).toHaveBeenCalledOnce());
    expect(
      onStageAttachmentBatch.mock.calls[0]?.[0].attachments.map(({ displayName }) => displayName)
    ).toEqual(['dropped.txt']);
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenCalledWith(
        'design-1',
        'Use only the dropped file.',
        [],
        'conversation-interaction-draft'
      )
    );
  });

  it('shows stored references and files, selects turn context, imports, and removes', async () => {
    const attachment = {
      id: 'attachment-1',
      taskId: 'design-1',
      ordinal: 0,
      displayName: 'brand-notes.txt',
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: 32,
      sha256: 'a'.repeat(64),
      createdAt: '2026-08-20T10:00:00.000Z'
    };
    const removedAttachment = {
      ...attachment,
      id: 'attachment-2',
      ordinal: 1,
      displayName: 'old-direction.md',
      byteCount: 18,
      sha256: 'b'.repeat(64)
    };
    const project = designProject({
      references: [
        {
          id: 'reference-1',
          designId: 'design-1',
          attachmentId: attachment.id,
          role: 'REFERENCE',
          state: 'ACTIVE',
          createdAt: '2026-08-20T10:00:00.000Z'
        },
        {
          id: 'reference-2',
          designId: 'design-1',
          attachmentId: removedAttachment.id,
          role: 'REFERENCE',
          state: 'INACTIVE',
          createdAt: '2026-08-20T09:00:00.000Z',
          deactivatedAt: '2026-08-20T10:00:00.000Z'
        }
      ],
      attachments: [attachment, removedAttachment],
      projectFiles: [
        { path: 'assets/logo.svg', byteCount: 512 },
        { path: 'index.html', byteCount: 1_024 }
      ]
    });
    const onSubmitRefinement = vi.fn(async () => undefined);
    const onImportReferenceAsset = vi.fn(async () => undefined);
    const onRemoveReference = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project,
          onSubmitRefinement,
          onImportReferenceAsset,
          onRemoveReference
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /References/ }));
    expect(screen.getByRole('dialog', { name: 'Files and references' })).toBeTruthy();
    expect(screen.getByText('brand-notes.txt')).toBeTruthy();
    fireEvent.click(screen.getByText('Project files'));
    expect(screen.getByText('assets/logo.svg')).toBeTruthy();
    fireEvent.click(screen.getByText('1 removed'));
    expect(screen.getByText('old-direction.md')).toBeTruthy();
    expect(screen.queryByText('Open project')).toBeNull();
    expect(screen.queryByText('Check changes')).toBeNull();

    const selected = screen.getByRole('checkbox', { name: /brand-notes.txt/ });
    expect((selected as HTMLInputElement).checked).toBe(false);
    fireEvent.click(selected);
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Use a quieter headline.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenCalledWith(
        'design-1',
        'Use a quieter headline.',
        ['reference-1'],
        undefined
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(onImportReferenceAsset).toHaveBeenCalledWith('design-1', 'reference-1')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(onRemoveReference).toHaveBeenCalledWith('design-1', 'reference-1')
    );
  });

  it('keeps different stored reference selections on their exact consecutive messages', async () => {
    const onSubmitRefinement = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: projectWithTwoReferences(),
          onSubmitRefinement
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /References/ }));
    const first = screen.getByRole('checkbox', { name: /first-direction.txt/ });
    const second = screen.getByRole('checkbox', { name: /second-direction.txt/ });

    fireEvent.click(first);
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Apply only the first direction.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenNthCalledWith(
        1,
        'design-1',
        'Apply only the first direction.',
        ['reference-first'],
        undefined
      )
    );
    await waitFor(() => expect((first as HTMLInputElement).checked).toBe(false));

    fireEvent.click(second);
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Now apply only the second direction.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenNthCalledWith(
        2,
        'design-1',
        'Now apply only the second direction.',
        ['reference-second'],
        undefined
      )
    );
    await waitFor(() => expect((second as HTMLInputElement).checked).toBe(false));

    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Continue without either old reference.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenNthCalledWith(
        3,
        'design-1',
        'Continue without either old reference.',
        [],
        undefined
      )
    );
  });

  it('adds a post-create reference through the shared attachment composer', async () => {
    const onStageAttachmentBatch = vi.fn(async () => ({
      id: 'post-create-draft',
      attachments: [],
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z'
    }));
    const onAddReferences = vi.fn(async () => []);
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({ onStageAttachmentBatch, onAddReferences })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /References/ }));
    const input = view.container.querySelector<HTMLInputElement>(
      '#design-files-drawer input[type="file"]'
    );
    if (!input) throw new Error('Reference file input was not rendered.');
    const file = new File(['Reference copy'], 'copy.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('Reference copy').buffer
    });
    fireEvent.change(input, {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add references' }));

    await waitFor(() => expect(onStageAttachmentBatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(onAddReferences).toHaveBeenCalledWith('design-1', 'post-create-draft'));
  });

  it('queues another message during active work and exposes Stop', async () => {
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>(
      async () => attachmentDraft('queued-message-draft')
    );
    const onSubmitRefinement = vi.fn(async () => undefined);
    const onStopTurn = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: designProject({
            design: designListItem({ status: 'UPDATING' }),
            currentRun: { id: 'run-1', status: 'RUNNING' } as DesignProjectDetail['currentRun'],
            actions: {
              canRefine: true,
              queuedTurnCount: 1,
              canStop: true,
              stopTurnId: 'turn-1',
              canRestart: false,
              canRestore: false,
              canDuplicate: false,
              canArchive: false,
              canDelete: false
            }
          }),
          onStageAttachmentBatch,
          onSubmitRefinement,
          onStopTurn
        })}
      />
    );

    expect(screen.getByText('1 queued')).toBeTruthy();
    const input = conversationReferenceInput(document.body);
    fireEvent.change(input, {
      target: { files: [attachmentFile('queued.txt', 'text/plain', 'Queued direction')] }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Reduce the chart density.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenCalledWith(
        'design-1',
        'Reduce the chart density.',
        [],
        'queued-message-draft'
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStopTurn).toHaveBeenCalledWith('design-1', 'turn-1');
  });

  it('restores and persists an unsent draft outside the task transcript', async () => {
    const onSaveDraft = vi.fn(async (
      designId,
      body,
      referenceIds,
      attachmentDraftId,
      expectedRevision
    ) => ({
      designId,
      body,
      referenceIds,
      attachmentDraftId,
      recordRevision: expectedRevision + 1,
      updatedAt: '2026-08-20T10:00:00.000Z'
    }));
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          draft: {
            designId: 'design-1',
            body: 'Saved unfinished thought',
            referenceIds: [],
            recordRevision: 3,
            updatedAt: '2026-08-20T10:00:00.000Z'
          },
          onSaveDraft
        })}
      />
    );
    const composer = screen.getByRole('textbox', { name: 'Refine this Design' });
    expect((composer as HTMLTextAreaElement).value).toBe('Saved unfinished thought');
    fireEvent.change(composer, { target: { value: 'Updated unfinished thought' } });

    view.unmount();

    await waitFor(() =>
      expect(onSaveDraft).toHaveBeenCalledWith(
        'design-1',
        'Updated unfinished thought',
        [],
        undefined,
        3
      )
    );
  });

  it('restores saved draft files securely and sends the same staged ownership after reopen', async () => {
    const body = 'Saved attachment body';
    const bytes = new TextEncoder().encode(body);
    const savedAttachmentDraft = stagedAttachmentDraft(
      'saved-conversation-draft',
      'saved-direction.txt',
      'text/plain',
      bytes.byteLength
    );
    const onReadDesignDraftAttachment = vi.fn(async () => ({
      attachmentId: savedAttachmentDraft.attachments[0]!.id,
      displayName: 'saved-direction.txt',
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: bytes.byteLength,
      sha256: savedAttachmentDraft.attachments[0]!.sha256,
      bytes: bytes.buffer
    }));
    const onStageAttachmentBatch = vi.fn<DesignsWorkspaceProps['onStageAttachmentBatch']>();
    const onSubmitRefinement = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          draft: {
            designId: 'design-1',
            body: 'Continue with the saved direction.',
            referenceIds: [],
            attachmentDraftId: savedAttachmentDraft.id,
            attachmentDraft: savedAttachmentDraft,
            recordRevision: 4,
            updatedAt: '2026-08-20T10:00:00.000Z'
          },
          onReadDesignDraftAttachment,
          onStageAttachmentBatch,
          onSubmitRefinement
        })}
      />
    );

    await waitFor(() => expect(screen.getByText('saved-direction.txt')).toBeTruthy());
    expect(onReadDesignDraftAttachment).toHaveBeenCalledWith(
      'design-1',
      savedAttachmentDraft.attachments[0]!.id
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(onSubmitRefinement).toHaveBeenCalledWith(
        'design-1',
        'Continue with the saved direction.',
        [],
        savedAttachmentDraft.id
      )
    );
    expect(onStageAttachmentBatch).not.toHaveBeenCalled();
  });

  it('clears the sent draft before it accepts another message', async () => {
    let finishDelete: (() => void) | undefined;
    const onDeleteDraft = vi.fn(
      () => new Promise<void>((resolve) => {
        finishDelete = resolve;
      })
    );
    render(
      <DesignsWorkspace
        {...workspaceProps({
          draft: {
            designId: 'design-1',
            body: 'Send this saved thought',
            referenceIds: [],
            recordRevision: 2,
            updatedAt: '2026-08-20T10:00:00.000Z'
          },
          onDeleteDraft
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onDeleteDraft).toHaveBeenCalledWith('design-1', 2));
    expect(
      (screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled
    ).toBe(true);
    finishDelete?.();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sending…' })).toBeNull());
  });

  it('loads an earlier transcript page on demand', async () => {
    const onLoadEarlier = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: designProject({ previousConversationCursor: 'before-page' }),
          onLoadEarlier
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));

    expect(onLoadEarlier).toHaveBeenCalledWith('design-1');
  });

  it('embeds one blocking provider response in the conversation', () => {
    const onRespondToInteraction = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: designProject({
            design: designListItem({ status: 'NEEDS_INPUT' }),
            interactions: [userInputInteraction()],
            actions: {
              canRefine: false,
              refineDisabledReason: 'Answer the current question first.',
              queuedTurnCount: 0,
              canStop: true,
              stopTurnId: 'turn-1',
              canRestart: false,
              canRestore: false,
              canDuplicate: false,
              canArchive: false,
              canDelete: false
            }
          }),
          onRespondToInteraction
        })}
      />
    );

    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    const choices = screen.getByRole('group', { name: 'Theme' });
    fireEvent.click(within(choices).getByRole('radio', { name: /Light/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(onRespondToInteraction).toHaveBeenCalledOnce();
    expect(onRespondToInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interaction-1' }),
      {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: { theme: ['Light'] }
      }
    );
  });

  it('confirms deletion and does not dispatch it twice', () => {
    const onDeleteDesign = vi.fn(() => new Promise<void>(() => undefined));
    render(<DesignsWorkspace {...workspaceProps({ onDeleteDesign })} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Design options for Quiet portfolio' })
    );
    expect(
      (screen.getByRole('menuitem', { name: 'Open in Finder' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(screen.getByRole('dialog', { name: /Delete “Quiet portfolio”/ })).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Delete Design' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onDeleteDesign).toHaveBeenCalledOnce();
    expect(onDeleteDesign).toHaveBeenCalledWith('design-1');
  });

  it('offers earlier Ready actions and the small project action menu', async () => {
    const firstRevision = {
      id: 'revision-1',
      designId: 'design-1',
      ordinal: 1,
      commitSha: 'a'.repeat(40),
      routeId: 'main',
      createdAt: '2026-08-20T10:00:00.000Z',
      changeSource: 'AGENT_TURN' as const,
      turnId: 'turn-1',
      runId: 'run-1'
    };
    const secondRevision = {
      ...firstRevision,
      id: 'revision-2',
      ordinal: 2,
      commitSha: 'b'.repeat(40),
      createdAt: '2026-08-20T10:10:00.000Z',
      turnId: 'turn-2',
      runId: 'run-2'
    };
    const onRestoreRevision = vi.fn(async () => undefined);
    const onDuplicateDesign = vi.fn(async () => undefined);
    const onRenameDesign = vi.fn(async () => undefined);
    const onArchiveDesign = vi.fn(async () => undefined);
    const onOpenDesignLocation = vi.fn(async () => undefined);
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: designProject({
            currentWorktree: {
              id: 'worktree-1',
              taskId: 'design-1',
              iterationId: 'iteration-1',
              repositoryId: 'repository-1',
              worktreePath: '/tmp/design-worktree',
              branchName: 'task-monki/design-1',
              baseSha: 'a'.repeat(40),
              status: 'PRESENT',
              createdAt: '2026-08-20T10:00:00.000Z',
              updatedAt: '2026-08-20T10:00:00.000Z'
            },
            revisions: [firstRevision, secondRevision],
            conversation: [
              {
                ...designProject().conversation[0]!,
                readyRevision: firstRevision
              },
              {
                turn: {
                  ...designProject().conversation[0]!.turn,
                  id: 'turn-2',
                  clientMessageId: 'message-2',
                  order: 2,
                  messageSource: 'INLINE_MESSAGE'
                },
                userMessage: 'Move the main action into the header.',
                assistantMessage: 'Moved the action.',
                runStatus: 'COMPLETED',
                readyRevision: secondRevision
              }
            ]
          }),
          onRestoreRevision,
          onDuplicateDesign,
          onRenameDesign,
          onArchiveDesign,
          onOpenDesignLocation
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ready state 1 options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore this version' }));
    await waitFor(() =>
      expect(onRestoreRevision).toHaveBeenCalledWith('design-1', 'revision-1')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ready state 1 options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate from here' }));
    await waitFor(() =>
      expect(onDuplicateDesign).toHaveBeenCalledWith('design-1', 'revision-1')
    );

    const projectMenu = screen.getByRole('button', {
      name: 'Design options for Quiet portfolio'
    });
    fireEvent.click(projectMenu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Finder' }));
    await waitFor(() =>
      expect(onOpenDesignLocation).toHaveBeenCalledWith('design-1', 'worktree-1')
    );
    fireEvent.click(projectMenu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate current' }));
    await waitFor(() =>
      expect(onDuplicateDesign).toHaveBeenCalledWith('design-1', 'revision-2')
    );
    fireEvent.click(projectMenu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Calm portfolio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(onRenameDesign).toHaveBeenCalledWith('design-1', 'Calm portfolio')
    );
    fireEvent.click(projectMenu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(onArchiveDesign).toHaveBeenCalledWith('design-1'));
  });

  it('shows concise source context for a zero-turn Ready copy', () => {
    render(
      <DesignsWorkspace
        {...workspaceProps({
          project: designProject({
            conversation: [],
            turns: [],
            origin: {
              designId: 'source-design',
              revisionId: 'source-revision',
              designTitle: 'Original portfolio',
              revisionOrdinal: 3
            }
          })
        })}
      />
    );

    expect(screen.getByText('Copied from Original portfolio · Ready state 3')).toBeTruthy();
    expect(screen.getByText('Continue from this ready copy')).toBeTruthy();
  });

  it('shows the desktop-only canvas notice in a browser build', () => {
    render(
      <DesignsWorkspace
        {...workspaceProps({ desktopCanvasAvailable: false })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Canvas only' }));
    expect(screen.getByText('Canvas is available in the desktop app')).toBeTruthy();
    expect(screen.queryByLabelText('Quiet portfolio preview')).toBeNull();
  });

  it('reports only the selected stored canvas target and finite host bounds', () => {
    const boundsSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 12,
      y: 24,
      width: 1_200,
      height: 720,
      top: 24,
      left: 12,
      right: 1_212,
      bottom: 744,
      toJSON: () => ({})
    });
    const onShowCanvas = vi.fn();
    const onHideCanvas = vi.fn();
    const onRefreshCanvas = vi.fn(async () => undefined);
    const props = workspaceProps({
      onShowCanvas,
      onHideCanvas,
      onRefreshCanvas
    });
    const view = render(
      <DesignsWorkspace
        {...props}
      />
    );

    expect(onShowCanvas).toHaveBeenCalledWith({
      designId: 'design-1',
      taskId: 'design-1',
      generationId: 'generation-1',
      routeId: 'route-1',
      requestId: expect.any(Number),
      bounds: { x: 12, y: 24, width: 1_200, height: 720 }
    });
    expect(onShowCanvas.mock.calls[0]?.[0]).not.toHaveProperty('url');
    expect(screen.getByText('v1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Desktop' }).getAttribute('aria-pressed'))
      .toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
    expect(screen.getByRole('button', { name: 'Tablet' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(view.container.querySelector('.tm-design-canvas__viewport')?.getAttribute('data-device'))
      .toBe('tablet');
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }));
    expect(onRefreshCanvas).toHaveBeenCalledWith({
      designId: 'design-1',
      generationId: 'generation-1',
      requestId: expect.any(Number)
    });

    view.rerender(<DesignsWorkspace {...props} canvasOccluded />);
    expect(screen.getByText('Canvas hidden')).toBeTruthy();
    expect(onHideCanvas).toHaveBeenCalled();

    view.unmount();
    boundsSpy.mockRestore();
  });

  it('previews an earlier version before it offers an explicit restore', async () => {
    const revisions: DesignProjectDetail['revisions'] = [
      {
        id: 'revision-1',
        designId: 'design-1',
        ordinal: 1,
        commitSha: 'a'.repeat(40),
        routeId: 'route-1',
        createdAt: '2026-08-20T09:00:00.000Z',
        changeSource: 'AGENT_TURN',
        turnId: 'turn-1',
        runId: 'run-1'
      },
      {
        id: 'revision-2',
        designId: 'design-1',
        ordinal: 2,
        commitSha: 'b'.repeat(40),
        routeId: 'route-2',
        createdAt: '2026-08-20T10:00:00.000Z',
        changeSource: 'AGENT_TURN',
        turnId: 'turn-2',
        runId: 'run-2'
      }
    ];
    const onSelectRevision = vi.fn(async () => undefined);
    const onRestoreRevision = vi.fn(async () => undefined);
    const currentProject = designProject({
      revisions,
      canvas: {
        state: 'READY',
        target: {
          generationId: 'generation-2',
          routeId: 'route-2',
          revisionId: 'revision-2'
        }
      }
    });
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          project: currentProject,
          onSelectRevision,
          onRestoreRevision
        })}
      />
    );

    expect(screen.queryByLabelText('Earlier version preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    await waitFor(() =>
      expect(onSelectRevision).toHaveBeenCalledWith('design-1', 'revision-1')
    );
    expect(onRestoreRevision).not.toHaveBeenCalled();

    view.rerender(
      <DesignsWorkspace
        {...workspaceProps({
          project: {
            ...currentProject,
            canvas: {
              state: 'READY',
              target: {
                generationId: 'generation-1',
                routeId: 'route-1',
                revisionId: 'revision-1'
              }
            }
          },
          onSelectRevision,
          onRestoreRevision
        })}
      />
    );

    expect(screen.getByLabelText('Earlier version preview')).toBeTruthy();
    expect(screen.getByText('Viewing v1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to v2' }));
    await waitFor(() =>
      expect(onSelectRevision).toHaveBeenLastCalledWith('design-1', 'revision-2')
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Restore version 1 as a new version' })
    );
    await waitFor(() =>
      expect(onRestoreRevision).toHaveBeenCalledWith('design-1', 'revision-1')
    );
  });

  it('shows checked candidate progress without enabling the external Ready action', () => {
    const boundsSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 900,
      height: 640,
      top: 0,
      left: 0,
      right: 900,
      bottom: 640,
      toJSON: () => ({})
    });
    const onShowCanvas = vi.fn();
    const onOpenCanvas = vi.fn(async () => undefined);
    const project = designProject({
      design: designListItem({ status: 'UPDATING' }),
      revisions: [{
        id: 'revision-1',
        designId: 'design-1',
        ordinal: 1,
        commitSha: 'a'.repeat(40),
        routeId: 'route-1',
        createdAt: '2026-08-20T10:00:00.000Z',
        changeSource: 'AGENT_TURN',
        turnId: 'turn-1',
        runId: 'run-1'
      }],
      canvas: {
        state: 'PREVIEWING',
        target: { generationId: 'candidate-1', routeId: 'route-1' }
      },
      actions: {
        ...designProject().actions,
        canRestore: false
      }
    });

    render(
      <DesignsWorkspace
        {...workspaceProps({ project, onShowCanvas, onOpenCanvas })}
      />
    );

    expect(onShowCanvas).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'candidate-1',
      routeId: 'route-1'
    }));
    expect(screen.getByText('checking v2')).toBeTruthy();
    expect(screen.getByText('v2').getAttribute('aria-current')).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'Open preview in browser' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.queryByText('v1 ready')).toBeNull();
    expect(onOpenCanvas).not.toHaveBeenCalled();
    boundsSpy.mockRestore();
  });
});

function workspaceProps(
  overrides: Partial<DesignsWorkspaceProps> = {}
): DesignsWorkspaceProps {
  const project = designProject();
  return {
    designs: [project.design],
    selectedDesignId: project.design.id,
    project,
    draft: null,
    models: [designModel],
    runtimes: [designRuntime],
    defaultAgentSettings: {
      runtimeId: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium'
    },
    desktopCanvasAvailable: true,
    onSelectDesign: vi.fn(),
    onCreateBlankDesign: vi.fn(async () => undefined),
    onSubmitRefinement: vi.fn(async () => undefined),
    onStageAttachmentBatch: vi.fn(async () => ({
      id: 'design-reference-draft',
      attachments: [],
      byteCount: 0,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z'
    })),
    onDiscardAttachmentDraft: vi.fn(async () => undefined),
    onReadDesignDraftAttachment: vi.fn(async () => {
      throw new Error('No saved draft attachment was expected.');
    }),
    onAddReferences: vi.fn(async () => []),
    onRemoveReference: vi.fn(async () => undefined),
    onImportReferenceAsset: vi.fn(async () => undefined),
    onStopTurn: vi.fn(async () => undefined),
    onLoadEarlier: vi.fn(async () => undefined),
    onSaveDraft: vi.fn(async (
      designId,
      body,
      referenceIds,
      attachmentDraftId,
      expectedRevision
    ) => ({
      designId,
      body,
      referenceIds,
      attachmentDraftId,
      recordRevision: expectedRevision + 1,
      updatedAt: '2026-08-20T10:00:00.000Z'
    })),
    onDeleteDraft: vi.fn(async () => undefined),
    onRespondToInteraction: vi.fn(async () => undefined),
    onRefreshCanvas: vi.fn(async () => undefined),
    onRestartCanvas: vi.fn(async () => undefined),
    onSelectRevision: vi.fn(async () => undefined),
    onOpenDesignLocation: vi.fn(async () => undefined),
    onRestoreRevision: vi.fn(async () => undefined),
    onDuplicateDesign: vi.fn(async () => undefined),
    onRenameDesign: vi.fn(async () => undefined),
    onArchiveDesign: vi.fn(async () => undefined),
    onDeleteDesign: vi.fn(async () => undefined),
    ...overrides
  };
}

function designListItem(overrides: Partial<DesignListItem> = {}): DesignListItem {
  return {
    id: 'design-1',
    title: 'Quiet portfolio',
    runtimeId: 'codex',
    status: 'READY',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides
  };
}

function designProject(
  overrides: Partial<DesignProjectDetail> = {}
): DesignProjectDetail {
  return {
    schemaVersion: TASK_STORE_SCHEMA_VERSION,
    design: designListItem(),
    task: {
      id: 'design-1',
      kind: 'DESIGN',
      runtimeId: 'codex',
      agentSettings: {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'medium'
      }
    } as DesignProjectDetail['task'],
    repository: {
      id: 'repository-1',
      kind: 'DESIGN_MANAGED'
    } as DesignProjectDetail['repository'],
    turns: [],
    references: [],
    attachments: [],
    projectFiles: [],
    projectFilesTruncated: false,
    revisions: [],
    readyContext: [],
    conversation: [
      {
        turn: {
          id: 'turn-1',
          designId: 'design-1',
          clientMessageId: 'message-1',
          order: 1,
          messageSource: 'TASK_PROMPT',
          referenceIds: [],
          outcome: 'READY',
          createdAt: '2026-08-20T10:00:00.000Z'
        },
        userMessage: 'Build a calm project portfolio.',
        assistantMessage: 'Built the first page.',
        runStatus: 'COMPLETED'
      }
    ],
    interactions: [],
    sessions: [],
    items: [],
    canvas: {
      state: 'READY',
      target: { generationId: 'generation-1', routeId: 'route-1' }
    },
    actions: {
      canRefine: true,
      queuedTurnCount: 0,
      canStop: false,
      canRestart: false,
      canRestore: true,
      canDuplicate: true,
      canArchive: true,
      canDelete: true
    },
    ...overrides
  };
}

function projectWithTwoReferences(): DesignProjectDetail {
  const attachments = [
    {
      id: 'attachment-first',
      taskId: 'design-1',
      ordinal: 0,
      displayName: 'first-direction.txt',
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: 16,
      sha256: 'a'.repeat(64),
      createdAt: '2026-08-20T10:00:00.000Z'
    },
    {
      id: 'attachment-second',
      taskId: 'design-1',
      ordinal: 1,
      displayName: 'second-direction.txt',
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: 17,
      sha256: 'b'.repeat(64),
      createdAt: '2026-08-20T10:00:00.000Z'
    }
  ];
  return designProject({
    attachments,
    references: [
      {
        id: 'reference-first',
        designId: 'design-1',
        attachmentId: attachments[0]!.id,
        role: 'REFERENCE',
        state: 'ACTIVE',
        createdAt: '2026-08-20T10:00:00.000Z'
      },
      {
        id: 'reference-second',
        designId: 'design-1',
        attachmentId: attachments[1]!.id,
        role: 'REFERENCE',
        state: 'ACTIVE',
        createdAt: '2026-08-20T10:00:00.000Z'
      }
    ]
  });
}

const designModel: AgentModel = {
  id: 'codex:gpt-5.6-luna',
  runtimeId: 'codex',
  model: 'gpt-5.6-luna',
  displayName: 'Luna',
  hidden: false,
  supportedReasoningEfforts: ['medium'],
  defaultReasoningEffort: 'medium',
  serviceTiers: [],
  inputModalities: ['text', 'image'],
  designSupport: { maturity: 'stable' },
  isDefault: true
};

function attachmentDraft(id: string): AttachmentDraftSnapshot {
  return {
    id,
    attachments: [],
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z'
  };
}

function stagedAttachmentDraft(
  id: string,
  displayName: string,
  mediaType: string,
  byteCount: number
): AttachmentDraftSnapshot {
  return {
    id,
    attachments: [{
      id: 'saved-draft-attachment-0001',
      draftId: id,
      ordinal: 0,
      displayName,
      kind: mediaType.startsWith('image/') ? 'image' : 'text',
      mediaType,
      byteCount,
      sha256: 'c'.repeat(64),
      createdAt: '2026-08-20T10:00:00.000Z'
    }],
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z'
  };
}

function attachmentFile(name: string, type: string, body: string): File {
  const file = new File([body], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(body).buffer
  });
  return file;
}

function designReferenceInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    '.tm-design-create input[type="file"]'
  );
  if (!input) throw new Error('The initial Design reference input was not rendered.');
  return input;
}

function conversationReferenceInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    '.tm-design-composer input[type="file"]'
  );
  if (!input) throw new Error('The Design conversation file input was not rendered.');
  return input;
}

function installSafeImageDecoder(): void {
  const NativeFile = File;
  class TestFile extends NativeFile {
    arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.resolve(new TextEncoder().encode('normalized image').buffer);
    }
  }

  class TestImageDecoder {
    readonly tracks = {
      ready: Promise.resolve(),
      selectedTrack: { codedWidth: 1, codedHeight: 1 }
    };

    decode(): Promise<{ image: TestImageFrame }> {
      return Promise.resolve({ image: new TestImageFrame() });
    }

    close(): void {}
  }

  class TestImageFrame {
    readonly displayWidth = 1;
    readonly displayHeight = 1;

    close(): void {}
  }

  class TestOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number
    ) {}

    getContext(): { drawImage(): void } {
      return { drawImage: () => undefined };
    }

    convertToBlob(input: { type: string }): Promise<Blob> {
      return Promise.resolve(new Blob(['normalized image'], { type: input.type }));
    }
  }

  vi.stubGlobal('ImageDecoder', TestImageDecoder);
  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);
  vi.stubGlobal('File', TestFile);
}

const designRuntime = {
  preflight: {
    runtime: {
      id: 'codex',
      displayName: 'Codex',
      kind: 'APP_SERVER',
      transport: 'STDIO',
      lifecycleScope: 'APPLICATION'
    },
    readiness: {
      status: 'READY',
      canStart: true,
      summary: 'Ready',
      detail: 'Ready',
      checks: {
        discovery: 'FOUND',
        compatibility: 'COMPATIBLE',
        initialization: 'INITIALIZED',
        authentication: 'PROVIDER_MANAGED',
        modelCatalog: 'AVAILABLE'
      },
      diagnostics: []
    },
    capabilities: codexCapabilities()
  },
  models: [designModel],
  refreshedAt: '2026-08-20T10:00:00.000Z'
} as AgentRuntimeState;

function userInputInteraction(): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    runtimeId: 'codex',
    serverInstanceId: 'server-1',
    providerRequestId: 'question-1',
    taskId: 'design-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerTurnId: 'message-1',
    type: 'USER_INPUT',
    status: 'PENDING',
    request: {
      questions: [
        {
          id: 'theme',
          header: 'Theme',
          question: 'Which theme should the preview use?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Light', description: 'Use a light canvas.' },
            { label: 'Dark', description: 'Use a dark canvas.' }
          ]
        }
      ]
    },
    allowedActions: ['ANSWER'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-08-20T10:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    requestedAt: '2026-08-20T10:00:00.000Z'
  };
}
