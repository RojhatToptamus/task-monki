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
  it.each([false, true])('keeps a peer check bounded, with author response requested=%s', async (requestAuthorResponse) => {
    const fixture = await serviceFixture(`peer-${requestAuthorResponse}`);
    const initial = await startChat(fixture);
    const conversationId = initial.wave!.conversationId;
    await completeChatJob(fixture, conversationId, () => 'A per-worker retry counter bounds total retries.');
    const before = await fixture.discourseStore.listMessages({ conversationId, limit: 100 });
    const answer = before.messages.at(-1)!;
    const preview = await fixture.service.previewContext({ conversationId, messageContext: [] });
    const request: SendDiscourseMessageRequest = { conversationId, body: 'Check the bound across workers.',
      policy: 'CHAT', agents: selections('builtin.lead', 'builtin.skeptic'), context: [],
      replyToMessageId: answer.id, previewFingerprint: preview.fingerprint, clientMessageId: 'peer-check' };
    const check = await fixture.service.sendMessage(request);
    expect(check.jobs).toHaveLength(1);
    expect(check.jobs[0]?.assignment.agentProfileId).toBe('builtin.skeptic');
    const peerPrompt = await fixture.runtimeStore.readArtifact(check.jobs[0]!.promptArtifactId!);
    expect(peerPrompt).toContain(answer.body);
    expect(peerPrompt).toContain('Do not invent criticism');
    await completeChatJob(fixture, conversationId, () => JSON.stringify({
      message: requestAuthorResponse ? 'A, separate worker counters do not impose a shared bound. How will you enforce it?' : 'I found no additional issue in the stated scope.',
      requestAuthorResponse
    }));
    // Restart between peer publication and author planning must not lose or duplicate the handoff.
    await fixture.service.recoverConversation(conversationId);
    await fixture.service.recoverConversation(conversationId);
    let aggregate = await fixture.discourseStore.getConversation(conversationId);
    const checkJobs = aggregate.jobs.filter((job) => job.waveId === check.wave!.id);
    expect(checkJobs).toHaveLength(requestAuthorResponse ? 2 : 1);
    if (requestAuthorResponse) {
      const author = checkJobs.find((job) => job.assignment.assignmentRole === 'PRIMARY')!;
      const peer = checkJobs.find((job) => job.assignment.assignmentRole === 'REVIEWER')!;
      expect(author.targetMessageIds).toContain(peer.result?.kind === 'CONTRIBUTION' ? peer.result.outputMessageId : 'missing');
      expect(await fixture.runtimeStore.readArtifact(author.promptArtifactId!)).toContain('separate worker counters');
      await completeChatJob(fixture, conversationId, () => 'I revise the claim: use one durable, atomically consumed attempt budget across workers. Delivery remains uncertain.');
      await fixture.service.advanceWave(conversationId, check.wave!.id, 'no-more-rounds');
    }
    aggregate = await fixture.discourseStore.getConversation(conversationId);
    expect(aggregate.waves.find((wave) => wave.id === check.wave!.id)?.outcome).toBe('COMPLETE');
    expect(aggregate.jobs.filter((job) => job.waveId === check.wave!.id)).toHaveLength(requestAuthorResponse ? 2 : 1);
    expect((await fixture.service.sendMessage(request)).wave?.id).toBe(check.wave?.id);
    const after = await fixture.discourseStore.listMessages({ conversationId, limit: 100 });
    expect(after.messages.find((message) => message.id === answer.id)?.body).toBe(answer.body);
    const peerMessage = after.messages.find((message) => message.jobId === check.jobs[0]?.id)!;
    expect(peerMessage.replyToMessageId).toBe(answer.id);
    expect(peerMessage.body).not.toContain('requestAuthorResponse');
    if (requestAuthorResponse) expect(after.messages.at(-1)?.replyToMessageId).toBe(peerMessage.id);
  });

  it('does not ask an author to respond after the selected context changes', async () => {
    const fixture = await serviceFixture('peer-stale-context');
    const initial = await startChat(fixture);
    const conversationId = initial.wave!.conversationId;
    await completeChatJob(fixture, conversationId, () => 'Initial answer.');
    const answer = (await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages.at(-1)!;
    const preview = await fixture.service.previewContext({ conversationId, messageContext: [] });
    const check = await fixture.service.sendMessage({ conversationId, body: 'Check this answer.', policy: 'CHAT',
      agents: selections('builtin.lead', 'builtin.skeptic'), replyToMessageId: answer.id, context: [],
      previewFingerprint: preview.fingerprint, clientMessageId: 'check-stale' });
    await completeChatJob(fixture, conversationId, () => JSON.stringify({ message: 'A, how is the bound enforced?', requestAuthorResponse: true }));
    vi.spyOn(fixture.snapshots, 'freshness').mockResolvedValue('CHANGED_DURING_JOB');
    await fixture.service.advanceWave(conversationId, check.wave!.id, 'changed-context');
    const aggregate = await fixture.discourseStore.getConversation(conversationId);
    expect(aggregate.waves.find((wave) => wave.id === check.wave!.id)?.outcome).toBe('STALE');
    expect(aggregate.jobs.filter((job) => job.waveId === check.wave!.id)).toHaveLength(1);
  });

  it.each(['invalid-output', 'stopped', 'model-unavailable'] as const)('preserves the peer result and does not dispatch an author after %s', async (failure) => {
    let catalog = runtimeCatalog();
    const fixture = await serviceFixture(`peer-${failure}`, () => catalog);
    const initial = await startChat(fixture);
    const conversationId = initial.wave!.conversationId;
    await completeChatJob(fixture, conversationId, () => 'A current answer.');
    const answer = (await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages.at(-1)!;
    const preview = await fixture.service.previewContext({ conversationId, messageContext: [] });
    const check = await fixture.service.sendMessage({ conversationId, body: 'Check this answer.', policy: 'CHAT',
      agents: selections('builtin.lead', 'builtin.skeptic'), replyToMessageId: answer.id, context: [],
      previewFingerprint: preview.fingerprint, clientMessageId: 'bounded-check' });
    const output = failure === 'invalid-output' ? '{"message":"A, check the shared bound."}'
      : JSON.stringify({ message: 'A, what enforces the shared bound?', requestAuthorResponse: true });
    await completeChatJob(fixture, conversationId, () => output, failure === 'invalid-output');
    if (failure === 'stopped') await fixture.service.stopWave({ conversationId, waveId: check.wave!.id,
      clientOperationId: 'stop-before-author', reason: 'Stopped by user.' });
    if (failure === 'model-unavailable') catalog = runtimeCatalog({ id: 'codex:replacement', model: 'replacement' });
    await fixture.service.recoverConversation(conversationId);
    await fixture.service.recoverConversation(conversationId);
    const aggregate = await fixture.discourseStore.getConversation(conversationId);
    const jobs = aggregate.jobs.filter((job) => job.waveId === check.wave!.id);
    const peer = jobs.find((job) => job.assignment.assignmentRole === 'REVIEWER')!;
    const author = jobs.find((job) => job.assignment.assignmentRole === 'PRIMARY');
    expect(author?.runId).toBeUndefined();
    expect(aggregate.waves.find((wave) => wave.id === check.wave!.id)?.status).toBe('SETTLED');
    if (failure === 'model-unavailable') {
      expect(author?.status).toBe('FAILED');
      expect(author?.error?.message).toContain('saved model');
    } else expect(author).toBeUndefined();
    if (failure === 'invalid-output') {
      expect(peer.status).toBe('FAILED');
      const run = await fixture.runtimeStore.getRun(peer.runId!);
      expect(await fixture.runtimeStore.readArtifact(run!.outputArtifactId!)).toBe(output);
    } else expect(peer.status).toBe('COMPLETED');
    expect((await fixture.runtimeStore.snapshot()).runs).toHaveLength(2);
    const messages = (await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages;
    expect(messages.find((message) => message.id === answer.id)?.body).toBe(answer.body);
    expect(messages.filter((message) => message.waveId === check.wave!.id && message.author.kind === 'AGENT')).toHaveLength(failure === 'invalid-output' ? 0 : 1);
  });

  it('rejects a peer check that would send the response to another author', async () => {
    const fixture = await serviceFixture('peer-wrong-author');
    const initial = await startChat(fixture);
    const conversationId = initial.wave!.conversationId;
    await completeChatJob(fixture, conversationId, () => 'A current answer.');
    const answer = (await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages.at(-1)!;
    const preview = await fixture.service.previewContext({ conversationId, messageContext: [] });
    await expect(fixture.service.sendMessage({ conversationId, body: 'Check it.', policy: 'CHAT',
      agents: selections('builtin.skeptic', 'builtin.lead'), context: [], replyToMessageId: answer.id,
      previewFingerprint: preview.fingerprint, clientMessageId: 'wrong-author' })).rejects.toThrow('author');
    expect((await fixture.discourseStore.listMessages({ conversationId, limit: 100 })).messages).toHaveLength(2);
  });

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
    const conversation = await fixture.service.createConversation({ title: 'Selected task', defaultPolicy: 'CHAT', agents: selections('builtin.lead'), clientOperationId: 'create-context' });
    const context = [{ entityKind: 'TASK' as const, entityId: task.id }];
    const preview = await fixture.service.previewContext({ conversationId: conversation.id, messageContext: context });
    const sent = await fixture.service.sendMessage({ conversationId: conversation.id, policy: 'CHAT', agents: selections('builtin.lead'), body: 'What support window applies?', context, clientMessageId: 'send-context', previewFingerprint: preview.fingerprint });
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
    const sent = await startChat(fixture);
    expect(sent.jobs.every((job) => job.status === 'FAILED' && job.delivery === 'NOT_SENT')).toBe(true);
    expect((await fixture.runtimeStore.snapshot()).runs).toEqual([]);
  });

  it('delivers an explicitly selected old message beyond the recent transcript page', async () => {
    const fixture = await serviceFixture('old-selected-message');
    const conversation = await fixture.service.createConversation({
      title: 'Selected history', defaultPolicy: 'CHAT', agents: selections('builtin.lead'), clientOperationId: 'create-history'
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
      conversationId: conversation.id, policy: 'CHAT', agents: selections('builtin.lead'), context: [],
      body: 'Use the selected support requirement.', sourceMessageIds: [original.message.id],
      clientMessageId: 'ask-old-source', previewFingerprint: preview.fingerprint
    });
    const prompt = await fixture.runtimeStore.readArtifact(sent.jobs[0]!.promptArtifactId!);
    expect(prompt).toContain('The rollback window is exactly forty-eight hours.');
    expect(prompt).toContain(original.message.id);
    expect(prompt).not.toContain('Unrelated history entry 0.');
  });

  it('persists an idempotent Chat send through frozen context and a queued scoped run', async () => {
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT' as const,
      agents: selections('builtin.lead'),
      previewFingerprint: preview.fingerprint
    };
    const sent = await service.sendMessage(request);
    const replay = await service.sendMessage(request);

    expect(replay).toEqual(sent);
    expect(sent).toMatchObject({
      message: { ordinal: 1, contextRevisionId: expect.any(String) },
      wave: { policy: 'CHAT', status: 'QUEUED' },
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
      defaultPolicy: 'CHAT' as const,
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
      defaultPolicy: 'CHAT' as const,
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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

  it('repairs an idempotent retry after the wave persisted before runtime preparation', async () => {
    const fixture = await serviceFixture('retry-repair');
    const conversation = await fixture.service.createConversation({
      title: 'Retry repair',
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
          policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
        policy: 'CHAT',
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
      policy: 'CHAT',
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

  it('settles blocked context without inventing a provider send transition', async () => {
    const fixture = await serviceFixture('blocked-context');
    const conversation = await fixture.service.createConversation({
      title: 'Blocked context',
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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
      defaultPolicy: 'CHAT',
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
      policy: 'CHAT',
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

async function startChat(fixture: Awaited<ReturnType<typeof serviceFixture>>) {
  const conversation = await fixture.service.createConversation({ title: 'Chat', defaultPolicy: 'CHAT',
    agents: selections('builtin.lead'), clientOperationId: 'create-chat' });
  const preview = await fixture.service.previewContext({ conversationId: conversation.id, messageContext: [] });
  return fixture.service.sendMessage({ conversationId: conversation.id, body: 'How should we bound email retries?',
    context: [], policy: 'CHAT', agents: selections('builtin.lead'),
    previewFingerprint: preview.fingerprint, clientMessageId: 'send-chat' });
}

async function completeChatJob(
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
