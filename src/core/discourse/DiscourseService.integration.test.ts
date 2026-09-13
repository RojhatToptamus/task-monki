import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type AgentRuntimeCatalog
} from '../../shared/contracts';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { ScriptedAgentRuntimeCoordinator } from '../../testSupport/ScriptedAgentRuntimeCoordinator';
import { AppEventBus } from '../runner/AppEventBus';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../agent/codex/codexCapabilities';
import { AgentTurnScheduler } from '../agent/AgentTurnScheduler';
import type { SqliteAgentRuntimeStore } from '../storage/SqliteAgentRuntimeStore';
import type { ApplicationPersistence } from '../storage/sqlite/ApplicationPersistence';
import { DiscourseContextResolver } from './DiscourseContextResolver';
import {
  DiscourseContextSnapshotService,
  DiscourseContextChangedError,
  type DiscourseReadOnlyExecutionScopeInput
} from './DiscourseContextSnapshotService';
import { DiscourseRuntimeCoordinator } from './DiscourseRuntimeCoordinator';
import { DiscourseService } from './DiscourseService';
import { DiscourseWorkspace } from './DiscourseWorkspace';
import { git } from '../git/gitCli';
import {
  DISCOURSE_LIMITS,
  type BuiltInAgentProfileId,
  type ContextSnapshotRecord,
  type DiscourseAgentSelectionInput,
  type DiscourseConversationAggregateRecord,
  type SendDiscourseMessageRequest
} from '../../shared/discourse';

function selections(
  ...agentProfileIds: BuiltInAgentProfileId[]
): DiscourseAgentSelectionInput[] {
  return agentProfileIds.map((agentProfileId) => ({ agentProfileId }));
}

function currentParticipantModels(
  aggregate: DiscourseConversationAggregateRecord
): Record<string, string> {
  return Object.fromEntries(aggregate.participants.map((participant) => [
    participant.agentProfileId,
    aggregate.participantRevisions.find(
      (revision) => revision.id === participant.currentRevisionId
    )!.model
  ]));
}

