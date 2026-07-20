import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type AgentRuntimeCatalog
} from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../agent/codex/codexCapabilities';
import { AgentTurnScheduler } from '../agent/AgentTurnScheduler';
import type {
  AgentScopedTurnProvider,
  StartScopedAgentTurnInput
} from '../agent/AgentScopedTurnProvider';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../storage/FileDiscourseStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { DiscourseContextResolver } from './DiscourseContextResolver';
import { DiscourseContextSnapshotService } from './DiscourseContextSnapshotService';
import { DiscourseRuntimeCoordinator } from './DiscourseRuntimeCoordinator';
import { DiscourseService } from './DiscourseService';
import { DiscourseWorkspace } from './DiscourseWorkspace';
import {
  DISCOURSE_LIMITS,
  type ContextSnapshotRecord,
  type SendDiscourseMessageRequest
} from '../../shared/discourse';

describe('DiscourseService', () => {
  it('persists an idempotent Direct send through frozen context and a queued scoped run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-service-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));
    const discourseStore = new FileDiscourseStore(path.join(root, 'discourse'));
    const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
    await Promise.all([taskStore.init(), discourseStore.init(), runtimeStore.init()]);
    const resolver = new DiscourseContextResolver(taskStore);
    const snapshots = new DiscourseContextSnapshotService(
      resolver,
      new DiscourseWorkspace(path.join(root, 'workspaces')),
      async (input) => ({
        attestation: { status: 'ATTESTED' },
        primaryCwd: input.primaryCwd,
        readRoots: input.readRoots,
        managedAttachments: [],
        permissionProfileHash: 'd'.repeat(64),
        modelSettings: input.modelSettings,
        externalTools: {
          network: false,
          webSearch: 'disabled',
          mcpServers: false,
          apps: false,
          dynamicTools: false
        },
        clientOperationId: input.clientOperationId
      }),
      () => '2026-07-13T00:01:00.000Z'
    );
    const coordinator = new DiscourseRuntimeCoordinator(
      discourseStore,
      runtimeStore,
      () => '2026-07-13T00:01:00.000Z'
    );
    let schedulerNotifications = 0;
    const service = new DiscourseService(
      discourseStore,
      resolver,
      new AppEventBus(),
      {
        getRuntimeCatalog: runtimeCatalog,
        getAppSettings: () => DEFAULT_TASK_MANAGER_APP_SETTINGS,
        now: () => '2026-07-13T00:01:00.000Z',
        runtime: {
          coordinator,
          contextSnapshots: snapshots,
          provider: {
            startScopedTurn: async () => {
              throw new Error('The unit test must not dispatch provider work.');
            }
          },
          notifySchedulerWorkAvailable: () => {
            schedulerNotifications += 1;
          }
        }
      }
    );
    const conversation = await service.createConversation({
      title: 'Direct architecture question',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-direct'
    });
    const preview = await service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const request: SendDiscourseMessageRequest = {
      conversationId: conversation.id,
      body: 'Explain why the runtime owner is separate from task workflow.',
      context: [],
      clientMessageId: 'message-direct-1',
      policy: 'DIRECT' as const,
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    };
    const sent = await service.sendMessage(request);
    const replay = await service.sendMessage(request);

    expect(replay).toEqual(sent);
    expect(sent).toMatchObject({
      message: { ordinal: 1, contextRevisionId: expect.any(String) },
      wave: { policy: 'DIRECT', status: 'QUEUED' },
      jobs: [{ status: 'RESOLVING_CONTEXT', runId: expect.any(String) }]
    });
    expect(schedulerNotifications).toBe(1);
    const aggregate = await discourseStore.getConversation(conversation.id);
    expect(aggregate).toMatchObject({
      contextSnapshots: [{ status: 'READY', transcriptOrdinals: [1] }],
      waves: [{ id: sent.wave!.id }],
      jobs: [{ id: sent.jobs[0]!.id }]
    });
    expect(await runtimeStore.snapshot()).toMatchObject({
      runs: [{ owner: { kind: 'DISCOURSE', conversationId: conversation.id } }],
      queueEntries: [{ status: 'QUEUED' }]
    });
  });

  it('plans Panel respondents as independent jobs over the same frozen input', async () => {
    const fixture = await serviceFixture('panel');
    const conversation = await fixture.service.createConversation({
      title: 'Independent panel',
      defaultPolicy: 'PANEL',
      participantProfileIds: ['builtin.lead', 'builtin.skeptic'],
      clientOperationId: 'create-panel'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Give two independent assessments.',
      context: [],
      clientMessageId: 'panel-message-1',
      policy: 'PANEL',
      agentProfileIds: ['builtin.lead', 'builtin.skeptic'],
      previewFingerprint: preview.fingerprint
    });

    expect(sent.wave).toMatchObject({ policy: 'PANEL', assignments: [
      { assignmentRole: 'PANELIST' },
      { assignmentRole: 'PANELIST' }
    ] });
    expect(sent.jobs).toHaveLength(2);
    expect(new Set(sent.jobs.map((job) => JSON.stringify(job.visibleMessageIds))).size).toBe(1);
    expect((await fixture.runtimeStore.snapshot()).queueEntries).toHaveLength(2);
  });

  it('blocks every initial Panel job before runtime creation when its prompt budget fails', async () => {
    const fixture = await serviceFixture('panel-prompt-budget');
    const originalAssess = fixture.snapshots.assessPrompt.bind(fixture.snapshots);
    vi.spyOn(fixture.snapshots, 'assessPrompt').mockImplementation((assembly, cumulative) => {
      const result = originalAssess(assembly, cumulative);
      return {
        ...result,
        assessment: {
          ...result.assessment,
          status: 'BLOCKED',
          violations: [{
            code: 'PROMPT_TOKEN_BUDGET',
            actual: result.assessment.promptTokenCeiling + 1,
            limit: result.assessment.promptTokenCeiling
          }]
        }
      };
    });
    const conversation = await fixture.service.createConversation({
      title: 'Bounded panel',
      defaultPolicy: 'PANEL',
      participantProfileIds: ['builtin.lead', 'builtin.skeptic'],
      clientOperationId: 'create-bounded-panel'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });

    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Do not dispatch an over-budget panel.',
      context: [],
      clientMessageId: 'bounded-panel-message',
      policy: 'PANEL',
      agentProfileIds: ['builtin.lead', 'builtin.skeptic'],
      previewFingerprint: preview.fingerprint
    })).resolves.toMatchObject({
      wave: { status: 'SETTLED', outcome: 'NO_RESPONSE' },
      jobs: [
        {
          status: 'FAILED',
          delivery: 'NOT_SENT',
          error: {
            code: 'CONTEXT_TOO_LARGE',
            detail: expect.stringMatching(/^PROMPT_TOKEN_BUDGET: actual=\d+, limit=\d+$/)
          }
        },
        {
          status: 'FAILED',
          delivery: 'NOT_SENT',
          error: {
            code: 'CONTEXT_TOO_LARGE',
            detail: expect.stringMatching(/^PROMPT_TOKEN_BUDGET: actual=\d+, limit=\d+$/)
          }
        }
      ]
    });
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.contextSnapshots[0]?.budget).toEqual({
      inputBytes: 0,
      estimatedInputTokens: 0,
      reservedOutputTokens: DISCOURSE_LIMITS.defaultReservedOutputTokens,
      sourceCount: 0
    });
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(0);
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('repairs an idempotent retry after the wave persisted before runtime preparation', async () => {
    const fixture = await serviceFixture('retry-repair');
    const conversation = await fixture.service.createConversation({
      title: 'Retry repair',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-retry-repair'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const request: SendDiscourseMessageRequest = {
      conversationId: conversation.id,
      body: 'Repair this durable send without duplicating it.',
      context: [],
      clientMessageId: 'retry-repair-message',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    };
    const originalPrepare = fixture.coordinator.prepareJob.bind(fixture.coordinator);
    const prepare = vi.spyOn(fixture.coordinator, 'prepareJob')
      .mockRejectedValueOnce(new Error('Simulated crash after wave persistence.'))
      .mockImplementation(originalPrepare);

    await expect(fixture.service.sendMessage(request)).rejects.toThrow('Simulated crash');
    prepare.mockRestore();
    await expect(fixture.service.sendMessage(request)).resolves.toMatchObject({
      wave: { status: 'QUEUED' },
      jobs: [{ status: 'RESOLVING_CONTEXT', runId: expect.any(String) }]
    });
    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toHaveLength(1);
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(1);
  });

  it('repairs partial Panel runtime preparation during startup recovery', async () => {
    const fixture = await serviceFixture('partial-panel-recovery');
    const conversation = await fixture.service.createConversation({
      title: 'Partial panel recovery',
      defaultPolicy: 'PANEL',
      participantProfileIds: ['builtin.lead', 'builtin.skeptic'],
      clientOperationId: 'create-partial-panel'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const originalPrepare = fixture.coordinator.prepareJob.bind(fixture.coordinator);
    let calls = 0;
    const prepare = vi.spyOn(fixture.coordinator, 'prepareJob').mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('Simulated crash during Panel preparation.');
      return originalPrepare(input);
    });
    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Prepare both independent panelists durably.',
      context: [],
      clientMessageId: 'partial-panel-message',
      policy: 'PANEL',
      agentProfileIds: ['builtin.lead', 'builtin.skeptic'],
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow('Simulated crash');
    prepare.mockRestore();

    await fixture.service.recoverConversation(conversation.id);
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate).toMatchObject({
      waves: [{ status: 'QUEUED' }],
      jobs: [
        { status: 'RESOLVING_CONTEXT', runId: expect.any(String) },
        { status: 'RESOLVING_CONTEXT', runId: expect.any(String) }
      ]
    });
    expect((await fixture.runtimeStore.snapshot()).queueEntries).toHaveLength(2);
  });

  it('settles blocked context without inventing a provider send transition', async () => {
    const fixture = await serviceFixture('blocked-context');
    const conversation = await fixture.service.createConversation({
      title: 'Blocked context',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-blocked-context'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const originalPrepare = fixture.snapshots.prepare.bind(fixture.snapshots);
    vi.spyOn(fixture.snapshots, 'prepare').mockImplementation(async (input) => {
      const prepared = await originalPrepare(input);
      const {
        status: _status,
        resolvedAt: _resolvedAt,
        error: _error,
        permissionProfileHash: _permissionProfileHash,
        ...snapshotBase
      } = prepared.snapshot;
      const blockedSnapshot: ContextSnapshotRecord = {
        ...snapshotBase,
        status: 'BLOCKED',
        resolvedAt: prepared.snapshot.status === 'RESOLVING'
          ? '2026-07-13T00:01:00.000Z'
          : prepared.snapshot.resolvedAt,
        error: {
          code: 'CONTEXT_TOO_LARGE',
          message: 'The selected context exceeds its bounded prompt budget.',
          category: 'CONTEXT',
          retryable: false
        }
      };
      return {
        ...prepared,
        snapshot: blockedSnapshot,
        executionContext: undefined,
        prompt: ''
      };
    });

    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'This provider turn must never start.',
      context: [],
      clientMessageId: 'blocked-context-message',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    })).resolves.toMatchObject({
      wave: { status: 'SETTLED', outcome: 'FAILED' },
      jobs: [{ status: 'FAILED', delivery: 'NOT_SENT', error: { code: 'CONTEXT_TOO_LARGE' } }]
    });
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(0);
  });

  it('keeps a later user response durable but undispatched until the current wave settles', async () => {
    const fixture = await serviceFixture('queued-follow-up');
    const conversation = await fixture.service.createConversation({
      title: 'Ordered follow-ups',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-ordered'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const first = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'First question.',
      context: [],
      clientMessageId: 'ordered-message-1',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    });
    const secondPreview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const second = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Second question.',
      context: [],
      clientMessageId: 'ordered-message-2',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: secondPreview.fingerprint
    });

    expect(first.wave?.status).toBe('QUEUED');
    expect(second).toMatchObject({
      wave: { status: 'PLANNED' },
      jobs: [{ status: 'QUEUED' }]
    });
    expect(second.jobs[0]).not.toHaveProperty('runId');
    expect((await fixture.runtimeStore.snapshot()).queueEntries).toHaveLength(1);
    await fixture.service.stopWave({
      conversationId: conversation.id,
      waveId: first.wave!.id,
      clientOperationId: 'stop-first-ordered',
      reason: 'Move to the next response.'
    });
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.waves).toMatchObject([
      { id: first.wave!.id, status: 'SETTLED', outcome: 'CANCELED' },
      { id: second.wave!.id, status: 'QUEUED' }
    ]);
    expect(aggregate.jobs.find((job) => job.waveId === second.wave!.id)).toMatchObject({
      status: 'RESOLVING_CONTEXT',
      runId: expect.any(String)
    });
  });

  it('settles a queued stale-context job while preserving that it was never sent', async () => {
    const fixture = await serviceFixture('queued-stale');
    const conversation = await fixture.service.createConversation({
      title: 'Queued stale response',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-queued-stale'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const first = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'First response.',
      context: [],
      clientMessageId: 'queued-stale-first',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    });
    const secondPreview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const second = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'This queued response becomes stale.',
      context: [],
      clientMessageId: 'queued-stale-second',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: secondPreview.fingerprint
    });
    vi.spyOn(fixture.snapshots, 'freshness').mockResolvedValue('CHANGED_DURING_JOB');

    await fixture.service.stopWave({
      conversationId: conversation.id,
      waveId: first.wave!.id,
      clientOperationId: 'stop-before-stale-activation',
      reason: 'Settle the first response.'
    });
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.waves.find((wave) => wave.id === second.wave!.id)).toMatchObject({
      status: 'SETTLED',
      outcome: 'STALE',
      settlementReason: 'CONTEXT_CHANGED'
    });
    expect(aggregate.jobs.find((job) => job.waveId === second.wave!.id)).toMatchObject({
      status: 'CONTEXT_STALE',
      delivery: 'NOT_SENT',
      error: { code: 'CONTEXT_CHANGED' }
    });
  });

  it('revalidates provider availability for existing participants before persisting a send', async () => {
    let currentRuntimeCatalog = runtimeCatalog();
    const fixture = await serviceFixture(
      'participant-provider-unavailable',
      () => currentRuntimeCatalog
    );
    const conversation = await fixture.service.createConversation({
      title: 'Provider availability',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-provider-availability'
    });
    const codex = currentRuntimeCatalog.runtimes[0]!;
    currentRuntimeCatalog = {
      ...currentRuntimeCatalog,
      runtimes: [{
        ...codex,
        preflight: {
          ...codex.preflight,
          readiness: createRuntimeReadiness(
            'AUTHENTICATION_REQUIRED',
            'Sign in to Codex.'
          )
        }
      }]
    };
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });

    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'This must not be persisted while the provider is unavailable.',
      context: [],
      clientMessageId: 'provider-unavailable-message',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow(
      'The selected agent is unavailable. Check its connection in Settings.'
    );

    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toEqual([]);
    expect((await fixture.discourseStore.getConversation(conversation.id)).waves).toEqual([]);
  });

  it('rejects removed model, reasoning, or service-tier settings before persisting a send', async () => {
    let currentProviderState: AgentRuntimeCatalog = runtimeCatalog({
      serviceTiers: ['fast'],
      defaultServiceTier: 'fast'
    });
    const fixture = await serviceFixture('participant-model-unavailable', () => currentProviderState);
    const conversation = await fixture.service.createConversation({
      title: 'Immutable participant settings',
      defaultPolicy: 'DIRECT',
      participantProfileIds: ['builtin.lead'],
      clientOperationId: 'create-participant-model'
    });
    currentProviderState = runtimeCatalog({
      id: 'gpt-replacement',
      model: 'gpt-replacement',
      displayName: 'GPT Replacement'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const request: SendDiscourseMessageRequest = {
      conversationId: conversation.id,
      body: 'Do not silently reroute this participant.',
      context: [],
      clientMessageId: 'removed-model-message',
      policy: 'DIRECT',
      agentProfileIds: ['builtin.lead'],
      previewFingerprint: preview.fingerprint
    };

    await expect(fixture.service.sendMessage(request)).rejects.toThrow(
      'saved model (gpt-test) is unavailable'
    );
    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toEqual([]);
    expect((await fixture.discourseStore.getConversation(conversation.id)).waves).toEqual([]);

    currentProviderState = runtimeCatalog({
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high'
    });
    await expect(fixture.service.sendMessage({
      ...request,
      clientMessageId: 'removed-reasoning-message'
    })).rejects.toThrow('medium reasoning is no longer supported by gpt-test');

    currentProviderState = runtimeCatalog({
      serviceTiers: ['slow'],
      defaultServiceTier: 'slow'
    });
    await expect(fixture.service.sendMessage({
      ...request,
      clientMessageId: 'removed-service-tier-message'
    })).rejects.toThrow('saved service tier is no longer supported');
    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toEqual([]);
    expect((await fixture.discourseStore.getConversation(conversation.id)).waves).toEqual([]);
  });

  it('runs a bounded Team answer, isolated reviews, and one attributable correction', async () => {
    const fixture = await serviceFixture('team');
    const promptAssessments: Array<{
      prompt: string;
      phaseVisibleOutputBytes: number;
      cumulativeWaveOutputBytes: number;
    }> = [];
    const originalAssess = fixture.snapshots.assessPrompt.bind(fixture.snapshots);
    vi.spyOn(fixture.snapshots, 'assessPrompt').mockImplementation((assembly, cumulative) => {
      promptAssessments.push({
        prompt: assembly.prompt,
        phaseVisibleOutputBytes: assembly.budgetSections.phaseVisibleOutputs.bytes,
        cumulativeWaveOutputBytes: cumulative
      });
      return originalAssess(assembly, cumulative);
    });
    const conversation = await fixture.service.createConversation({
      title: 'Reviewed architecture answer',
      defaultPolicy: 'TEAM',
      participantProfileIds: ['builtin.lead', 'builtin.skeptic', 'builtin.verifier'],
      clientOperationId: 'create-team'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Is the migration reversible?',
      context: [],
      clientMessageId: 'team-message-1',
      policy: 'TEAM',
      agentProfileIds: ['builtin.verifier', 'builtin.lead', 'builtin.skeptic'],
      previewFingerprint: preview.fingerprint
    });
    expect(sent.jobs).toHaveLength(1);
    expect(sent.wave?.assignments.map((assignment) => assignment.assignmentRole)).toEqual([
      'PRIMARY',
      'REVIEWER',
      'REVIEWER'
    ]);

    const [leadLease] = await fixture.scheduler.leaseAvailable('lease-lead');
    const leadRun = await fixture.coordinator.dispatchLeasedJob(
      leadLease!.id,
      fixture.provider,
      'dispatch-lead'
    );
    const leadTerminal = await fixture.coordinator.ingestContribution({
      runId: leadRun.id,
      providerTurnId: leadRun.providerTurnId!,
      body: 'The migration is fully reversible.',
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-lead',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    if (leadTerminal.kind !== 'CURATED') throw new Error('Expected a lead answer.');
    await fixture.service.advanceWave(conversation.id, sent.wave!.id, 'advance-review');

    let aggregate = await fixture.discourseStore.getConversation(conversation.id);
    const reviews = aggregate.jobs.filter((job) => job.role === 'CRITIQUE');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.visibleMessageIds).toEqual(reviews[1]?.visibleMessageIds);
    expect(reviews[0]?.targetMessageIds).toEqual([leadTerminal.message.id]);
    const reviewLeases = await fixture.scheduler.leaseAvailable('lease-reviews');
    expect(reviewLeases).toHaveLength(2);
    const reviewRuns = await Promise.all(reviewLeases.map((lease, index) =>
      fixture.coordinator.dispatchLeasedJob(
        lease.id,
        fixture.provider,
        `dispatch-review-${index}`
      )
    ));
    const noConcern = JSON.stringify({
      outcome: 'NO_CONCERN_FOUND',
      reviewedScope: leadTerminal.message.id,
      limitations: [],
      requiredAccessAvailable: true,
      concerns: []
    });
    await fixture.coordinator.ingestReview({
      runId: reviewRuns[0]!.id,
      providerTurnId: reviewRuns[0]!.providerTurnId!,
      body: noConcern,
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-review-1',
      completedAt: '2026-07-13T00:11:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    await fixture.service.advanceWave(conversation.id, sent.wave!.id, 'advance-review-1');
    const concernReview = JSON.stringify({
      outcome: 'CONCERNS',
      reviewedScope: leadTerminal.message.id,
      limitations: [],
      requiredAccessAvailable: true,
      concerns: [{
        targetClaim: 'The migration is fully reversible.',
        category: 'storage',
        severity: 'MATERIAL',
        confidence: 'HIGH',
        evidenceStatus: 'LOGICAL_CONTRADICTION',
        reason: 'The answer describes a one-way version guard.',
        evidence: 'Older readers reject the new record version.',
        suggestedResolution: 'State that rollback requires an explicit reverse migration.'
      }]
    });
    await fixture.coordinator.ingestReview({
      runId: reviewRuns[1]!.id,
      providerTurnId: reviewRuns[1]!.providerTurnId!,
      body: concernReview,
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-review-2',
      completedAt: '2026-07-13T00:12:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    await fixture.service.advanceWave(conversation.id, sent.wave!.id, 'advance-correction');

    aggregate = await fixture.discourseStore.getConversation(conversation.id);
    const correction = aggregate.jobs.find((job) => job.role === 'CORRECT');
    expect(correction).toMatchObject({ assignment: { assignmentRole: 'PRIMARY' } });
    const correctionAssessment = promptAssessments.find(
      (assessment) => assessment.prompt.includes('Correction task:')
    );
    expect(correctionAssessment).toMatchObject({
      phaseVisibleOutputBytes: expect.any(Number),
      cumulativeWaveOutputBytes:
        Buffer.byteLength('The migration is fully reversible.', 'utf8') +
        Buffer.byteLength(noConcern, 'utf8') +
        Buffer.byteLength(concernReview, 'utf8')
    });
    expect(correctionAssessment!.phaseVisibleOutputBytes).toBeGreaterThan(0);
    expect(correctionAssessment!.prompt).toContain('untrusted reviewer output');
    const [correctionLease] = await fixture.scheduler.leaseAvailable('lease-correction');
    const correctionRun = await fixture.coordinator.dispatchLeasedJob(
      correctionLease!.id,
      fixture.provider,
      'dispatch-correction'
    );
    const correctionTerminal = await fixture.coordinator.ingestCorrection({
      runId: correctionRun.id,
      providerTurnId: correctionRun.providerTurnId!,
      body: JSON.stringify({
        outcome: 'REVISED',
        body: 'The migration is one-way unless an explicit reverse migration is provided.',
        limitations: []
      }),
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-correction',
      completedAt: '2026-07-13T00:13:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    expect(correctionTerminal.kind).toBe('CURATED');

    aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate).toMatchObject({
      contextSnapshots: [{ id: sent.wave!.contextSnapshotId }],
      waves: [{ status: 'SETTLED', outcome: 'COMPLETE', phase: 'COMPLETE' }]
    });
    expect(aggregate.jobs.map((job) => [job.role, job.status])).toEqual([
      ['ANSWER', 'COMPLETED'],
      ['CRITIQUE', 'COMPLETED'],
      ['CRITIQUE', 'COMPLETED'],
      ['CORRECT', 'COMPLETED']
    ]);
    expect(aggregate.concerns).toMatchObject([{
      severity: 'MATERIAL',
      resolution: {
        correctionJobId: correction!.id,
        correctionMessageId: expect.any(String),
        outcome: 'REVISED'
      }
    }]);
    const messages = await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    });
    expect(messages.messages).toMatchObject([
      {
        body: 'Is the migration reversible?',
        status: 'VISIBLE'
      },
      {
        body: 'The migration is fully reversible.',
        status: 'SUPERSEDED'
      },
      {
        body: 'The migration is one-way unless an explicit reverse migration is provided.',
        status: 'VISIBLE',
        replyToMessageId: messages.messages[1]!.id,
        supersedesMessageId: messages.messages[1]!.id
      }
    ]);
    expect((await fixture.runtimeStore.snapshot()).sessions).toHaveLength(4);
  }, 15_000);
});

async function serviceFixture(
  label: string,
  getRuntimeCatalog: () => AgentRuntimeCatalog = runtimeCatalog
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-discourse-${label}-`));
  const taskStore = new FileTaskStore(path.join(root, 'tasks'));
  const discourseStore = new FileDiscourseStore(path.join(root, 'discourse'));
  const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
  await Promise.all([taskStore.init(), discourseStore.init(), runtimeStore.init()]);
  const resolver = new DiscourseContextResolver(taskStore);
  const snapshots = new DiscourseContextSnapshotService(
    resolver,
    new DiscourseWorkspace(path.join(root, 'workspaces')),
    async (input) => ({
      attestation: { status: 'ATTESTED' },
      primaryCwd: input.primaryCwd,
      readRoots: input.readRoots,
      managedAttachments: [],
      permissionProfileHash: 'd'.repeat(64),
      modelSettings: input.modelSettings,
      externalTools: {
        network: false,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: input.clientOperationId
    }),
    () => '2026-07-13T00:01:00.000Z'
  );
  const coordinator = new DiscourseRuntimeCoordinator(
    discourseStore,
    runtimeStore,
    () => '2026-07-13T00:05:00.000Z'
  );
  const scheduler = new AgentTurnScheduler(
    runtimeStore,
    () => '2026-07-13T00:06:00.000Z'
  );
  const provider = new SequentialScopedProvider();
  const service = new DiscourseService(
    discourseStore,
    resolver,
    new AppEventBus(),
    {
      getRuntimeCatalog,
      getAppSettings: () => DEFAULT_TASK_MANAGER_APP_SETTINGS,
      now: () => '2026-07-13T00:01:00.000Z',
      runtime: {
        coordinator,
        contextSnapshots: snapshots,
        provider,
        notifySchedulerWorkAvailable: () => undefined
      }
    }
  );
  return { service, discourseStore, runtimeStore, coordinator, scheduler, provider, snapshots };
}

class SequentialScopedProvider implements AgentScopedTurnProvider {
  private sequence = 0;
  calls: StartScopedAgentTurnInput[] = [];

  async startScopedTurn(input: StartScopedAgentTurnInput) {
    this.calls.push(input);
    const sequence = ++this.sequence;
    return {
      serverInstanceId: 'server-test',
      providerSessionId: `provider-session-${sequence}`,
      providerTurnId: `provider-turn-${sequence}`,
      startedAt: '2026-07-13T00:07:00.000Z'
    };
  }
}

function runtimeCatalog(
  modelOverrides: Partial<AgentRuntimeCatalog['models'][number]> = {}
): AgentRuntimeCatalog {
  const models = [{
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
    isDefault: true,
    ...modelOverrides
  }];
  return {
    defaultRuntimeId: 'codex',
    runtimes: [{
      preflight: {
        runtime: CODEX_RUNTIME_DESCRIPTOR,
        readiness: createRuntimeReadiness('READY', 'Codex is ready.'),
        capabilities: codexCapabilities()
      },
      models,
      refreshedAt: '2026-07-13T00:00:00.000Z'
    }],
    models,
    refreshedAt: '2026-07-13T00:00:00.000Z'
  };
}
