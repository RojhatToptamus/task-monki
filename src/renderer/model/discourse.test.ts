import { describe, expect, it } from 'vitest';
import type {
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseConversationAggregateRecord,
  DiscourseMessageRecord,
  DiscourseMentionCatalogSnapshot,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import {
  composerTokensFromDraft,
  currentPinnedContext,
  discourseConcernResolutionLabel,
  discourseJobStatusLabel,
  discourseMentionCandidates,
  discourseReviewResultLabel,
  discourseTeamCompletionSummary,
  discourseTerminalJobDetail,
  draftTokensFromComposer,
  isNearScrollBottom,
  shouldShowNewResponses,
  visibleDiscourseResponseWaves,
  visibleDiscourseResponseWavePlacements,
  visibleConversationSummaries
} from './discourse';

describe('discourse renderer model', () => {
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
      { kind: 'REPOSITORY', id: 'repository-1', recentOrdinal: 1 }
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
      discourseJobStatusLabel('COMPLETED'),
      discourseJobStatusLabel('FAILED'),
      discourseJobStatusLabel('CANCELED'),
      discourseJobStatusLabel('CONTEXT_STALE')
    ]).toEqual(['Completed', 'Failed', 'Canceled', 'Context changed']);
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
  return {
    agents: [{
      profile: {
        id: 'builtin.lead',
        displayName: 'Lead',
        roleTemplate: 'LEAD',
        providerId: 'codex',
        defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
        defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
        roleContractVersion: 1,
        revision: 1
      },
      availability: 'AVAILABLE',
      resolvedSettings: { model: 'gpt-test', modelProvider: 'openai' }
    }],
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