describe('DiscourseService', () => {
  it('delivers selected task text and its live checkout, but not another task, to the actual prepared prompt', async () => {
    const fixture = await serviceFixture('task-context-delivery');
    const repositoryPath = path.join(fixture.root, 'selected-repository');
    await fs.mkdir(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=main']);
    await git(repositoryPath, ['-c', 'user.name=Task Monki Tests', '-c', 'user.email=tests@task-monki.local', 'commit', '--allow-empty', '-m', 'Context fixture']);
    const repository = await fixture.persistence.tasks.addRepository({ path: repositoryPath, root: repositoryPath,
      status: 'VALID', headSha: await git(repositoryPath, ['rev-parse', 'HEAD']), branch: 'main', remotes: [], checkedAt: '2026-07-13T00:00:00Z' });
    const task = await fixture.persistence.tasks.createTask({ title: 'Migration support', prompt: 'Retain rollback for 48 hours after deployment.', repositoryId: repository.id });
    await fixture.persistence.tasks.createTask({ title: 'Unselected secret', prompt: 'Do not leak unrelated task data.', repositoryId: repository.id });
    const conversation = await fixture.service.createConversation({ title: 'Selected task', defaultPolicy: 'DIRECT', agents: selections('builtin.lead'), clientOperationId: 'create-context' });
    const context = [{ entityKind: 'TASK' as const, entityId: task.id }];
    const preview = await fixture.service.previewContext({ conversationId: conversation.id, messageContext: context });
    const sent = await fixture.service.sendMessage({ conversationId: conversation.id, policy: 'DIRECT', agents: selections('builtin.lead'), body: 'What support window applies?', context, clientMessageId: 'send-context', previewFingerprint: preview.fingerprint });
    const prompt = await fixture.runtimeStore.readArtifact(sent.jobs[0]!.promptArtifactId!);
    expect(prompt).toContain('Retain rollback for 48 hours after deployment.');
    expect(prompt).not.toContain('Do not leak unrelated task data.');
    expect(prompt).toContain(await fs.realpath(repositoryPath));
    expect(prompt).toContain('not instructions or live file contents');
    expect(fixture.executionContextInputs[0]?.readRoots.some((root) => JSON.stringify(root).includes(repositoryPath))).toBe(true);
    expect((await fixture.discourseStore.getConversation(conversation.id)).contextSnapshots[0]?.sources[0]).toMatchObject({ readScope: 'REPOSITORY', accessMode: 'FILESYSTEM_READ' });
  });

  it('budgets against a smaller reported model capacity before creating a provider run', async () => {
    const fixture = await serviceFixture('small-context-model', () => runtimeCatalog({ contextWindowTokens: 4_000 }));
    const sent = await startTeam(fixture);
    expect(sent.jobs.every((job) => job.status === 'FAILED' && job.delivery === 'NOT_SENT')).toBe(true);
    expect((await fixture.runtimeStore.snapshot()).runs).toEqual([]);
  });

  it('delivers an explicitly selected old message beyond the recent transcript page', async () => {
    const fixture = await serviceFixture('old-selected-message');
    const conversation = await fixture.service.createConversation({
      title: 'Selected history', defaultPolicy: 'DIRECT', agents: selections('builtin.lead'), clientOperationId: 'create-history'
    });
    const original = await fixture.service.sendMessage({
      conversationId: conversation.id, policy: 'NONE', agents: [], body: 'The rollback window is exactly forty-eight hours.',
      context: [], clientMessageId: 'old-source'
    });
    for (let index = 0; index < 105; index += 1) {
      await fixture.service.sendMessage({ conversationId: conversation.id, policy: 'NONE', agents: [],
        context: [], body: `Unrelated history entry ${index}.`, clientMessageId: `history-${index}` });
    }
    const preview = await fixture.service.previewContext({ conversationId: conversation.id, messageContext: [] });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id, policy: 'DIRECT', agents: selections('builtin.lead'), context: [],
      body: 'Use the selected support requirement.', sourceMessageIds: [original.message.id],
      clientMessageId: 'ask-old-source', previewFingerprint: preview.fingerprint
    });
    const prompt = await fixture.runtimeStore.readArtifact(sent.jobs[0]!.promptArtifactId!);
    expect(prompt).toContain('The rollback window is exactly forty-eight hours.');
    expect(prompt).toContain(original.message.id);
    expect(prompt).not.toContain('Unrelated history entry 0.');
  });

  it('stops before comparison if the saved model disappears, without switching models or losing answers', async () => {
    let catalog = runtimeCatalog();
    const fixture = await serviceFixture('adaptive-model-removed', () => catalog);
    const sent = await startTeam(fixture);
    const { conversationId, id: waveId } = sent.wave!;
    await completeTeamBatch(fixture, conversationId, () => 'The decision depends on the supported rollback window.');
    catalog = runtimeCatalog({ model: 'replacement-model', id: 'codex:replacement-model' });
    await fixture.service.advanceWave(conversationId, waveId, 'advance-without-saved-model');
    const aggregate = await fixture.discourseStore.getConversation(conversationId);
    expect(aggregate.jobs.filter((job) => job.role === 'ANSWER').every((job) => job.status === 'COMPLETED')).toBe(true);
    expect(aggregate.jobs.find((job) => job.role === 'COMPARE')).toMatchObject({
      status: 'FAILED', delivery: 'NOT_SENT', error: { code: 'PROVIDER_UNAVAILABLE' }
    });
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(2);
    expect(aggregate.waves[0]?.status).toBe('SETTLED');
  });

  it('runs independent authors, contestable comparison, direct mixed responses, and a recovered comparison without losing originals', async () => {
    const fixture = await serviceFixture('adaptive-team');
    const sent = await startTeam(fixture);
    const waveId = sent.wave!.id;
    const conversationId = sent.wave!.conversationId;
    expect(sent.wave?.policyVersion).toBe(2);
    expect(sent.jobs.map((job) => job.assignment.assignmentRole)).toEqual(['AUTHOR', 'AUTHOR']);
    expect(sent.jobs[0]?.visibleMessageIds).toEqual(sent.jobs[1]?.visibleMessageIds);
    const originalTaskSnapshot = await fixture.persistence.tasks.snapshot();
    await completeTeamBatch(fixture, conversationId, () => 'Keep the old reader until the migration finishes.');
    await fixture.service.advanceWave(conversationId, waveId, 'advance-comparison');
    let aggregate = await fixture.discourseStore.getConversation(conversationId);
    const answerIds = aggregate.jobs.filter((job) => job.role === 'ANSWER').flatMap((job) => job.result?.kind === 'CONTRIBUTION' ? [job.result.outputMessageId] : []);
    const comparisonJob = aggregate.jobs.find((job) => job.role === 'COMPARE')!;
    expect(comparisonJob.visibleMessageIds).toEqual([...sent.jobs[0]!.visibleMessageIds, ...answerIds]);
    const authors = sent.jobs.map((job) => job.assignment.stableParticipantId);
    const comparison = {
      summary: 'A and B agree, but rollback depends on old-reader compatibility.',
      points: [{ id: 'P1', question: 'Must we retain both readers?', importance: 'MATERIAL', status: 'OPEN',
        explanation: 'C may have overstated the rollback requirement.', sourceMessageIds: answerIds,
        evidence: [], confidence: 'LOW' }],
      next: 'CONTINUE', reason: 'Ask each author to bound the requirement.',
      actions: authors.map((participantId) => ({ pointId: 'P1', participantId,
        task: 'Does retaining the reader imply running both indefinitely?', expectedBenefit: 'Avoid unnecessary compatibility code.', basisMessageIds: answerIds }))
    };
    await completeTeamBatch(fixture, conversationId, () => JSON.stringify(comparison));
    await fixture.service.advanceWave(conversationId, waveId, 'advance-responses');
    aggregate = await fixture.discourseStore.getConversation(conversationId);
    const responses = aggregate.jobs.filter((job) => job.role === 'RESPOND');
    expect(responses).toHaveLength(2);
    expect(responses[0]?.visibleMessageIds).toEqual(responses[1]?.visibleMessageIds);
    expect(responses.every((job) => job.targetMessageIds.length === 1)).toBe(true);
    await completeTeamBatch(fixture, conversationId, (job) => JSON.stringify({
      responses: [{ pointId: 'P1', stance: job.assignment.stableParticipantId === authors[0] ? 'CLARIFY' : 'UNCERTAIN',
        answer: 'C confused temporary retention with permanent support.', reason: 'The original answer limited retention to migration.', evidence: ['Original answer: until the migration finishes.'] }],
      newIssues: ['The user must choose the supported rollback window.']
    }));
    await fixture.service.advanceWave(conversationId, waveId, 'advance-update');
    aggregate = await fixture.discourseStore.getConversation(conversationId);
    const update = aggregate.jobs.filter((job) => job.role === 'COMPARE').at(-1)!;
    expect(update.phase).toBe(4);
    const prompt = await fixture.runtimeStore.readArtifact(update.promptArtifactId!);
    expect(prompt).toContain('C confused temporary retention');
    expect(prompt).toContain('supported rollback window');
    // Simulate a crash after runtime output persistence, before Discourse projection.
    await completeTeamBatch(fixture, conversationId, () => JSON.stringify({ ...comparison,
      summary: 'C corrects its framing; the rollback window is a user choice.',
      points: [{ ...comparison.points[0], status: 'NEEDS_USER', explanation: 'Both authors disputed C’s framing. Neither chose the user’s support policy.' }],
      next: 'NEEDS_USER', reason: 'Which rollback window do you need?', actions: []
    }), true);
    await fixture.service.recoverConversation(conversationId);
    await fixture.service.recoverConversation(conversationId);
    aggregate = await fixture.discourseStore.getConversation(conversationId);
    expect(aggregate.waves[0]).toMatchObject({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'NEEDS_USER' });
    expect(aggregate.jobs).toHaveLength(6);
    const messages = (await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages;
    expect(messages.filter((message) => answerIds.includes(message.id)).every((message) => message.status === 'VISIBLE')).toBe(true);
    expect(messages).toHaveLength(7);
    expect(aggregate.concerns).toEqual([]);
    expect((await fixture.runtimeStore.snapshot()).sessions).toHaveLength(6);
    expect((await fixture.runtimeStore.snapshot()).queueEntries.every((entry) => entry.status === 'SETTLED')).toBe(true);
    expect(await fixture.persistence.tasks.snapshot()).toEqual(originalTaskSnapshot);
  });

  it.each([
    [new DiscourseContextChangedError(), 'CONTEXT_STALE', 'CONTEXT_CHANGED'],
    [new Error('Selected runtime refused its read-only policy.'), 'FAILED', 'PERMISSION_ATTESTATION_FAILED']
  ] as const)('preserves answers and distinguishes comparison preparation failure: %s', async (error, status, code) => {
    const fixture = await serviceFixture('comparison-preparation-failure');
    const sent = await startTeam(fixture);
    const { conversationId, id: waveId } = sent.wave!;
    await completeTeamBatch(fixture, conversationId, () => 'An independent answer.');
    vi.spyOn(fixture.snapshots, 'executionContextForSnapshot').mockRejectedValueOnce(error);
    await fixture.service.advanceWave(conversationId, waveId, 'prepare-comparison');
    const aggregate = await fixture.discourseStore.getConversation(conversationId);
    expect(aggregate.jobs.filter((job) => job.role === 'ANSWER').every((job) => job.status === 'COMPLETED')).toBe(true);
    expect(aggregate.jobs.find((job) => job.role === 'COMPARE')).toMatchObject({ status, delivery: 'NOT_SENT', error: { code } });
    expect(aggregate.waves[0]?.status).toBe('SETTLED');
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(2);
  });

  it('stops a mixed running and queued Team batch without submitting the waiting author', async () => {
    const fixture = await serviceFixture('team-stop');
    const sent = await startTeam(fixture);
    const entries = await fixture.scheduler.leaseAvailable('mixed-batch');
    await fixture.coordinator.dispatchLeasedJob(entries[0]!.id, 'start-one-author');
    await fixture.service.stopWave({ conversationId: sent.wave!.conversationId, waveId: sent.wave!.id, reason: 'User stop', clientOperationId: 'stop-mixed' });
    const aggregate = await fixture.discourseStore.getConversation(sent.wave!.conversationId);
    expect(aggregate.jobs[1]).toMatchObject({ status: 'CANCELED', delivery: 'NOT_SENT' });
    expect(fixture.provider.interruptCalls).toHaveLength(1);
    expect((await fixture.runtimeStore.snapshot()).runs[1]).toMatchObject({ status: 'INTERRUPTED', delivery: 'NOT_DELIVERED' });
  });

  it('recovers malformed C output as an archived failure without a repair call', async () => {
    const fixture = await serviceFixture('malformed-comparison');
    const sent = await startTeam(fixture);
    const { conversationId, id: waveId } = sent.wave!;
    await completeTeamBatch(fixture, conversationId, () => 'Keep rollback support for the requested period.');
    await fixture.service.advanceWave(conversationId, waveId, 'prepare-malformed-comparison');
    const raw = '{"summary":"The rest of this comparison is missing"}';
    await completeTeamBatch(fixture, conversationId, () => raw, true);
    await fixture.service.recoverConversation(conversationId);
    await fixture.service.recoverConversation(conversationId);
    const aggregate = await fixture.discourseStore.getConversation(conversationId);
    const comparator = aggregate.jobs.find((job) => job.role === 'COMPARE')!;
    expect(comparator).toMatchObject({ status: 'FAILED', error: { code: 'INVALID_RESULT', retryable: false } });
    const run = await fixture.runtimeStore.getRun(comparator.runId!);
    expect(await fixture.runtimeStore.readArtifact(run!.outputArtifactId)).toBe(raw);
    expect(aggregate.jobs).toHaveLength(3);
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(3);
    expect((await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages).toHaveLength(3);
    expect(aggregate.waves[0]).toMatchObject({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'FAILED' });
  });

  it('rejects an expired Team dispatch using its persisted start time after restart', async () => {
    const fixture = await serviceFixture('team-deadline');
    const sent = await startTeam(fixture);
    const entries = await fixture.scheduler.leaseAvailable('deadline-batch');
    await fixture.coordinator.dispatchLeasedJob(entries[0]!.id, 'start-before-deadline');
    const restarted = new DiscourseRuntimeCoordinator(fixture.discourseStore, fixture.runtimeStore, fixture.provider, () => '2026-07-13T00:26:00.000Z');
    const result = await restarted.dispatchLeasedJob(entries[1]!.id, 'start-after-deadline');
    expect(result).toMatchObject({ status: 'INTERRUPTED', delivery: 'NOT_DELIVERED' });
    const aggregate = await fixture.discourseStore.getConversation(sent.wave!.conversationId);
    expect(aggregate.waves[0]).toMatchObject({ requestedStopReason: 'TIME_LIMIT', startedAt: '2026-07-13T00:05:00.000Z' });
    expect(aggregate.jobs.filter((job) => job.role === 'COMPARE')).toHaveLength(0);
  });

  it('persists an idempotent Direct send through frozen context and a queued scoped run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-service-'));
    const persistence = await openTestPersistence(path.join(root, 'profile'));
    const taskStore = persistence.tasks;
    const discourseStore = persistence.discourse;
    const runtimeStore = persistence.agentRuntime;
    const resolver = new DiscourseContextResolver(taskStore);
    const snapshots = new DiscourseContextSnapshotService(
      resolver,
      new DiscourseWorkspace(path.join(root, 'workspaces')),
      async (input) => ({
        attestation: { status: 'ATTESTED' },
        repositoryAccess: 'READ_ONLY',
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
    const agents = new ScriptedAgentRuntimeCoordinator(runtimeStore);
    const coordinator = new DiscourseRuntimeCoordinator(
      discourseStore,
      runtimeStore,
      agents,
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
          notifySchedulerWorkAvailable: () => {
            schedulerNotifications += 1;
          }
        }
      }
    );
    const conversation = await service.createConversation({
      title: 'Direct architecture question',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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

  it('replays conversation creation by semantic request instead of generated identities', async () => {
    const fixture = await serviceFixture('create-replay');
    const request = {
      title: 'Replay-safe conversation',
      defaultPolicy: 'DIRECT' as const,
      agents: selections('builtin.lead'),
      clientOperationId: 'create-replay-operation'
    };

    const created = await fixture.service.createConversation(request);
    await expect(fixture.service.createConversation(request)).resolves.toEqual(created);
    expect((await fixture.discourseStore.listConversations()).conversations).toHaveLength(1);
  });

  it('replays an accepted conversation create before consulting a changed runtime catalog', async () => {
    let catalogAvailable = true;
    const fixture = await serviceFixture('create-replay-catalog-drift', () => {
      if (!catalogAvailable) throw new Error('Catalog is temporarily unavailable.');
      return runtimeCatalog();
    });
    const request = {
      title: 'Durable create replay',
      defaultPolicy: 'DIRECT' as const,
      agents: selections('builtin.lead'),
      clientOperationId: 'create-replay-before-catalog'
    };

    const created = await fixture.service.createConversation(request);
    catalogAvailable = false;
    await expect(fixture.service.createConversation(request)).resolves.toEqual(created);
    await expect(fixture.service.createConversation({
      ...request,
      title: 'Changed create request'
    })).rejects.toThrow('REQUEST_CONFLICT');
  });

  it('plans Panel respondents as independent jobs over the same frozen input', async () => {
    const fixture = await serviceFixture('panel');
    const conversation = await fixture.service.createConversation({
      title: 'Independent panel',
      defaultPolicy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
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
      agents: selections('builtin.lead', 'builtin.skeptic'),
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

  it('preserves a successful Panel response when another participant fails', async () => {
    const fixture = await serviceFixture('panel-participant-failure');
    const conversation = await fixture.service.createConversation({
      title: 'Isolated panel failure',
      defaultPolicy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
      clientOperationId: 'create-panel-failure'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Keep each participant result independent.',
      context: [],
      clientMessageId: 'panel-failure-message',
      policy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
      previewFingerprint: preview.fingerprint
    });
    const leases = await fixture.scheduler.leaseAvailable('lease-panel-failure');
    expect(leases).toHaveLength(2);
    const runs = [];
    for (const [index, lease] of leases.entries()) {
      runs.push(
        await fixture.coordinator.dispatchLeasedJob(
          lease.id,
          `dispatch-panel-failure-${index}`
        )
      );
    }

    await fixture.coordinator.ingestFailure({
      runId: runs[0]!.id,
      providerTurnId: runs[0]!.providerTurnId!,
      clientOperationId: 'terminal-panel-failure',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL',
      reason: 'One participant failed independently.'
    });
    await markRepositoryUnchanged(
      fixture.runtimeStore,
      runs[1]!.id,
      'terminal-panel-success-integrity'
    );
    await expect(
      fixture.coordinator.ingestContribution({
        runId: runs[1]!.id,
        providerTurnId: runs[1]!.providerTurnId!,
        body: 'The sibling participant still produced a useful answer.',
        freshnessAtCompletion: 'FRESH',
        clientOperationId: 'terminal-panel-success',
        completedAt: '2026-07-13T00:11:00.000Z',
        providerTerminalSource: 'TEST_TERMINAL'
      })
    ).resolves.toMatchObject({ kind: 'CURATED' });

    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.waves).toMatchObject([
      { id: sent.wave!.id, status: 'SETTLED', outcome: 'PARTIAL' }
    ]);
    expect(aggregate.jobs.map((job) => job.status).sort()).toEqual([
      'COMPLETED',
      'FAILED'
    ]);
    expect(
      (await fixture.discourseStore.listMessages({
        conversationId: conversation.id,
        limit: 100
      })).messages.map((message) => message.body)
    ).toContain('The sibling participant still produced a useful answer.');
    expect((await fixture.runtimeStore.snapshot()).queueEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'SETTLED' }),
        expect.objectContaining({ status: 'SETTLED' })
      ])
    );
    expect(new Set(fixture.provider.finishedRunIds)).toEqual(
      new Set(runs.map((run) => run.id))
    );
  }, 15_000);

  it('routes independently configured agent models and freezes each assignment', async () => {
    const catalog = runtimeCatalog();
    const alternateModel = {
      ...catalog.models[0]!,
      id: 'codex:gpt-alternate',
      model: 'gpt-alternate',
      displayName: 'GPT Alternate',
      isDefault: false
    };
    catalog.models = [...catalog.models, alternateModel];
    catalog.runtimes[0] = {
      ...catalog.runtimes[0]!,
      models: catalog.models
    };
    const fixture = await serviceFixture('independent-configurations', () => catalog);
    const configuredAgents: DiscourseAgentSelectionInput[] = [
      {
        agentProfileId: 'builtin.lead',
        runtimeId: 'codex',
        modelId: 'codex:gpt-test',
        reasoningEffort: 'medium'
      },
      {
        agentProfileId: 'builtin.skeptic',
        runtimeId: 'codex',
        modelId: 'codex:gpt-alternate',
        reasoningEffort: 'medium'
      }
    ];
    const initialAgents = configuredAgents.map((selection) => ({
      ...selection,
      modelId: 'codex:gpt-test'
    }));
    const conversation = await fixture.service.createConversation({
      title: 'Compare model perspectives',
      defaultPolicy: 'PANEL',
      agents: initialAgents,
      clientOperationId: 'create-configured-panel'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });

    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Evaluate this decision independently.',
      context: [],
      clientMessageId: 'configured-panel-message',
      policy: 'PANEL',
      agents: configuredAgents,
      previewFingerprint: preview.fingerprint
    });

    expect(sent.jobs.map((job) => [job.assignment.agentProfileId, job.assignment.model])).toEqual([
      ['builtin.lead', 'gpt-test'],
      ['builtin.skeptic', 'gpt-alternate']
    ]);
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(currentParticipantModels(aggregate)).toEqual({
      'builtin.lead': 'gpt-test',
      'builtin.skeptic': 'gpt-alternate'
    });
    expect(
      aggregate.participantRevisions
        .filter((revision) => revision.agentProfileId === 'builtin.skeptic')
        .map((revision) => revision.model)
    ).toEqual(['gpt-test', 'gpt-alternate']);
    expect(
      (await fixture.runtimeStore.snapshot()).sessions.map((session) =>
        session.requestedSettings.model
      )
    ).toEqual(['gpt-test', 'gpt-alternate']);
  }, 15_000);

  it('routes each Panel participant through its selected runtime and rejects conflicting replay', async () => {
    const catalog = runtimeCatalog();
    const alternateModel = {
      ...catalog.models[0]!,
      id: 'alternate:reasoner',
      runtimeId: 'alternate',
      modelProvider: 'alternate-provider',
      model: 'reasoner',
      displayName: 'Alternate Reasoner'
    };
    catalog.models = [...catalog.models, alternateModel];
    catalog.runtimes.push({
      preflight: {
        runtime: {
          ...CODEX_RUNTIME_DESCRIPTOR,
          id: 'alternate',
          displayName: 'Alternate Provider'
        },
        readiness: createRuntimeReadiness('READY', 'Alternate provider is ready.'),
        capabilities: {
          ...codexCapabilities(),
          runtimeId: 'alternate'
        }
      },
      models: [alternateModel],
      refreshedAt: catalog.refreshedAt
    });
    const fixture = await serviceFixture('cross-runtime-routing', () => catalog);
    const agents: DiscourseAgentSelectionInput[] = [
      {
        agentProfileId: 'builtin.lead',
        runtimeId: 'codex',
        modelId: 'codex:gpt-test',
        reasoningEffort: 'medium'
      },
      {
        agentProfileId: 'builtin.skeptic',
        runtimeId: 'alternate',
        modelId: 'alternate:reasoner',
        reasoningEffort: 'medium'
      }
    ];
    const conversation = await fixture.service.createConversation({
      title: 'Cross-runtime panel',
      defaultPolicy: 'PANEL',
      agents,
      clientOperationId: 'create-cross-runtime'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const request: SendDiscourseMessageRequest = {
      conversationId: conversation.id,
      body: 'Compare these independent runtime perspectives.',
      context: [],
      clientMessageId: 'cross-runtime-message',
      policy: 'PANEL',
      agents,
      previewFingerprint: preview.fingerprint
    };

    const sent = await fixture.service.sendMessage(request);
    expect(sent.jobs.map((job) => [
      job.assignment.agentProfileId,
      job.assignment.runtimeId,
      job.assignment.model
    ])).toEqual([
      ['builtin.lead', 'codex', 'gpt-test'],
      ['builtin.skeptic', 'alternate', 'reasoner']
    ]);
    expect(fixture.executionContextInputs.map((input) => [
      input.runtimeId,
      input.modelSettings.model
    ])).toEqual([
      ['codex', 'gpt-test'],
      ['alternate', 'reasoner']
    ]);
    const leases = await fixture.scheduler.leaseAvailable('cross-runtime-leases');
    for (const [index, lease] of leases.entries()) {
      await fixture.coordinator.dispatchLeasedJob(
        lease.id,
        `cross-runtime-dispatch-${index}`
      );
    }
    expect(fixture.provider.calls.map((call) => [
      call.session.runtimeId,
      call.session.executionContext.modelSettings.model
    ])).toEqual([
      ['codex', 'gpt-test'],
      ['alternate', 'reasoner']
    ]);

    const beforeConflict = await fixture.discourseStore.getConversation(conversation.id);
    await expect(fixture.service.sendMessage({
      ...request,
      agents: [agents[1]!, agents[0]!]
    })).rejects.toThrow('REQUEST_CONFLICT');
    const afterConflict = await fixture.discourseStore.getConversation(conversation.id);
    expect(afterConflict.participantRevisions).toEqual(beforeConflict.participantRevisions);
    expect(afterConflict.waves).toEqual(beforeConflict.waves);
  });

  it('preserves an explicit model provider that equals its runtime id through dispatch', async () => {
    const catalog = runtimeCatalog({
      id: 'opencode:opencode/model',
      runtimeId: 'opencode',
      modelProvider: 'opencode',
      model: 'model',
      displayName: 'OpenCode Model'
    });
    catalog.defaultRuntimeId = 'opencode';
    catalog.runtimes[0] = {
      ...catalog.runtimes[0]!,
      preflight: {
        ...catalog.runtimes[0]!.preflight,
        runtime: {
          ...catalog.runtimes[0]!.preflight.runtime,
          id: 'opencode',
          displayName: 'OpenCode'
        },
        capabilities: {
          ...catalog.runtimes[0]!.preflight.capabilities,
          runtimeId: 'opencode'
        }
      },
      models: catalog.models
    };
    const fixture = await serviceFixture('provider-runtime-collision', () => catalog);
    const agents: DiscourseAgentSelectionInput[] = [{
      agentProfileId: 'builtin.lead',
      runtimeId: 'opencode',
      modelId: 'opencode:opencode/model'
    }];
    const conversation = await fixture.service.createConversation({
      title: 'Provider identity',
      defaultPolicy: 'DIRECT',
      agents,
      clientOperationId: 'create-provider-identity'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Keep the selected provider identity.',
      context: [],
      clientMessageId: 'provider-identity-message',
      policy: 'DIRECT',
      agents,
      previewFingerprint: preview.fingerprint
    });
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);

    expect(aggregate.participantRevisions[0]?.modelProvider).toBe('opencode');
    expect(sent.jobs[0]?.assignment.modelProvider).toBe('opencode');
    expect(fixture.executionContextInputs[0]?.modelSettings.modelProvider).toBe('opencode');
    expect((await fixture.runtimeStore.snapshot()).sessions[0]?.requestedSettings.modelProvider)
      .toBe('opencode');
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
      agents: selections('builtin.lead', 'builtin.skeptic'),
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
      agents: selections('builtin.lead', 'builtin.skeptic'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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

  it('recovers an atomic accepted send when context preparation fails before wave planning', async () => {
    const catalog = runtimeCatalog();
    const alternateModel = {
      ...catalog.models[0]!,
      id: 'codex:gpt-recovery',
      model: 'gpt-recovery',
      displayName: 'GPT Recovery',
      isDefault: false
    };
    catalog.models = [...catalog.models, alternateModel];
    catalog.runtimes[0] = { ...catalog.runtimes[0]!, models: catalog.models };
    const fixture = await serviceFixture('accepted-send-recovery', () => catalog);
    const conversation = await fixture.service.createConversation({
      title: 'Accepted send recovery',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-accepted-send-recovery'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const request: SendDiscourseMessageRequest = {
      conversationId: conversation.id,
      body: 'Keep this message and exact model assignment across a planning crash.',
      context: [],
      clientMessageId: 'accepted-send-recovery-message',
      policy: 'DIRECT',
      agents: [{
        agentProfileId: 'builtin.lead',
        runtimeId: 'codex',
        modelId: alternateModel.id,
        reasoningEffort: 'medium'
      }],
      previewFingerprint: preview.fingerprint
    };
    const originalPrepare = fixture.snapshots.prepare.bind(fixture.snapshots);
    const prepare = vi.spyOn(fixture.snapshots, 'prepare')
      .mockRejectedValueOnce(new Error('Simulated crash before wave persistence.'))
      .mockRejectedValueOnce(new Error('Simulated second crash before wave persistence.'))
      .mockImplementation(originalPrepare);

    await expect(fixture.service.sendMessage(request)).rejects.toThrow(
      'Simulated crash before wave persistence'
    );
    const secondPreview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const laterRequest: SendDiscourseMessageRequest = {
      ...request,
      body: 'This later prompt must never enter the earlier response window.',
      clientMessageId: 'accepted-send-later-message',
      previewFingerprint: secondPreview.fingerprint
    };
    await expect(fixture.service.sendMessage(laterRequest)).rejects.toThrow(
      'Simulated second crash before wave persistence'
    );
    prepare.mockRestore();
    await fixture.persistence.close();
    const restartedPersistence = await openTestPersistence(
      path.join(fixture.root, 'profile')
    );
    const restartedFixture = composeServiceFixture(
      fixture.root,
      restartedPersistence,
      () => catalog
    );
    const durable = await restartedFixture.discourseStore.getConversation(
      conversation.id
    );
    expect(durable).toMatchObject({
      acceptedSends: [
        {
          clientMessageId: request.clientMessageId,
          policy: 'DIRECT',
          status: 'PENDING',
          visibleMessageIds: [expect.any(String)],
          assignments: [{ runtimeId: 'codex', model: 'gpt-recovery' }]
        },
        {
          clientMessageId: laterRequest.clientMessageId,
          status: 'PENDING',
          visibleMessageIds: [expect.any(String), expect.any(String)]
        }
      ],
      waves: []
    });
    expect(currentParticipantModels(durable)).toEqual({
      'builtin.lead': 'gpt-recovery'
    });
    expect((await restartedFixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toMatchObject([
      { body: request.body, status: 'VISIBLE' },
      { body: laterRequest.body, status: 'VISIBLE' }
    ]);
    expect((await restartedFixture.discourseStore.listConversations()).conversations[0])
      .toMatchObject({
      needsAttention: true
    });

    await restartedFixture.service.resumeAcceptedSend({
      conversationId: conversation.id,
      acceptedSendId: durable.acceptedSends[0]!.id
    });
    await restartedFixture.service.resumeAcceptedSend({
      conversationId: conversation.id,
      acceptedSendId: durable.acceptedSends[1]!.id
    });
    await expect(restartedFixture.service.sendMessage(request)).resolves.toMatchObject(
      {
        wave: { status: 'QUEUED' },
        jobs: [{ assignment: { model: 'gpt-recovery' } }]
      }
    );
    const recovered = await restartedFixture.discourseStore.getConversation(
      conversation.id
    );
    expect(recovered.waves).toHaveLength(2);
    const firstJob = recovered.jobs.find(
      (job) => job.waveId === recovered.waves[0]?.id
    );
    const secondJob = recovered.jobs.find(
      (job) => job.waveId === recovered.waves[1]?.id
    );
    expect(firstJob?.visibleMessageIds).toEqual([
      durable.acceptedSends[0]!.triggerMessageId
    ]);
    expect(secondJob?.visibleMessageIds).toEqual([
      durable.acceptedSends[0]!.triggerMessageId,
      durable.acceptedSends[1]!.triggerMessageId
    ]);
    expect((await restartedFixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toHaveLength(2);
  });

  it('requires an interrupted response to be canceled before its message is deleted or archived', async () => {
    const fixture = await serviceFixture('accepted-send-cancel');
    const conversation = await fixture.service.createConversation({
      title: 'Cancel interrupted response',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-accepted-send-cancel'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    vi.spyOn(fixture.snapshots, 'prepare')
      .mockRejectedValueOnce(new Error('Simulated planning interruption.'));
    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Preserve this message until I explicitly cancel its response.',
      context: [],
      clientMessageId: 'accepted-send-cancel-message',
      policy: 'DIRECT',
      agents: selections('builtin.lead'),
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow('Simulated planning interruption');

    let aggregate = await fixture.discourseStore.getConversation(conversation.id);
    const accepted = aggregate.acceptedSends[0]!;
    await expect(fixture.service.tombstoneMessage({
      conversationId: conversation.id,
      messageId: accepted.triggerMessageId,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'delete-pending-accepted-message'
    })).rejects.toThrow('Cancel the interrupted agent response');
    await expect(fixture.service.setConversationArchived({
      conversationId: conversation.id,
      archived: true,
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'archive-pending-accepted-conversation'
    })).rejects.toThrow('Cancel the interrupted agent response');

    const cancelRequest = {
      conversationId: conversation.id,
      acceptedSendId: accepted.id,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'cancel-accepted-send'
    };
    aggregate = await fixture.service.cancelAcceptedSend(cancelRequest);
    expect(aggregate.acceptedSends[0]).toMatchObject({
      id: accepted.id,
      status: 'CANCELED',
      recordRevision: 2,
      canceledAt: expect.any(String)
    });
    await expect(fixture.service.cancelAcceptedSend(cancelRequest)).resolves.toEqual(aggregate);
    await fixture.service.tombstoneMessage({
      conversationId: conversation.id,
      messageId: accepted.triggerMessageId,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'delete-canceled-accepted-message'
    });
    aggregate = await fixture.discourseStore.getConversation(conversation.id);
    await fixture.service.setConversationArchived({
      conversationId: conversation.id,
      archived: true,
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'archive-canceled-accepted-conversation'
    });

    await fixture.persistence.close();
    const restartedPersistence = await openTestPersistence(
      path.join(fixture.root, 'profile')
    );
    const archived = await restartedPersistence.discourse.getConversation(
      conversation.id
    );
    expect(archived).toMatchObject({
      conversation: { status: 'ARCHIVED' },
      acceptedSends: [{ status: 'CANCELED' }],
      waves: []
    });
    const archivedPage = await restartedPersistence.discourse.listConversations({
      status: 'ARCHIVED'
    });
    expect(archivedPage.conversations[0]).toMatchObject({ needsAttention: false });
  });

  it('counts unplanned accepted sends against the queued-response safety limit', async () => {
    const fixture = await serviceFixture('accepted-send-limit');
    const conversation = await fixture.service.createConversation({
      title: 'Bound pending responses',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-accepted-send-limit'
    });
    vi.spyOn(fixture.snapshots, 'prepare')
      .mockRejectedValue(new Error('Persistent context preparation failure.'));

    for (let index = 0; index < 8; index += 1) {
      const preview = await fixture.service.previewContext({
        conversationId: conversation.id,
        messageContext: []
      });
      await expect(fixture.service.sendMessage({
        conversationId: conversation.id,
        body: `Pending response ${index + 1}`,
        context: [],
        clientMessageId: `pending-response-${index + 1}`,
        policy: 'DIRECT',
        agents: selections('builtin.lead'),
        previewFingerprint: preview.fingerprint
      })).rejects.toThrow('Persistent context preparation failure');
    }
    const ninthPreview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'This response must not exceed the pending limit.',
      context: [],
      clientMessageId: 'pending-response-9',
      policy: 'DIRECT',
      agents: selections('builtin.lead'),
      previewFingerprint: ninthPreview.fingerprint
    })).rejects.toThrow('queued-response safety limit');
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.acceptedSends).toHaveLength(8);
    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toHaveLength(8);
  });

  it('repairs partial Panel runtime preparation during startup recovery', async () => {
    const fixture = await serviceFixture('partial-panel-recovery');
    const conversation = await fixture.service.createConversation({
      title: 'Partial panel recovery',
      defaultPolicy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
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
      agents: selections('builtin.lead', 'builtin.skeptic'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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

  it('terminalizes queued jobs when context changes again during reconfirmation', async () => {
    const fixture = await serviceFixture('reconfirmation-second-drift');
    const conversation = await fixture.service.createConversation({
      title: 'Context reconfirmation',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-reconfirmation'
    });
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });
    const prepare = fixture.snapshots.prepare.bind(fixture.snapshots);
    vi.spyOn(fixture.snapshots, 'prepare').mockImplementation(async (input) => {
      const prepared = await prepare(input);
      return {
        ...prepared,
        preview: { ...prepared.preview, fingerprint: 'changed-preview-fingerprint' }
      };
    });
    const sent = await fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Answer only if this frozen context still matches.',
      context: [],
      clientMessageId: 'reconfirmation-message',
      policy: 'DIRECT',
      agents: selections('builtin.lead'),
      previewFingerprint: preview.fingerprint
    });
    expect(sent.wave).toMatchObject({
      status: 'PLANNED',
      dispatchGate: {
        status: 'RECONFIRMATION_REQUIRED',
        currentFingerprint: 'changed-preview-fingerprint'
      }
    });

    await fixture.service.confirmWaveContext({
      conversationId: conversation.id,
      waveId: sent.wave!.id,
      previewFingerprint: 'changed-preview-fingerprint',
      expectedWaveRevision: sent.wave!.recordRevision,
      clientOperationId: 'confirm-after-second-drift'
    });
    const aggregate = await fixture.discourseStore.getConversation(conversation.id);
    expect(aggregate.waves[0]).toMatchObject({
      status: 'SETTLED',
      outcome: 'STALE',
      settlementReason: 'CONTEXT_CHANGED'
    });
    expect(aggregate.jobs[0]).toMatchObject({
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow('Sign in to Codex.');

    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toEqual([]);
    expect((await fixture.discourseStore.getConversation(conversation.id)).waves).toEqual([]);
  });

  it('revalidates the saved runtime even when another Discourse runtime remains available', async () => {
    let catalog = runtimeCatalog();
    const alternateModel = {
      ...catalog.models[0]!,
      id: 'alternate:gpt-test',
      runtimeId: 'alternate'
    };
    const alternateRuntime = {
      preflight: {
        runtime: { ...CODEX_RUNTIME_DESCRIPTOR, id: 'alternate', displayName: 'Alternate' },
        readiness: createRuntimeReadiness('READY', 'Alternate is ready.'),
        capabilities: { ...codexCapabilities(), runtimeId: 'alternate' }
      },
      models: [alternateModel],
      refreshedAt: catalog.refreshedAt
    };
    catalog = {
      ...catalog,
      runtimes: [...catalog.runtimes, alternateRuntime],
      models: [...catalog.models, alternateModel]
    };
    const fixture = await serviceFixture('saved-runtime-unavailable', () => catalog);
    const conversation = await fixture.service.createConversation({
      title: 'Saved runtime boundary',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-saved-runtime'
    });
    const codex = catalog.runtimes[0]!;
    catalog = {
      ...catalog,
      runtimes: [{
        ...codex,
        preflight: {
          ...codex.preflight,
          readiness: createRuntimeReadiness('AUTHENTICATION_REQUIRED', 'Sign in again.')
        }
      }, alternateRuntime]
    };
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });

    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'Do not silently move this saved participant.',
      context: [],
      clientMessageId: 'saved-runtime-message',
      policy: 'DIRECT',
      agents: selections('builtin.lead'),
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow('cannot respond through its saved provider');
    expect((await fixture.discourseStore.listMessages({
      conversationId: conversation.id,
      limit: 100
    })).messages).toEqual([]);
  });

  it('does not revise participant configuration when an archived send is rejected', async () => {
    const catalog = runtimeCatalog();
    const alternateModel = {
      ...catalog.models[0]!,
      id: 'codex:gpt-alternate',
      model: 'gpt-alternate',
      displayName: 'GPT Alternate'
    };
    catalog.models.push(alternateModel);
    catalog.runtimes[0] = { ...catalog.runtimes[0]!, models: catalog.models };
    const fixture = await serviceFixture('archived-config-rejection', () => catalog);
    const conversation = await fixture.service.createConversation({
      title: 'Archived configuration',
      defaultPolicy: 'DIRECT',
      agents: selections('builtin.lead'),
      clientOperationId: 'create-archived-config'
    });
    await fixture.discourseStore.setConversationArchived({
      conversationId: conversation.id,
      archived: true,
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'archive-before-config'
    });
    const before = await fixture.discourseStore.getConversation(conversation.id);
    const preview = await fixture.service.previewContext({
      conversationId: conversation.id,
      messageContext: []
    });

    await expect(fixture.service.sendMessage({
      conversationId: conversation.id,
      body: 'This archived send must have no side effects.',
      context: [],
      clientMessageId: 'archived-config-message',
      policy: 'DIRECT',
      agents: [{
        agentProfileId: 'builtin.lead',
        runtimeId: 'codex',
        modelId: 'codex:gpt-alternate'
      }],
      previewFingerprint: preview.fingerprint
    })).rejects.toThrow('Archived discourse conversations cannot accept messages');
    const after = await fixture.discourseStore.getConversation(conversation.id);
    expect(after.participantRevisions).toEqual(before.participantRevisions);
    expect(after.participants).toEqual(before.participants);
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
      agents: selections('builtin.lead'),
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
      agents: selections('builtin.lead'),
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

  it('recovers historical policy-1 Team sends through isolated reviews and one correction', async () => {
    const fixture = await serviceFixture('team');
    const accept = fixture.discourseStore.acceptAgentSend.bind(fixture.discourseStore);
    vi.spyOn(fixture.discourseStore, 'acceptAgentSend').mockImplementation((input) => accept({
      ...input, policyVersion: 1,
      assignments: input.assignments.map((assignment) => ({ ...assignment,
        assignmentRole: assignment.agentProfileId === 'builtin.lead' ? 'PRIMARY' : 'REVIEWER'
      }))
    }));
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
      agents: selections('builtin.lead', 'builtin.skeptic', 'builtin.verifier'),
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
      agents: selections('builtin.verifier', 'builtin.lead', 'builtin.skeptic'),
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
      'dispatch-lead'
    );
    await markRepositoryUnchanged(
      fixture.runtimeStore,
      leadRun.id,
      'terminal-lead-integrity'
    );
    const leadTerminal = await fixture.coordinator.ingestSuccessfulTerminal({
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
    const firstReviewOutput = await fixture.runtimeStore.getArtifact(
      reviewRuns[0]!.outputArtifactId
    );
    await fixture.runtimeStore.updateArtifact({
      artifactId: firstReviewOutput!.id,
      expectedRevision: firstReviewOutput!.recordRevision,
      clientOperationId: 'terminal-review-1-output',
      content: noConcern
    });
    await fixture.runtimeStore.updateRun(
      reviewRuns[0]!.id,
      reviewRuns[0]!.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        repositoryIntegrity: {
          status: 'UNCHANGED',
          checkedAt: '2026-07-13T00:11:00.000Z'
        },
        contextFreshnessAtCompletion: 'FRESH',
        providerTerminalSource: 'TEST_RECOVERY_TERMINAL',
        lastEventAt: '2026-07-13T00:11:00.000Z',
        endedAt: '2026-07-13T00:11:00.000Z'
      },
      'terminal-review-1-runtime'
    );
    await fixture.service.recoverConversation(conversation.id);
    expect((await fixture.discourseStore.getConversation(conversation.id)).jobs.find(
      (job) => job.id === reviews[0]!.id
    )).toMatchObject({ status: 'COMPLETED', result: { kind: 'REVIEW' } });
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
    await markRepositoryUnchanged(
      fixture.runtimeStore,
      reviewRuns[1]!.id,
      'terminal-review-2-integrity'
    );
    await fixture.coordinator.ingestSuccessfulTerminal({
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
      'dispatch-correction'
    );
    const correctionBody = JSON.stringify({
      outcome: 'REVISED',
      body: 'The migration is one-way unless an explicit reverse migration is provided.',
      limitations: []
    });
    const correctionOutput = await fixture.runtimeStore.getArtifact(
      correctionRun.outputArtifactId
    );
    await fixture.runtimeStore.updateArtifact({
      artifactId: correctionOutput!.id,
      expectedRevision: correctionOutput!.recordRevision,
      clientOperationId: 'terminal-correction-output',
      content: correctionBody
    });
    await fixture.runtimeStore.updateRun(
      correctionRun.id,
      correctionRun.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        repositoryIntegrity: {
          status: 'UNCHANGED',
          checkedAt: '2026-07-13T00:13:00.000Z'
        },
        contextFreshnessAtCompletion: 'FRESH',
        providerTerminalSource: 'TEST_RECOVERY_TERMINAL',
        lastEventAt: '2026-07-13T00:13:00.000Z',
        endedAt: '2026-07-13T00:13:00.000Z'
      },
      'terminal-correction-runtime'
    );
    await fixture.service.recoverConversation(conversation.id);

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
  const persistence = await openTestPersistence(path.join(root, 'profile'));
  return {
    root,
    persistence,
    ...composeServiceFixture(root, persistence, getRuntimeCatalog)
  };
}

async function startTeam(fixture: Awaited<ReturnType<typeof serviceFixture>>) {
  const conversation = await fixture.service.createConversation({ title: 'Adaptive Team', defaultPolicy: 'TEAM',
    agents: selections('builtin.lead', 'builtin.skeptic', 'builtin.verifier'), clientOperationId: 'create-abc' });
  const preview = await fixture.service.previewContext({ conversationId: conversation.id, messageContext: [] });
  return fixture.service.sendMessage({ conversationId: conversation.id, body: 'How should we bound migration rollback support?',
    context: [], policy: 'TEAM', agents: selections('builtin.lead', 'builtin.skeptic', 'builtin.verifier'),
    previewFingerprint: preview.fingerprint, clientMessageId: 'send-abc' });
}

async function completeTeamBatch(
  fixture: Awaited<ReturnType<typeof serviceFixture>>, conversationId: string,
  body: (job: DiscourseConversationAggregateRecord['jobs'][number]) => string,
  runtimeOnly = false
) {
  const entries = await fixture.scheduler.leaseAvailable(`lease:${crypto.randomUUID()}`);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const run = await fixture.coordinator.dispatchLeasedJob(entry.id, `dispatch:${entry.id}`);
    const job = (await fixture.discourseStore.getConversation(conversationId)).jobs.find((candidate) => candidate.runId === run.id)!;
    await markRepositoryUnchanged(fixture.runtimeStore, run.id, `integrity:${run.id}`);
    if (runtimeOnly) {
      const artifact = await fixture.runtimeStore.getArtifact(run.outputArtifactId);
      await fixture.runtimeStore.updateArtifact({ artifactId: artifact!.id, expectedRevision: artifact!.recordRevision,
        clientOperationId: `output:${run.id}`, content: body(job) });
      const latest = (await fixture.runtimeStore.getRun(run.id))!;
      await fixture.runtimeStore.updateRun(run.id, latest.recordRevision, { status: 'COMPLETED', delivery: 'TERMINAL',
        contextFreshnessAtCompletion: 'FRESH', providerTerminalSource: 'TEST_RECOVERY_TERMINAL',
        endedAt: '2026-07-13T00:10:00.000Z', lastEventAt: '2026-07-13T00:10:00.000Z' }, `terminal:${run.id}`);
    } else {
      const result = await fixture.coordinator.ingestSuccessfulTerminal({ runId: run.id, providerTurnId: run.providerTurnId!, body: body(job),
        freshnessAtCompletion: 'FRESH', clientOperationId: `terminal:${run.id}`, completedAt: '2026-07-13T00:10:00.000Z', providerTerminalSource: 'TEST_TERMINAL' });
      expect(result.kind).toBe('CURATED');
    }
  }
}

function composeServiceFixture(
  root: string,
  persistence: ApplicationPersistence,
  getRuntimeCatalog: () => AgentRuntimeCatalog
) {
  const taskStore = persistence.tasks;
  const discourseStore = persistence.discourse;
  const runtimeStore = persistence.agentRuntime;
  const resolver = new DiscourseContextResolver(taskStore);
  const executionContextInputs: DiscourseReadOnlyExecutionScopeInput[] = [];
  const snapshots = new DiscourseContextSnapshotService(
    resolver,
    new DiscourseWorkspace(path.join(root, 'workspaces')),
    async (input) => {
      executionContextInputs.push(input);
      return {
        attestation: { status: 'ATTESTED' },
        repositoryAccess: 'READ_ONLY',
        primaryCwd: input.primaryCwd,
        readRoots: input.readRoots,
        managedAttachments: [],
        // ACP policies include runtime/session identity. Fresh sessions must not
        // have to equal the first author's native permission hash.
        permissionProfileHash: createHash('sha256').update(`${input.runtimeId}:${input.sessionId}`).digest('hex'),
        modelSettings: input.modelSettings,
        externalTools: {
          network: false,
          webSearch: 'disabled',
          mcpServers: false,
          apps: false,
          dynamicTools: false
        },
        clientOperationId: input.clientOperationId
      };
    },
    () => '2026-07-13T00:01:00.000Z'
  );
  const provider = new ScriptedAgentRuntimeCoordinator(runtimeStore);
  const coordinator = new DiscourseRuntimeCoordinator(
    discourseStore,
    runtimeStore,
    provider,
    () => '2026-07-13T00:05:00.000Z'
  );
  const scheduler = new AgentTurnScheduler(
    runtimeStore,
    () => '2026-07-13T00:06:00.000Z'
  );
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
        notifySchedulerWorkAvailable: () => undefined
      }
    }
  );
  return {
    service,
    discourseStore,
    runtimeStore,
    coordinator,
    scheduler,
    provider,
    snapshots,
    executionContextInputs
  };
}

async function markRepositoryUnchanged(
  runtime: SqliteAgentRuntimeStore,
  runId: string,
  clientOperationId: string
): Promise<void> {
  const run = await runtime.getRun(runId);
  if (!run) throw new Error(`Runtime run not found: ${runId}`);
  await runtime.updateRun(
    run.id,
    run.recordRevision,
    {
      repositoryIntegrity: {
        status: 'UNCHANGED',
        checkedAt: '2026-07-13T00:10:00.000Z'
      }
    },
    clientOperationId
  );
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
