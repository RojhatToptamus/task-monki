import { describe, expect, it } from 'vitest';
import type {
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseConversationAggregateRecord,
  DiscourseDraftRecord,
  DiscourseMessageRecord,
  DiscourseMentionCatalogSnapshot,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import {
  composerTokensFromDraft,
  canDeleteAbandonedDiscourseShell,
  currentPinnedContext,
  currentDiscourseParticipantRevisions,
  defaultDiscourseAgentSelection,
  discourseAcceptedSendForClientMessage,
  discourseAgentSelectionFromCurrentRevision,
  discourseConcernResolutionLabel,
  discourseClientMessageWasPersisted,
  discourseDraftsAlreadySent,
  discourseJobStatusLabel,
  discourseMentionCandidates,
  discoursePendingSendFingerprint,
  discourseReviewResultLabel,
  discourseTeamCompletionSummary,
  discourseTerminalJobDetail,
  draftTokensFromComposer,
  eligibleDiscourseRuntimeCatalog,
  isNearScrollBottom,
  interruptedDiscourseAcceptedSends,
  recoverPendingDiscourseCreateForReplacement,
  shouldShowNewResponses,
  visibleDiscourseResponseWaves,
  visibleDiscourseResponseWavePlacements,
  visibleConversationSummaries
} from './discourse';

describe('discourse renderer model', () => {
  it('recovers an ambiguously created replacement before a second edit moves on', async () => {
    const requests: unknown[] = [];
    const superseded = await recoverPendingDiscourseCreateForReplacement({
      pending: {
        clientOperationId: 'create-b',
        supersededConversationIds: ['conversation-a'],
        createRequest: {
          title: 'Replacement B',
          defaultPolicy: 'DIRECT',
          agents: [{ agentProfileId: 'builtin.lead', runtimeId: 'codex', modelId: 'model-b' }]
        }
      },
      replay: async (request) => {
        requests.push(request);
        return { id: 'conversation-b' };
      }
    });

    expect(requests).toEqual([{
      title: 'Replacement B',
      defaultPolicy: 'DIRECT',
      agents: [{ agentProfileId: 'builtin.lead', runtimeId: 'codex', modelId: 'model-b' }],
      clientOperationId: 'create-b'
    }]);
    expect(superseded).toEqual(['conversation-a', 'conversation-b']);
  });

  it('deletes only draftless abandoned first-send conversation shells', () => {
    expect(canDeleteAbandonedDiscourseShell({
      conversationId: 'conversation-1',
      latestOrdinal: 0,
      drafts: []
    })).toBe(true);
    expect(canDeleteAbandonedDiscourseShell({
      conversationId: 'conversation-1',
      latestOrdinal: 0,
      drafts: [{ conversationId: 'conversation-1' }] as DiscourseDraftRecord[]
    })).toBe(false);
    expect(canDeleteAbandonedDiscourseShell({
      conversationId: 'conversation-1',
      latestOrdinal: 1,
      drafts: []
    })).toBe(false);
  });

  it('finds interrupted accepted sends in one pass across a bounded large history', () => {
    const acceptedSends = Array.from({ length: 5_001 }, (_, index) => ({
      id: `accepted-${index}`,
      clientMessageId: `client-message-${index}`,
      triggerMessageId: `message-${index}`,
      status: 'PENDING' as const
    }));
    const aggregate = {
      acceptedSends,
      waves: Array.from({ length: 5_000 }, (_, index) => ({
        triggerMessageId: `message-${index}`
      }))
    } as DiscourseConversationAggregateRecord;

    expect(interruptedDiscourseAcceptedSends(aggregate)).toEqual([
      acceptedSends[5_000]
    ]);
    expect(discourseAcceptedSendForClientMessage(
      aggregate,
      'client-message-5000'
    )).toBe(acceptedSends[5_000]);
    const persistedHumanMessage = {
      author: { kind: 'USER' },
      clientMessageId: 'human-message-1'
    } as DiscourseMessageRecord;
    expect(discourseClientMessageWasPersisted(
      aggregate,
      [persistedHumanMessage],
      'human-message-1'
    )).toBe(true);
    expect(discourseDraftsAlreadySent(aggregate, [persistedHumanMessage], [
      { id: 'accepted-draft', pendingClientMessageId: 'client-message-5000' },
      { id: 'human-draft', pendingClientMessageId: 'human-message-1' },
      { id: 'ordinary-draft' }
    ] as never)).toEqual([
      expect.objectContaining({ id: 'accepted-draft' }),
      expect.objectContaining({ id: 'human-draft' })
    ]);
  });

  it('maps the global catalog into disambiguated typed picker candidates', () => {
    const candidates = discourseMentionCandidates(catalog(), [{
      id: 'recent-repository',
      kind: 'REPOSITORY',
      entityId: 'repository-1',
      labelSnapshot: 'task-monki'
    }]);
    expect(candidates).toMatchObject([
      { kind: 'AGENT', id: 'builtin.lead', description: 'Lead · gpt-test' },
      { kind: 'TASK', id: 'task-1', description: '#task-1 · task-monki · in progress' },
      {
        kind: 'REPOSITORY',
        id: 'repository-1',
        description: '…/src/task-monki · 1 task · read-only files',
        recentOrdinal: 1
      }
    ]);
  });

  it('round-trips authoritative structured draft tokens without parsing labels', () => {
    const draft = [{
      id: 'token-1',
      kind: 'TASK' as const,
      entityId: 'task-1',
      labelSnapshot: 'Readable label only'
    }];
    expect(draftTokensFromComposer(composerTokensFromDraft(draft))).toEqual([
      {
        kind: 'TASK',
        entityId: 'task-1',
        labelSnapshot: 'Readable label only'
      }
    ]);
  });

  it('derives editable selections from only the current participant revision', () => {
    const aggregate = {
      participants: [{
        id: 'participant-1',
        agentProfileId: 'builtin.lead',
        currentRevisionId: 'revision-2',
        enabled: true
      }],
      participantRevisions: [
        {
          id: 'revision-1',
          agentProfileId: 'builtin.lead',
          runtimeId: 'codex',
          model: 'gpt-old',
          modelProvider: 'openai'
        },
        {
          id: 'revision-2',
          agentProfileId: 'builtin.lead',
          runtimeId: 'codex',
          model: 'gpt-test',
          modelProvider: 'openai',
          reasoningEffort: 'medium'
        }
      ]
    } as unknown as DiscourseConversationAggregateRecord;
    const snapshot = catalog();

    expect(currentDiscourseParticipantRevisions(aggregate).map(({ id }) => id)).toEqual([
      'revision-2'
    ]);
    expect(discourseAgentSelectionFromCurrentRevision(
      aggregate,
      snapshot,
      'builtin.lead'
    )).toEqual({
      agentProfileId: 'builtin.lead',
      runtimeId: 'codex',
      modelId: 'codex:gpt-test',
      reasoningEffort: 'medium'
    });
    expect(defaultDiscourseAgentSelection(snapshot, 'builtin.lead')).toMatchObject({
      modelId: 'codex:gpt-test'
    });
    expect(eligibleDiscourseRuntimeCatalog(snapshot).runtimes.map(
      (runtime) => runtime.preflight.runtime.id
    )).toEqual(['codex']);
  });

  it('keeps an unchanged failed send on one retry identity and detects configuration changes', () => {
    const input = {
      body: 'Review the migration.',
      sourceMessageIds: ['message-1'],
      context: [{ entityKind: 'REPOSITORY' as const, entityId: 'repository-1' }],
      policy: 'DIRECT' as const,
      agents: [{
        agentProfileId: 'builtin.lead' as const,
        runtimeId: 'codex',
        modelId: 'codex:gpt-test',
        reasoningEffort: 'medium'
      }]
    };
    const first = discoursePendingSendFingerprint(input);

    expect(discoursePendingSendFingerprint({ ...input })).toBe(first);
    expect(discoursePendingSendFingerprint({
      ...input,
      agents: [{ ...input.agents[0]!, modelId: 'codex:gpt-next' }]
    })).not.toBe(first);
  });

  it('selects only the latest pinned revision and filters conversation titles', () => {
    const aggregate = {
      conversation: { pinnedContextRevisionId: 'revision-2' },
      contextRevisions: [
        { id: 'revision-1', references: [{ contextLinkId: 'old' }] },
        { id: 'revision-2', references: [
          { contextLinkId: 'pinned', scope: 'PINNED' },
          { contextLinkId: 'message', scope: 'MESSAGE' }
        ] }
      ]
    } as unknown as DiscourseConversationAggregateRecord;
    expect(currentPinnedContext(aggregate)).toEqual([
      expect.objectContaining({ contextLinkId: 'pinned' })
    ]);
    expect(visibleConversationSummaries([
      { title: 'Architecture review' },
      { title: 'Release notes' }
    ] as never, 'ARCH')).toEqual([expect.objectContaining({ title: 'Architecture review' })]);
  });

  it('keeps reading position unless the user was already near the bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 820, clientHeight: 120, scrollHeight: 1_000 })).toBe(true);
    expect(isNearScrollBottom({ scrollTop: 300, clientHeight: 120, scrollHeight: 1_000 })).toBe(false);
    expect(shouldShowNewResponses({ wasNearBottom: false, previousLatestOrdinal: 3, nextLatestOrdinal: 4 })).toBe(true);
    expect(shouldShowNewResponses({ wasNearBottom: true, previousLatestOrdinal: 3, nextLatestOrdinal: 4 })).toBe(false);
  });

  it('keeps settled Team receipts visible after later completed answer waves', () => {
    const team = responseWave('team-1', 'TEAM', 'SETTLED', 'COMPLETE');
    const direct = responseWave('direct-2', 'DIRECT', 'SETTLED', 'COMPLETE');
    const panel = responseWave('panel-3', 'PANEL', 'SETTLED', 'COMPLETE');
    expect(visibleDiscourseResponseWaves({ waves: [team, direct, panel] }).map(({ id }) => id))
      .toEqual(['team-1']);

    const current = responseWave('direct-4', 'DIRECT', 'RUNNING');
    const queued = responseWave('panel-5', 'PANEL', 'PLANNED');
    expect(visibleDiscourseResponseWaves({ waves: [team, direct, panel, current, queued] }).map(({ id }) => id))
      .toEqual(['team-1', 'direct-4']);
  });

  it('anchors a historical Team receipt to its own latest response, not a later answer', () => {
    const team = responseWave('team-1', 'TEAM', 'SETTLED', 'COMPLETE');
    team.triggerMessageId = 'prompt-team';
    const direct = responseWave('direct-2', 'DIRECT', 'SETTLED', 'COMPLETE');
    direct.triggerMessageId = 'prompt-direct';
    const messages = [
      discourseMessage('prompt-team', 1),
      discourseMessage('team-answer', 2, 'team-1'),
      discourseMessage('team-correction', 3, 'team-1'),
      discourseMessage('prompt-direct', 4),
      discourseMessage('direct-answer', 5, 'direct-2')
    ];

    expect(visibleDiscourseResponseWavePlacements({ waves: [team, direct] }, messages))
      .toEqual([{ wave: team, afterMessageId: 'team-correction' }]);
    expect(visibleDiscourseResponseWavePlacements(
      { waves: [team, direct] },
      messages.slice(3)
    )).toEqual([]);
  });

  it('keeps incomplete terminal receipts and names every terminal job status', () => {
    const failed = responseWave('failed-1', 'DIRECT', 'SETTLED', 'FAILED');
    const complete = responseWave('complete-2', 'DIRECT', 'SETTLED', 'COMPLETE');
    expect(visibleDiscourseResponseWaves({ waves: [failed, complete] }).map(({ id }) => id))
      .toEqual(['failed-1']);
    expect([
      discourseJobStatusLabel('QUEUED'),
      discourseJobStatusLabel('COMPLETED'),
      discourseJobStatusLabel('FAILED'),
      discourseJobStatusLabel('CANCELED'),
      discourseJobStatusLabel('CONTEXT_STALE')
    ]).toEqual(['Waiting to start', 'Completed', 'Failed', 'Canceled', 'Context changed']);
  });

  it('shows explicit review failure, cancellation, and stale-context receipts', () => {
    expect(discourseReviewResultLabel(agentJob('FAILED', 'CRITIQUE'))).toBe('Review failed');
    expect(discourseReviewResultLabel({
      ...agentJob('FAILED', 'CRITIQUE'),
      result: {
        kind: 'REVIEW',
        outcome: 'NO_CONCERN_FOUND',
        reviewedScope: 'message-1',
        limitations: [],
        requiredAccessAvailable: true,
        concernIds: []
      }
    })).toBe('Review failed');
    expect(discourseReviewResultLabel(agentJob('CANCELED', 'CRITIQUE'))).toBe('Review canceled');
    expect(discourseReviewResultLabel(agentJob('CONTEXT_STALE', 'CRITIQUE'))).toBe('Context changed');
    expect(discourseTerminalJobDetail([agentJob('CANCELED', 'CRITIQUE')]))
      .toBe("Verifier's review was canceled.");
    expect(discourseTerminalJobDetail([agentJob('CONTEXT_STALE', 'ANSWER')]))
      .toBe("Verifier's response used changed context and was not accepted.");
  });

  it('keeps provider diagnostics out of the normal conversation receipt', () => {
    const failed = {
      ...agentJob('FAILED', 'ANSWER'),
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Model provider codex not found: upstream-internal-id',
        detail: '{"rawProviderResponse":{"secret":"internal"}}',
        category: 'PROVIDER',
        retryable: true
      }
    } as DiscourseAgentJobRecord;

    const detail = discourseTerminalJobDetail([failed]);
    expect(detail).toBe(
      'The selected agent is unavailable. Check its connection in Settings, then try again.'
    );
    expect(detail).not.toContain('codex');
    expect(detail).not.toContain('rawProviderResponse');
  });

  it.each([
    ['REVISED', 'Answer revised', 'Revised'],
    ['DEFENDED', 'Answer defended', 'Defended'],
    ['PARTIALLY_REVISED', 'Answer partially revised', 'Partially revised'],
    ['ACKNOWLEDGED_UNRESOLVED', 'Concern unresolved', 'Unresolved']
  ] as const)('preserves the actual correction outcome %s', (outcome, label, resolutionLabel) => {
    const concern = discourseConcern(outcome);
    const summary = discourseTeamCompletionSummary({
      jobs: [correctionJob(outcome)],
      concerns: [concern]
    });
    expect(summary).toMatchObject({ label });
    if (outcome === 'ACKNOWLEDGED_UNRESOLVED') {
      expect(summary.detail).toContain('unresolved disagreement');
      expect(summary.detail).not.toContain('revised the answer');
    }
    expect(discourseConcernResolutionLabel(concern)).toBe(resolutionLabel);
  });
});

