import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentRuntimeState,
  InteractionRequestRecord,
  DesignListItem
} from '../../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import type { DesignProjectDetail } from '../model/designs';
import { DesignsWorkspace, type DesignsWorkspaceProps } from './DesignsWorkspace';

describe('mounted Design workspace', () => {
  it('waits for the first list read before it shows the blank form', () => {
    const props = workspaceProps({
      designs: [],
      selectedDesignId: undefined,
      project: undefined,
      loading: true
    });
    const view = render(<DesignsWorkspace {...props} />);

    expect(screen.getByText('Loading Design')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New blank Design' })).toBeNull();

    view.rerender(<DesignsWorkspace {...props} loading={false} />);
    expect(screen.getByRole('heading', { name: 'New blank Design' })).toBeTruthy();
  });

  it('creates one blank Design with the selected compatible model', () => {
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

    expect(screen.getByRole('heading', { name: 'New blank Design' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Design: Codex · Luna/ })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: '  Build a calm project portfolio.  ' }
    });
    const create = screen.getByRole('button', { name: 'Create Design' });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(onCreateBlankDesign).toHaveBeenCalledOnce();
    expect(onCreateBlankDesign).toHaveBeenCalledWith({
      brief: 'Build a calm project portfolio.',
      creationToken: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/u),
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium'
    });
  });

  it('reuses the blank Design creation token after a failed request', async () => {
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
          onCreateBlankDesign
        })}
      />
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), {
      target: { value: 'Build a calm project portfolio.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Connection lost.');

    fireEvent.click(screen.getByRole('button', { name: 'Create Design' }));
    await waitFor(() => expect(onCreateBlankDesign).toHaveBeenCalledTimes(2));

    expect(onCreateBlankDesign.mock.calls[1]?.[0].creationToken).toBe(
      onCreateBlankDesign.mock.calls[0]?.[0].creationToken
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
    const composer = screen.getByRole('textbox', { name: 'Refine this Design' });
    fireEvent.change(composer, { target: { value: '  Increase the title contrast.  ' } });
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => expect(onSubmitRefinement).toHaveBeenCalledOnce());
    expect(onSubmitRefinement).toHaveBeenCalledWith(
      'design-1',
      'Increase the title contrast.'
    );
  });

  it('queues another message during active work and exposes Stop', async () => {
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
              canDelete: false
            }
          }),
          onSubmitRefinement,
          onStopTurn
        })}
      />
    );

    expect(screen.getByText('1 queued')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Refine this Design' }), {
      target: { value: 'Reduce the chart density.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(onSubmitRefinement).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStopTurn).toHaveBeenCalledWith('design-1', 'turn-1');
  });

  it('restores and persists an unsent draft outside the task transcript', async () => {
    const onSaveDraft = vi.fn(async (designId, body, expectedRevision) => ({
      designId,
      body,
      recordRevision: expectedRevision + 1,
      updatedAt: '2026-08-20T10:00:00.000Z'
    }));
    const view = render(
      <DesignsWorkspace
        {...workspaceProps({
          draft: {
            designId: 'design-1',
            body: 'Saved unfinished thought',
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
        3
      )
    );
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: /Delete “Quiet portfolio”/ })).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Delete Design' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onDeleteDesign).toHaveBeenCalledOnce();
    expect(onDeleteDesign).toHaveBeenCalledWith('design-1');
  });

  it('shows the desktop-only canvas notice in a browser build', () => {
    render(
      <DesignsWorkspace
        {...workspaceProps({ desktopCanvasAvailable: false })}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
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
    onStopTurn: vi.fn(async () => undefined),
    onLoadEarlier: vi.fn(async () => undefined),
    onSaveDraft: vi.fn(async (designId, body, expectedRevision) => ({
      designId,
      body,
      recordRevision: expectedRevision + 1,
      updatedAt: '2026-08-20T10:00:00.000Z'
    })),
    onDeleteDraft: vi.fn(async () => undefined),
    onRespondToInteraction: vi.fn(async () => undefined),
    onRefreshCanvas: vi.fn(async () => undefined),
    onRestartCanvas: vi.fn(async () => undefined),
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
    task: { id: 'design-1', kind: 'DESIGN' } as DesignProjectDetail['task'],
    repository: {
      id: 'repository-1',
      kind: 'DESIGN_MANAGED'
    } as DesignProjectDetail['repository'],
    turns: [],
    references: [],
    revisions: [],
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
      canDelete: true
    },
    ...overrides
  };
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
  inputModalities: ['text'],
  isDefault: true
};

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
