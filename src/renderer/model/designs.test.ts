import { describe, expect, it } from 'vitest';
import {
  TASK_STORE_SCHEMA_VERSION,
  type AgentRuntimeCatalog,
  type AppUpdateEvent,
  type DesignListItem
} from '../../shared/contracts';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import {
  designCanvasClientEvent,
  designCanvasPresentation,
  designProjectStatus,
  designStatusView,
  designTurnView,
  designWorkspaceLayout,
  designWorkspaceIsCompact,
  designModelUnavailableReason,
  eligibleDesignRuntimeCatalog,
  designRuntimeUnavailableReason,
  finiteDesignCanvasBounds,
  mergeDesignConversationPage,
  mergeDesignDetailHistory,
  supportedDesignModels,
  sortedDesignProjects,
  visibleDesignProjects,
  type DesignProjectDetail
} from './designs';

describe('Design workspace view model', () => {
  it('accepts only scoped external-link canvas requests', () => {
    const event = canvasUpdateEvent({
      reason: 'external-link-requested',
      canvasEvent: {
        type: 'external-link-requested',
        designId: 'design-1',
        pendingId: 'pending-1',
        destinationHost: 'example.com'
      }
    });

    expect(designCanvasClientEvent(event)).toEqual({
      kind: 'EXTERNAL_LINK_REQUESTED',
      request: {
        designId: 'design-1',
        pendingId: 'pending-1',
        destinationHost: 'example.com'
      }
    });
    expect(
      designCanvasClientEvent({
        ...event,
        payload: {
          reason: 'external-link-requested',
          canvasEvent: {
            type: 'external-link-requested',
            designId: 'design-2',
            pendingId: 'pending-1',
            destinationHost: 'example.com'
          }
        }
      })
    ).toBeUndefined();
  });

  it('accepts a matching load failure without exposing its raw reason', () => {
    const event = canvasUpdateEvent(
      {
        reason: 'load-failed',
        canvasEvent: {
          type: 'load-failed',
          designId: 'design-1',
          generationId: 'generation-1',
          reason: 'private runtime detail'
        }
      },
      'generation-1'
    );

    expect(designCanvasClientEvent(event)).toEqual({
      kind: 'LOAD_FAILED',
      designId: 'design-1',
      generationId: 'generation-1'
    });
    expect(
      designCanvasClientEvent({ ...event, previewGenerationId: 'generation-2' })
    ).toBeUndefined();
  });

  it('maps working, blocked, ready, and attention states to semantic tones', () => {
    expect(designStatusView('RUNNING')).toMatchObject({
      label: 'Running',
      tone: 'working'
    });
    expect(designStatusView('UPDATING')).toMatchObject({
      label: 'Updating',
      tone: 'working'
    });
    expect(designStatusView('NEEDS_INPUT')).toMatchObject({
      label: 'Blocked',
      tone: 'waiting'
    });
    expect(designStatusView('READY')).toMatchObject({
      label: 'Ready',
      tone: 'verified'
    });
    expect(designStatusView('NEEDS_ATTENTION')).toMatchObject({
      label: 'Needs attention',
      tone: 'blocked'
    });
  });

  it('orders Designs by their authoritative update time without mutating the input', () => {
    const input = [
      designListItem({ id: 'older', title: 'Older', updatedAt: '2026-08-19T10:00:00Z' }),
      designListItem({ id: 'newer', title: 'Newer', updatedAt: '2026-08-20T10:00:00Z' })
    ];

    expect(sortedDesignProjects(input).map(({ id }) => id)).toEqual(['newer', 'older']);
    expect(input.map(({ id }) => id)).toEqual(['older', 'newer']);
  });

  it('filters Design history without changing its authoritative summaries', () => {
    const input = [
      designListItem({ id: 'active', title: 'Launch page', status: 'READY' }),
      designListItem({ id: 'archived', title: 'Old launch', status: 'ARCHIVED' })
    ];

    expect(visibleDesignProjects(input, 'launch', 'active').map(({ id }) => id)).toEqual([
      'active'
    ]);
    expect(visibleDesignProjects(input, '', 'archived').map(({ id }) => id)).toEqual([
      'archived'
    ]);
    expect(input).toHaveLength(2);
  });

  it('keeps a last ready canvas visible while an update runs', () => {
    const presentation = designCanvasPresentation({
      project: designProject({
        design: designListItem({ status: 'UPDATING' }),
        canvas: {
          state: 'READY',
          target: { generationId: 'generation-1', routeId: 'route-1' }
        }
      }),
      desktopAvailable: true,
      occluded: false
    });

    expect(presentation).toEqual({
      kind: 'NATIVE',
      target: { generationId: 'generation-1', routeId: 'route-1' },
      progress: false
    });
  });

  it('presents an opened candidate as canvas progress without calling it Ready', () => {
    expect(
      designCanvasPresentation({
        project: designProject({
          design: designListItem({ status: 'UPDATING' }),
          canvas: {
            state: 'PREVIEWING',
            target: { generationId: 'candidate-1', routeId: 'route-1' }
          }
        }),
        desktopAvailable: true,
        occluded: false
      })
    ).toEqual({
      kind: 'NATIVE',
      target: { generationId: 'candidate-1', routeId: 'route-1' },
      progress: true
    });
  });

  it('hides native content for an overlay and reports browser-only fallback', () => {
    const project = designProject({
      canvas: {
        state: 'READY',
        target: { generationId: 'generation-1', routeId: 'route-1' }
      }
    });

    expect(
      designCanvasPresentation({ project, desktopAvailable: true, occluded: true }).kind
    ).toBe('HIDDEN');
    expect(
      designCanvasPresentation({ project, desktopAvailable: false, occluded: false })
    ).toMatchObject({ kind: 'DESKTOP_ONLY' });
  });

  it('offers Restart only when the projection permits it', () => {
    expect(
      designCanvasPresentation({
        project: designProject({
          design: designListItem({ status: 'NEEDS_ATTENTION' }),
          canvas: { state: 'RESTART_REQUIRED', detail: 'The preview process stopped.' },
          actions: {
            canRefine: true,
            queuedTurnCount: 0,
            canStop: false,
            canRestart: true,
            canRestore: true,
            canDuplicate: true,
            canArchive: true,
            canDelete: true
          }
        }),
        desktopAvailable: true,
        occluded: false
      })
    ).toMatchObject({ kind: 'PLACEHOLDER', restart: true });
  });

  it('shows Running only after the first Design run starts', () => {
    expect(
      designProjectStatus(
        designProject({
          design: designListItem({ status: 'STARTING' }),
          currentRun: {
            id: 'run-1',
            status: 'RUNNING'
          } as DesignProjectDetail['currentRun']
        })
      )
    ).toBe('RUNNING');
    expect(
      designProjectStatus(
        designProject({ design: designListItem({ status: 'STARTING' }) })
      )
    ).toBe('STARTING');
  });

  it('derives transcript state from the durable turn and run projection', () => {
    const entry = {
      turn: {
        id: 'turn-1',
        designId: 'design-1',
        clientMessageId: 'message-1',
        order: 1,
        messageSource: 'TASK_PROMPT' as const,
        referenceIds: [],
        checkpoint: { boundary: 'RUN_LINKED' as const },
        createdAt: '2026-08-20T10:00:00.000Z'
      },
      userMessage: 'Build a portfolio.',
      runStatus: 'RUNNING' as const
    };

    expect(designTurnView(entry)).toMatchObject({
      status: 'RUNNING',
      statusLabel: 'Working'
    });
    expect(
      designTurnView({
        ...entry,
        runStatus: 'COMPLETED',
        turn: { ...entry.turn, outcome: 'NO_CHANGE' }
      })
    ).toMatchObject({ status: 'NO_CHANGE', statusLabel: 'No visual change' });
    expect(
      designTurnView({
        ...entry,
        runStatus: 'INTERRUPTED',
        turn: { ...entry.turn, outcome: 'CANCELED' }
      })
    ).toMatchObject({ status: 'CANCELED', statusLabel: 'Stopped' });
  });

  it('keeps unsupported runtimes and models visible while qualifying Design defaults', () => {
    const supported = runtimeState('codex', codexCapabilities());
    const unsupportedStop = runtimeState('without-stop', {
      ...codexCapabilities(),
      runtimeId: 'without-stop',
      turnInterruption: { maturity: 'unsupported' }
    });
    const unsupportedAttachments = runtimeState('without-attachments', {
      ...codexCapabilities(),
      runtimeId: 'without-attachments',
      attachmentDelivery: { maturity: 'unsupported' }
    });
    const catalog = {
      runtimes: [unsupportedStop, unsupportedAttachments, supported],
      models: [
        { id: 'stop:model', runtimeId: 'without-stop', model: 'model' },
        {
          id: 'attachments:model',
          runtimeId: 'without-attachments',
          model: 'model'
        },
        {
          id: 'codex:model',
          runtimeId: 'codex',
          model: 'model',
          inputModalities: ['text', 'image'],
          designSupport: { maturity: 'stable' }
        },
        {
          id: 'codex:unsupported',
          runtimeId: 'codex',
          model: 'unsupported',
          inputModalities: ['text', 'image'],
          designSupport: {
            maturity: 'unsupported',
            detail: 'This model does not support Design Mode.'
          }
        }
      ],
      defaultRuntimeId: 'without-stop'
    } as AgentRuntimeCatalog;

    expect(eligibleDesignRuntimeCatalog(catalog)).toMatchObject({
      defaultRuntimeId: 'codex',
      runtimes: [unsupportedStop, unsupportedAttachments, supported],
      models: [
        { id: 'stop:model' },
        { id: 'attachments:model' },
        { id: 'codex:model' },
        { id: 'codex:unsupported' }
      ]
    });
    expect(supportedDesignModels(catalog.runtimes, catalog.models)).toEqual([
      expect.objectContaining({ id: 'codex:model' })
    ]);
    expect(designRuntimeUnavailableReason(unsupportedStop, [])).toContain(
      'cannot apply Design instructions'
    );
  });

  it('keeps explicit model discovery available before capabilities are loaded', () => {
    const capabilities = {
      ...codexCapabilities(),
      runtimeId: 'cursor-agent-acp',
      modelCatalog: {
        ...codexCapabilities().modelCatalog,
        activation: 'EXPLICIT' as const
      },
      extensions: {}
    };
    const runtime = runtimeState('cursor-agent-acp', capabilities);
    runtime.models = [
      {
        id: 'cursor-agent-acp:auto',
        runtimeId: 'cursor-agent-acp',
        model: 'auto',
        inputModalities: ['text']
      }
    ] as AgentRuntimeCatalog['models'];
    runtime.preflight.readiness.checks.modelCatalog = 'UNKNOWN';
    const catalog = {
      runtimes: [runtime],
      models: runtime.models,
      defaultRuntimeId: 'cursor-agent-acp'
    } as AgentRuntimeCatalog;

    expect(eligibleDesignRuntimeCatalog(catalog)).toMatchObject({
      runtimes: [{ preflight: { runtime: { id: 'cursor-agent-acp' } } }],
      models: [{ id: 'cursor-agent-acp:auto' }]
    });
    expect(designRuntimeUnavailableReason(runtime, runtime.models)).toBeUndefined();
  });

  it('keeps the provider reason for an unsupported Design model', () => {
    const runtime = runtimeState('codex', codexCapabilities());
    runtime.models = [{
      id: 'codex:unsupported',
      runtimeId: 'codex',
      model: 'unsupported',
      inputModalities: ['text', 'image'],
      designSupport: {
        maturity: 'unsupported',
        detail: 'This model does not report the capabilities required by Design Mode.'
      }
    }] as AgentRuntimeCatalog['models'];
    const catalog = {
      runtimes: [runtime],
      models: runtime.models,
      defaultRuntimeId: 'codex'
    } as AgentRuntimeCatalog;

    expect(eligibleDesignRuntimeCatalog(catalog)).toMatchObject({
      runtimes: [{ preflight: { runtime: { id: 'codex' } } }],
      models: [{ id: 'codex:unsupported' }]
    });
    expect(supportedDesignModels([runtime], runtime.models)).toEqual([]);
    expect(designModelUnavailableReason(runtime, runtime.models[0]!)).toBe(
      'This model does not report the capabilities required by Design Mode.'
    );
    expect(designRuntimeUnavailableReason(runtime, runtime.models)).toBe(
      'This model does not report the capabilities required by Design Mode.'
    );
  });

  it('does not choose an unavailable runtime as the Design default', () => {
    const unavailable = runtimeState('offline', codexCapabilities());
    unavailable.preflight.readiness.canStart = false;
    unavailable.preflight.readiness.detail = 'Sign in to this provider.';
    const ready = runtimeState('ready', {
      ...codexCapabilities(),
      runtimeId: 'ready'
    });
    const models = [unavailable, ready].map((runtime) => ({
      id: `${runtime.preflight.runtime.id}:model`,
      runtimeId: runtime.preflight.runtime.id,
      model: 'model',
      inputModalities: ['text', 'image'],
      designSupport: { maturity: 'stable' as const }
    })) as AgentRuntimeCatalog['models'];

    expect(
      eligibleDesignRuntimeCatalog({
        runtimes: [unavailable, ready],
        models,
        defaultRuntimeId: 'offline'
      } as AgentRuntimeCatalog).defaultRuntimeId
    ).toBe('ready');
  });

  it('prepends transcript pages and keeps them across live detail refreshes', () => {
    const newest = designProject({
      conversation: [conversationEntry(3), conversationEntry(4)],
      previousConversationCursor: 'before-3'
    });
    const paged = mergeDesignConversationPage(newest, {
      entries: [conversationEntry(1), conversationEntry(2)],
      previousCursor: undefined
    });
    expect(paged.conversation.map((entry) => entry.turn.order)).toEqual([1, 2, 3, 4]);
    expect(paged.previousConversationCursor).toBeUndefined();

    const refreshed = mergeDesignDetailHistory(
      paged,
      designProject({ conversation: [conversationEntry(4), conversationEntry(5)] })
    );
    expect(refreshed.conversation.map((entry) => entry.turn.order)).toEqual([1, 2, 3, 4, 5]);
    expect(refreshed.previousConversationCursor).toBeUndefined();
  });

  it('accepts only finite positive native-view bounds', () => {
    expect(finiteDesignCanvasBounds({ x: 10, y: 20, width: 640, height: 480 })).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 480
    });
    expect(finiteDesignCanvasBounds({ x: 0, y: 0, width: 0, height: 480 })).toBeUndefined();
    expect(
      finiteDesignCanvasBounds({ x: Number.NaN, y: 0, width: 640, height: 480 })
    ).toBeUndefined();
  });

  it('offers split only when the remaining main workspace can render it truthfully', () => {
    expect(designWorkspaceLayout(1_052, false)).toMatchObject({
      splitAvailable: false,
      availableModes: ['chat', 'canvas']
    });
    expect(designWorkspaceLayout(1_053, false)).toMatchObject({
      splitAvailable: true,
      availableModes: ['chat', 'split', 'canvas']
    });
    expect(designWorkspaceLayout(780, true).splitAvailable).toBe(true);
    expect(designWorkspaceLayout(1_100, false, 320).mainWidth).toBe(775);
    expect(designWorkspaceIsCompact(1_052)).toBe(true);
    expect(designWorkspaceIsCompact(1_053)).toBe(false);
    expect(designWorkspaceIsCompact(Number.NaN)).toBe(false);
  });
});