function responseWave(
  id: string,
  policy: 'DIRECT' | 'PANEL' | 'TEAM',
  status: DiscourseResponseWaveRecord['status'],
  outcome?: DiscourseResponseWaveRecord['outcome']
): DiscourseResponseWaveRecord {
  return { id, policy, status, outcome } as DiscourseResponseWaveRecord;
}

function discourseMessage(
  id: string,
  ordinal: number,
  waveId?: string
): DiscourseMessageRecord {
  return { id, ordinal, waveId } as DiscourseMessageRecord;
}

function agentJob(
  status: DiscourseAgentJobRecord['status'],
  role: DiscourseAgentJobRecord['role']
): DiscourseAgentJobRecord {
  return {
    id: `job-${status}`,
    role,
    status,
    assignment: { displayNameSnapshot: 'Verifier' }
  } as DiscourseAgentJobRecord;
}

function correctionJob(
  outcome: NonNullable<DiscourseConcernRecord['resolution']>['outcome']
): DiscourseAgentJobRecord {
  return {
    ...agentJob('COMPLETED', 'CORRECT'),
    result: { kind: 'CORRECTION', outcome, limitations: [], outputMessageId: 'message-2' }
  } as DiscourseAgentJobRecord;
}

function discourseConcern(
  outcome: NonNullable<DiscourseConcernRecord['resolution']>['outcome']
): DiscourseConcernRecord {
  return {
    id: 'concern-1',
    severity: 'MATERIAL',
    requiredAccessAvailable: true,
    resolution: { correctionJobId: 'job-1', correctionMessageId: 'message-2', outcome }
  } as DiscourseConcernRecord;
}

