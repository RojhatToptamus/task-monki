import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import type {
  AgentScopedRuntimeBinding,
  StartScopedAgentTurnInput
} from '../agent/AgentScopedTurnProvider';
import { AppEventBus } from '../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../storage/FileDiscourseStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';
import type {
  BuiltInAgentProfileId,
  DiscourseAgentSelectionInput
} from '../../shared/discourse';

function selections(
  ...agentProfileIds: BuiltInAgentProfileId[]
): DiscourseAgentSelectionInput[] {
  return agentProfileIds.map((agentProfileId) => ({ agentProfileId }));
}

describe('TaskManagerService discourse runtime composition', () => {
  it('requires the runtime and discourse stores as one capability boundary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-composition-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));

    expect(
      () =>
        new TaskManagerService(taskStore, root, undefined, {
          agentRuntimeStore: new FileAgentRuntimeStore(path.join(root, 'runtime'))
        })
    ).toThrow('must be configured together');
  });

  it('recovers a clean shutdown latch on startup and latches before closing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lifecycle-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));
    const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
    const discourseStore = new FileDiscourseStore(path.join(root, 'discourse'));
    await runtimeStore.init();
    await runtimeStore.setShutdownLatched(true, 'previous-process-shutdown');

    const service = new TaskManagerService(taskStore, root, undefined, {
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(taskStore)],
      agentRuntimeStore: runtimeStore,
      discourseStore
    });

    await service.init();
    expect((await runtimeStore.snapshot()).shutdownLatched).toBe(false);

    await service.shutdown();
    expect((await runtimeStore.snapshot()).shutdownLatched).toBe(true);
  });

  it('dispatches every Panel job without racing the shared wave revision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-panel-dispatch-'));
    const taskStore = new FileTaskStore(path.join(root, 'tasks'));
    const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
    const discourseStore = new FileDiscourseStore(path.join(root, 'discourse'));
    const started: StartScopedAgentTurnInput[] = [];
    const binding: AgentScopedRuntimeBinding = {
      runtimeId: 'codex',
      buildExecutionContext: async (input) => ({
        attestation: { status: 'ATTESTED' },
        primaryCwd: input.primaryCwd,
        readRoots: input.readRoots,
        managedAttachments: [],
        permissionProfileHash: 'a'.repeat(64),
        modelSettings: { ...input.modelSettings, runtimeId: 'codex' },
        externalTools: {
          network: false,
          webSearch: 'disabled',
          mcpServers: false,
          apps: false,
          dynamicTools: false
        },
        clientOperationId: input.clientOperationId
      }),
      provider: {
        startScopedTurn: async (input) => {
          started.push(input);
          return {
            serverInstanceId: 'server-panel',
            providerSessionId: `thread-${started.length}`,
            providerTurnId: `turn-${started.length}`,
            startedAt: '2026-07-20T00:00:00.000Z'
          };
        }
      }
    };
    const runtimeAdapter = new ScriptedAgentRuntimeAdapter(taskStore);
    Object.assign(runtimeAdapter, {
      forkSession: async () => {
        throw new Error('Panel dispatch does not fork task sessions.');
      },
      syncGoal: async () => {
        throw new Error('Panel dispatch does not synchronize task goals.');
      },
      refinePrompt: async () => {
        throw new Error('Panel dispatch does not refine task prompts.');
      }
    });
    const service = new TaskManagerService(taskStore, root, new AppEventBus(), {
      agentRuntimeAdapters: [runtimeAdapter],
      agentRuntimeStore: runtimeStore,
      discourseStore,
      discourseWorkspaceRoot: path.join(root, 'discourse-workspaces'),
      agentScopedRuntimeBindings: [binding]
    });
    await service.init();
    const conversation = await service.createDiscourseConversation({
      title: 'Panel dispatch',
      defaultPolicy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
      clientOperationId: 'create-panel'
    });
    const preview = await service.previewDiscourseContext({
      conversationId: conversation.id,
      messageContext: []
    });
    await service.sendDiscourseMessage({
      conversationId: conversation.id,
      body: 'Compare the two persistence designs independently.',
      context: [],
      clientMessageId: 'panel-message',
      policy: 'PANEL',
      agents: selections('builtin.lead', 'builtin.skeptic'),
      previewFingerprint: preview.fingerprint
    });

    await waitFor(() => started.length === 2);
    expect(started.map((input) => input.run.scope)).toEqual([
      expect.objectContaining({ kind: 'DISCOURSE', conversationId: conversation.id }),
      expect.objectContaining({ kind: 'DISCOURSE', conversationId: conversation.id })
    ]);
    await waitFor(async () =>
      (await runtimeStore.snapshot()).runs.every((run) => run.status === 'RUNNING')
    );
    expect((await runtimeStore.snapshot()).runs.map((run) => run.status)).toEqual([
      'RUNNING',
      'RUNNING'
    ]);
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous dispatch.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