function canvasUpdateEvent(
  payload: unknown,
  previewGenerationId?: string
): AppUpdateEvent {
  return {
    type: 'design.updated',
    scope: { kind: 'DESIGN', designId: 'design-1' },
    taskId: 'design-1',
    previewGenerationId,
    payload,
    at: '2026-08-20T10:00:00.000Z'
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
    turns: [],
    references: [],
    attachments: [],
    projectFiles: [],
    projectFilesTruncated: false,
    revisions: [],
    readyContext: [],
    conversation: [],
    interactions: [],
    sessions: [],
    items: [],
    task: { id: 'design-1', kind: 'DESIGN' } as DesignProjectDetail['task'],
    repository: {
      id: 'repository-1',
      kind: 'DESIGN_MANAGED'
    } as DesignProjectDetail['repository'],
    canvas: { state: 'EMPTY' },
    actions: {
      canRefine: true,
      queuedTurnCount: 0,
      canStop: false,
      canRestart: false,
      canRestore: false,
      canDuplicate: false,
      canArchive: true,
      canDelete: true
    },
    ...overrides
  };
}

function conversationEntry(order: number): DesignProjectDetail['conversation'][number] {
  return {
    turn: {
      id: `turn-${order}`,
      designId: 'design-1',
      clientMessageId: `message-${order}`,
      order,
      messageSource: order === 1 ? 'TASK_PROMPT' : 'INLINE_MESSAGE',
      referenceIds: [],
      createdAt: '2026-08-20T10:00:00.000Z'
    },
    userMessage: `Message ${order}`
  };
}

function runtimeState(
  runtimeId: string,
  capabilities: ReturnType<typeof codexCapabilities>
): AgentRuntimeCatalog['runtimes'][number] {
  return {
    preflight: {
      runtime: {
        id: runtimeId,
        displayName: runtimeId,
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
      capabilities
    },
    models: [],
    refreshedAt: '2026-08-20T10:00:00.000Z'
  };
}