function catalog(): DiscourseMentionCatalogSnapshot {
  const models: DiscourseMentionCatalogSnapshot['runtimeCatalog']['models'] = [{
    id: 'codex:gpt-test',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'gpt-test',
    displayName: 'GPT Test',
    hidden: false,
    supportedReasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true
  }];
  return {
    agents: [{
      profile: {
        id: 'builtin.lead',
        displayName: 'Lead',
        roleTemplate: 'LEAD',
        defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
        defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
        roleContractVersion: 1,
        revision: 1
      },
      availability: 'AVAILABLE',
      resolvedSettings: {
        runtimeId: 'codex',
        modelId: 'codex:gpt-test',
        model: 'gpt-test',
        modelProvider: 'openai'
      }
    }],
    runtimeCatalog: {
      defaultRuntimeId: 'codex',
      models,
      runtimes: [{
        preflight: {
          runtime: CODEX_RUNTIME_DESCRIPTOR,
          readiness: createRuntimeReadiness('READY', 'Codex is ready.'),
          capabilities: codexCapabilities()
        },
        models,
        refreshedAt: '2026-07-13T00:00:00.000Z'
      }],
      refreshedAt: '2026-07-13T00:00:00.000Z'
    },
    tasks: [{
      id: 'task-1',
      title: 'Context refactor',
      repositoryId: 'repository-1',
      repositoryName: 'task-monki',
      workflowPhase: 'IN_PROGRESS',
      availability: 'AVAILABLE',
      archived: false
    }],
    repositories: [{
      id: 'repository-1',
      displayName: 'task-monki',
      displayPath: '~/src/task-monki',
      taskCount: 1,
      availability: 'AVAILABLE',
      accessMode: 'FILESYSTEM_READ'
    }],
    refreshedAt: '2026-07-13T00:00:00.000Z'
  };
}
