import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  GitSnapshotRecord,
  PreviewGenerationRecord,
  PreviewPlanRecord
} from '../../shared/contracts';
import { FileTaskStore, type ManagedDesignRepositoryInput } from './FileTaskStore';

const COMMIT = 'a'.repeat(40);
const EXECUTION_DIGEST = 'b'.repeat(64);

describe('FileTaskStore Design ownership', () => {
  it('creates an idempotent Codex-owned Design bundle and excludes it from boards', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-store-'));
    const store = new FileTaskStore(dir);
    const request = {
      brief:
        '  Create a calm dashboard for monitoring a small greenhouse with clear status.  ',
      creationToken: 'design-request-0001',
      model: '  gpt-5.5  ',
      reasoningEffort: ' high '
    };
    const repository = managedRepository(dir);

    const created = await store.createDesignBundle({ request, repository });
    const retry = await store.createDesignBundle({ request, repository });

    expect(retry).toEqual(created);
    expect(created.task).toMatchObject({
      kind: 'DESIGN',
      runtimeId: 'codex',
      prompt: request.brief.trim(),
      title: 'Create a calm dashboard for monitoring a small greenhouse…',
      workflowPhase: 'READY',
      completionPolicy: 'MANUAL',
      phaseVersion: 1,
      agentSettings: {
        runtimeId: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    expect(created.repository).toMatchObject({
      id: repository.id,
      kind: 'DESIGN_MANAGED',
      remotes: []
    });
    expect(created.turn).toMatchObject({
      designId: created.task.id,
      clientMessageId: request.creationToken,
      order: 1,
      messageSource: 'TASK_PROMPT',
      checkpoint: { boundary: 'QUEUED' }
    });
    expect((await store.getBoardSnapshot()).tasks).toEqual([]);
    expect((await store.getBoardSnapshot()).repositories).toEqual([]);
    await expect(store.listDesigns()).resolves.toEqual([
      expect.objectContaining({ id: created.task.id, status: 'STARTING' })
    ]);
    await expect(store.getDesignDetail(created.task.id)).resolves.toMatchObject({
      conversation: [
        expect.objectContaining({ userMessage: request.brief.trim() })
      ],
      canvas: { state: 'UPDATING' },
      actions: {
        canRefine: true,
        queuedTurnCount: 1,
        canStop: false,
        canRestart: false,
        canDelete: false,
        deleteDisabledReason: expect.stringContaining('settle')
      }
    });
    await expect(
      store.createDesignBundle({
        request: { ...request, brief: 'A different request' },
        repository
      })
    ).rejects.toThrow('already used for a different request');
    await store.close();
  });

  it('stores inline turns as an idempotent FIFO message queue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-message-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: { brief: 'Create the initial page.', creationToken: 'design-request-0002' },
      repository: managedRepository(dir)
    });
    await store.settleDesignTurn({
      designId: created.task.id,
      turnId: created.turn.id,
      outcome: 'CANCELED'
    });

    const input = {
      designId: created.task.id,
      clientMessageId: 'design-message-0001',
      message: 'Make the primary action easier to find.'
    };
    const turn = await store.createInlineDesignTurn(input);
    await expect(store.createInlineDesignTurn(input)).resolves.toEqual(turn);
    await expect(
      store.createInlineDesignTurn({ ...input, message: 'Different bytes' })
    ).rejects.toThrow('already used for different content');
    const queued = await store.createInlineDesignTurn({
      ...input,
      clientMessageId: 'design-message-0002',
      message: 'Use a warmer accent color.'
    });

    const detail = await store.getDesignDetail(created.task.id);
    expect(detail.conversation.at(-2)).toMatchObject({
      turn: { id: turn.id, messageSource: 'INLINE_MESSAGE', order: 2 },
      userMessage: input.message
    });
    expect(detail.conversation.at(-1)).toMatchObject({
      turn: { id: queued.id, messageSource: 'INLINE_MESSAGE', order: 3 },
      userMessage: 'Use a warmer accent color.'
    });
    expect(detail.actions).toMatchObject({
      canRefine: true,
      queuedTurnCount: 2,
      canStop: false
    });
    expect(
      (await store.snapshot()).artifacts.filter(
        (artifact) => artifact.kind === 'design-message'
      )
    ).toHaveLength(2);
    for (let index = 3; index <= 20; index += 1) {
      await store.createInlineDesignTurn({
        designId: created.task.id,
        clientMessageId: `design-message-${index.toString().padStart(4, '0')}`,
        message: `Queued change ${index}`
      });
    }
    await expect(
      store.createInlineDesignTurn({
        designId: created.task.id,
        clientMessageId: 'design-message-0021',
        message: 'This message exceeds the queue limit.'
      })
    ).rejects.toThrow('queue is full');
    await expect(store.getDesignDetail(created.task.id)).resolves.toMatchObject({
      actions: { canRefine: false, queuedTurnCount: 20 }
    });
    await store.close();
  });

  it('pages older conversation entries while retaining an old unsettled turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-paging-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: { brief: 'Create the initial page.', creationToken: 'design-paging-create' },
      repository: managedRepository(dir)
    });
    for (let index = 1; index <= 55; index += 1) {
      const turn = await store.createInlineDesignTurn({
        designId: created.task.id,
        clientMessageId: `design-paging-${index.toString().padStart(4, '0')}`,
        message: `Refinement ${index}`
      });
      await store.settleDesignTurn({
        designId: created.task.id,
        turnId: turn.id,
        outcome: 'CANCELED'
      });
    }

    const detail = await store.getDesignDetail(created.task.id);
    expect(detail.conversation).toHaveLength(51);
    expect(detail.conversation[0]?.turn).toMatchObject({ order: 1 });
    expect(detail.conversation[0]?.turn).not.toHaveProperty('outcome');
    expect(detail.conversation[1]?.turn.order).toBe(7);
    expect(detail.conversation.at(-1)?.turn.order).toBe(56);
    expect(detail.previousConversationCursor).toBeTypeOf('string');

    const earlier = await store.listDesignConversation({
      designId: created.task.id,
      beforeCursor: detail.previousConversationCursor
    });
    expect(earlier.entries.map((entry) => entry.turn.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(earlier.previousCursor).toBeUndefined();
    await expect(
      store.listDesignConversation({ designId: created.task.id, beforeCursor: 'invalid' })
    ).rejects.toThrow('cursor is invalid');
    await store.close();
  });

  it('rolls back the complete Design bundle when snapshot publication fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-create-rollback-'));
    const store = new FileTaskStore(dir);
    const draft = await store.createAttachmentDraft();
    const attachment = await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'reference.txt',
      bytes: Buffer.from('Reference bytes')
    });
    const repository = managedRepository(dir);
    const restoreFailure = injectNextSnapshotSyncFailure(
      dir,
      'injected Design creation persistence failure'
    );

    try {
      await expect(
        store.createDesignBundle({
          request: {
            brief: 'Create a page from the supplied reference.',
            creationToken: 'design-request-create-rollback',
            attachmentDraftId: draft.id
          },
          repository
        })
      ).rejects.toThrow('Design creation persistence failure');
    } finally {
      restoreFailure();
    }

    const snapshot = await store.snapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.designTurns).toEqual([]);
    expect(snapshot.designReferences).toEqual([]);
    expect(snapshot.attachments).toEqual([]);
    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ id: attachment.id })]
    });
    await store.close();
  });

  it('rolls back an inline turn and its artifact when snapshot publication fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-turn-rollback-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: {
        brief: 'Create the initial page.',
        creationToken: 'design-request-turn-rollback'
      },
      repository: managedRepository(dir)
    });
    await store.settleDesignTurn({
      designId: created.task.id,
      turnId: created.turn.id,
      outcome: 'CANCELED'
    });
    const restoreFailure = injectNextSnapshotSyncFailure(
      dir,
      'injected Design turn persistence failure'
    );

    try {
      await expect(
        store.createInlineDesignTurn({
          designId: created.task.id,
          clientMessageId: 'design-message-turn-rollback',
          message: 'Add a more prominent primary action.'
        })
      ).rejects.toThrow('Design turn persistence failure');
    } finally {
      restoreFailure();
    }

    const snapshot = await store.snapshot();
    expect(snapshot.designTurns).toEqual([
      expect.objectContaining({ id: created.turn.id, outcome: 'CANCELED' })
    ]);
    expect(snapshot.artifacts.filter((artifact) => artifact.kind === 'design-message')).toEqual(
      []
    );
    await store.close();
  });

  it('rejects a persisted Design that weakens its restricted execution settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-policy-'));
    const storePath = path.join(dir, 'store.json');
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: { brief: 'Create a safe page.', creationToken: 'design-request-0004' },
      repository: managedRepository(dir)
    });
    await store.close();

    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ id: string; agentSettings: { approvalPolicy?: string } }>;
    };
    persisted.tasks.find((task) => task.id === created.task.id)!.agentSettings.approvalPolicy =
      'on-request';
    await fs.writeFile(storePath, `${JSON.stringify(persisted)}\n`, 'utf8');

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'Design task ownership is inconsistent'
    );
  });

  it('rejects a persisted Design with a broken seeded-turn lineage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-lineage-'));
    const storePath = path.join(dir, 'store.json');
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: { brief: 'Create a safe page.', creationToken: 'design-request-lineage' },
      repository: managedRepository(dir)
    });
    await store.close();

    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      designTurns: Array<{
        id: string;
        clientMessageId: string;
        order: number;
        messageSource: 'TASK_PROMPT' | 'INLINE_MESSAGE';
        outcome?: string;
        settledAt?: string;
        checkpoint?: unknown;
      }>;
    };
    const initial = persisted.designTurns.find((turn) => turn.id === created.turn.id)!;
    persisted.designTurns.push({
      ...initial,
      id: randomUUID(),
      clientMessageId: 'design-request-extra-task-prompt',
      order: 2,
      outcome: 'CANCELED',
      settledAt: new Date().toISOString(),
      checkpoint: undefined
    });
    await fs.writeFile(storePath, `${JSON.stringify(persisted)}\n`, 'utf8');

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'Design turn lineage is inconsistent'
    );
  });

  it.each(['session', 'run'] as const)(
    'rejects a persisted Design whose %s weakens restricted execution settings',
    async (owner) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-design-${owner}-policy-`));
      const storePath = path.join(dir, 'store.json');
      const store = new FileTaskStore(dir);
      const created = await store.createDesignBundle({
        request: {
          brief: 'Create a restricted page.',
          creationToken: `design-request-${owner}-policy`
        },
        repository: managedRepository(dir)
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task: created.task,
        branchName: `task-monki/design-${owner}-policy`,
        worktreePath: path.join(dir, 'worktree'),
        baseSha: COMMIT
      });
      const session = await store.createAgentSession({
        task: created.task,
        iteration,
        worktree,
        runtimeId: 'codex',
        requestedSettings: created.task.agentSettings
      });
      const run = await store.createRun({
        task: created.task,
        session,
        mode: 'DESIGN',
        generationKey: created.turn.id,
        prompt: created.task.prompt,
        requestedSettings: created.task.agentSettings
      });
      await store.linkDesignTurnRun({
        designId: created.task.id,
        turnId: created.turn.id,
        runId: run.id
      });
      await store.close();

      const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
        agentSessions: Array<{
          id: string;
          requestedSettings: { networkAccess?: boolean };
        }>;
        runs: Array<{
          id: string;
          requestedSettings: { networkAccess?: boolean };
        }>;
      };
      const record =
        owner === 'session'
          ? persisted.agentSessions.find((candidate) => candidate.id === session.id)
          : persisted.runs.find((candidate) => candidate.id === run.id);
      record!.requestedSettings.networkAccess = true;
      await fs.writeFile(storePath, `${JSON.stringify(persisted)}\n`, 'utf8');

      await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
        owner === 'session'
          ? 'Design session execution policy is inconsistent'
          : 'Design Run execution policy is inconsistent'
      );
    }
  );

  it('keeps DESIGN runs out of task phases and atomically settles Preview plus revision', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-cutover-'));
    let store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: { brief: 'Build a compact launch page.', creationToken: 'design-request-0003' },
      repository: managedRepository(dir)
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: created.task,
      branchName: 'task-monki/design-cutover',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: COMMIT
    });
    const session = await store.createAgentSession({
      task: created.task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: created.task.agentSettings
    });
    const beforeRun = await store.getTask(created.task.id);
    const run = await store.createRun({
      task: created.task,
      session,
      mode: 'DESIGN',
      generationKey: created.turn.id,
      prompt: created.task.prompt
    });
    const afterRun = await store.getTask(created.task.id);
    expect(afterRun).toMatchObject({
      workflowPhase: beforeRun!.workflowPhase,
      phaseVersion: beforeRun!.phaseVersion,
      currentRunId: run.id
    });
    await expect(
      store.createRun({
        task: created.task,
        session,
        mode: 'DESIGN',
        generationKey: created.turn.id,
        prompt: created.task.prompt
      })
    ).rejects.toThrow('already exists');
    await store.linkDesignTurnRun({
      designId: created.task.id,
      turnId: created.turn.id,
      runId: run.id
    });
    await store.updateRun(run.id, {
      status: 'COMPLETED',
      finalMessage: 'The launch page is ready.',
      endedAt: new Date().toISOString()
    });
    const evidence = await recordDesignGitSnapshot(store, {
      taskId: created.task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath,
      repositoryPath: created.repository.path,
      branchName: worktree.branchName
    });
    await store.updateRun(run.id, { afterGitSnapshotId: evidence.id });
    await store.updateDesignTurnCheckpoint({
      designId: created.task.id,
      turnId: created.turn.id,
      checkpoint: {
        boundary: 'POST_RUN_EVIDENCE_RECORDED',
        gitSnapshotId: evidence.id
      }
    });

    const plan = await store.savePreviewPlan(managedPlan({
      taskId: created.task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id
    }));
    const firstCandidate = await store.savePreviewGeneration(
      managedCandidate({
        taskId: created.task.id,
        repositoryId: created.repository.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        planId: plan.id
      })
    );
    await store.updateDesignTurnCheckpoint({
      designId: created.task.id,
      turnId: created.turn.id,
      checkpoint: {
        boundary: 'PREVIEW_CANDIDATE_READY',
        previewGenerationId: firstCandidate.id,
        commitSha: COMMIT
      }
    });

    const liveReplacement = await store.savePreviewGeneration(
      managedCandidate({
        taskId: created.task.id,
        repositoryId: created.repository.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        planId: plan.id
      })
    );
    await expect(
      store.updateDesignTurnCheckpoint({
        designId: created.task.id,
        turnId: created.turn.id,
        checkpoint: {
          boundary: 'PREVIEW_CANDIDATE_READY',
          previewGenerationId: liveReplacement.id,
          commitSha: COMMIT
        }
      })
    ).rejects.toThrow('Invalid Design turn checkpoint transition');
    await store.savePreviewGeneration({ ...firstCandidate, state: 'STOPPED' });
    await store.close();
    store = new FileTaskStore(dir);
    await expect(
      store.updateDesignTurnCheckpoint({
        designId: created.task.id,
        turnId: created.turn.id,
        checkpoint: {
          boundary: 'PREVIEW_CANDIDATE_READY',
          previewGenerationId: liveReplacement.id,
          commitSha: COMMIT
        }
      })
    ).resolves.toMatchObject({
      checkpoint: { previewGenerationId: liveReplacement.id, commitSha: COMMIT }
    });

    const ready = {
      ...liveReplacement,
      routingState: 'ACTIVE' as const,
      cutoverAt: new Date().toISOString()
    };
    const settlement = {
      designId: created.task.id,
      turnId: created.turn.id,
      runId: run.id,
      commitSha: COMMIT,
      routeId: 'main'
    };
    const originalOpen = fs.open.bind(fs);
    const temporaryPathPrefix = `${path.join(dir, 'store.json')}.`;
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        !injected &&
        String(args[0]).startsWith(temporaryPathPrefix) &&
        String(args[0]).endsWith('.tmp')
      ) {
        injected = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('injected Design settlement persistence failure')
        );
      }
      return handle;
    });
    try {
      await expect(
        store.cutoverPreviewGenerations({ candidate: ready, designSettlement: settlement })
      ).rejects.toThrow('settlement persistence failure');
    } finally {
      open.mockRestore();
    }
    const rolledBack = await store.getDesignDetail(created.task.id);
    expect(rolledBack.revisions).toEqual([]);
    expect(rolledBack.turns[0]).toMatchObject({
      checkpoint: { previewGenerationId: liveReplacement.id }
    });
    expect(rolledBack.turns[0]).not.toHaveProperty('outcome');
    const rolledBackCandidate = await store.getPreviewGeneration(liveReplacement.id);
    expect(rolledBackCandidate).toMatchObject({ routingState: 'CANDIDATE' });
    expect(rolledBackCandidate?.source).not.toHaveProperty('designRevisionId');

    const settled = await store.cutoverPreviewGenerations({
      candidate: ready,
      designSettlement: settlement
    });
    expect(settled.revision).toMatchObject({
      designId: created.task.id,
      ordinal: 1,
      commitSha: COMMIT,
      turnId: created.turn.id,
      runId: run.id,
      routeId: 'main'
    });
    expect(settled.candidate).toMatchObject({
      freshness: 'REVISION',
      routingState: 'ACTIVE',
      source: { designRevisionId: settled.revision!.id }
    });
    const detail = await store.getDesignDetail(created.task.id);
    expect(detail).toMatchObject({
      design: { status: 'READY', latestRevision: { id: settled.revision!.id } },
      conversation: [
        expect.objectContaining({
          assistantMessage: 'The launch page is ready.',
          runStatus: 'COMPLETED'
        })
      ],
      canvas: {
        state: 'READY',
        target: { generationId: liveReplacement.id, routeId: 'main' }
      },
      actions: {
        canRefine: true,
        canRestart: false,
        canDelete: true
      }
    });

    for (let index = 0; index < 105; index += 1) {
      await store.upsertAgentItem({
        taskId: created.task.id,
        iterationId: iteration.id,
        runId: run.id,
        sessionId: session.id,
        providerItemId: `design-activity-${index.toString().padStart(3, '0')}`,
        type: 'AGENT_MESSAGE',
        status: 'COMPLETED',
        payload: { text: `Activity ${index}` }
      });
    }
    const boundedActivity = await store.getDesignDetail(created.task.id);
    expect(boundedActivity.items).toHaveLength(100);
    expect(boundedActivity.items[0]?.providerItemId).toBe('design-activity-005');
    expect(boundedActivity.items.at(-1)?.providerItemId).toBe('design-activity-104');

    const stoppedTurn = await store.createInlineDesignTurn({
      designId: created.task.id,
      clientMessageId: 'design-stop-after-ready',
      message: 'Try a different direction.'
    });
    await store.settleDesignTurn({
      designId: created.task.id,
      turnId: stoppedTurn.id,
      outcome: 'CANCELED'
    });
    await expect(store.getDesignDetail(created.task.id)).resolves.toMatchObject({
      design: { status: 'READY' },
      canvas: { state: 'READY' }
    });

    await store.close();
    const restarted = new FileTaskStore(dir);
    await expect(restarted.getDesignDetail(created.task.id)).resolves.toMatchObject({
      revisions: [expect.objectContaining({ id: settled.revision!.id })]
    });
    await restarted.savePreviewGeneration({ ...settled.candidate, state: 'STOPPED' });
    const removable = await restarted.getDesignDetail(created.task.id);
    expect(removable.design.status).toBe('NEEDS_ATTENTION');
    expect(removable.canvas.state).toBe('RESTART_REQUIRED');
    expect(removable.actions.canDelete).toBe(true);
    await expect(
      restarted.deleteTaskAndReleaseManagedRepository(created.task.id)
    ).resolves.toEqual({ removedManagedRepository: created.repository });
    expect((await restarted.snapshot()).tasks).toEqual([]);
    expect((await restarted.snapshot()).repositories).toEqual([]);
    await restarted.close();
  }, 30_000);
});

function managedRepository(dir: string): ManagedDesignRepositoryInput {
  const id = randomUUID();
  return {
    id,
    name: `Design ${id.slice(0, 8)}`,
    path: path.join(dir, 'managed-repositories', id),
    headSha: COMMIT,
    branch: 'main',
    checkedAt: new Date().toISOString()
  };
}

function managedPlan(input: {
  taskId: string;
  iterationId: string;
  worktreeId: string;
}): PreviewPlanRecord {
  return {
    id: randomUUID(),
    ...input,
    planSource: { type: 'MANAGED_DESIGN_STATIC', adapterVersion: 1 },
    executionDigest: EXECUTION_DIGEST,
    executionPlan: {
      version: 1,
      jobs: [],
      resources: [],
      services: [],
      workers: [],
      routes: [],
      scenarios: [{ id: 'default', jobs: [], resources: [] }],
      selectedScenarioId: 'default'
    },
    warnings: [],
    createdAt: new Date().toISOString()
  };
}

function managedCandidate(input: {
  taskId: string;
  repositoryId: string;
  iterationId: string;
  worktreeId: string;
  planId: string;
}): PreviewGenerationRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    previewKey: `design-${input.taskId}`,
    taskId: input.taskId,
    iterationId: input.iterationId,
    worktreeId: input.worktreeId,
    planId: input.planId,
    executionAuthority: {
      type: 'MANAGED_STATIC',
      adapterVersion: 1,
      executionDigest: EXECUTION_DIGEST
    },
    source: {
      type: 'EXACT_COMMIT',
      repositoryId: input.repositoryId,
      commitSha: COMMIT
    },
    workspacePath: path.join('/tmp', randomUUID()),
    state: 'READY',
    routingState: 'CANDIDATE',
    freshness: 'CURRENT',
    routes: [
      {
        id: 'main',
        hostname: 'design.localhost',
        url: 'http://design.localhost:41000/',
        gatewayPort: 41000,
        targetHost: '127.0.0.1',
        targetPort: 41001,
        state: 'ATTACHED'
      }
    ],
    createdAt: now,
    updatedAt: now,
    readyAt: now
  };
}

async function recordDesignGitSnapshot(
  store: FileTaskStore,
  input: {
    taskId: string;
    iterationId: string;
    worktreeId: string;
    worktreePath: string;
    repositoryPath: string;
    branchName: string;
  }
): Promise<GitSnapshotRecord> {
  return store.recordGitSnapshot(
    {
      taskId: input.taskId,
      iterationId: input.iterationId,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      repoRoot: input.repositoryPath,
      gitCommonDir: path.join(input.repositoryPath, '.git'),
      headSha: COMMIT,
      branch: input.branchName,
      baseSha: COMMIT,
      aheadCount: 0,
      behindCount: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      commitsAheadOfBase: 0,
      committedDiffFileCount: 0,
      workingDiffFileCount: 0,
      diffStat: '',
      dirtyFingerprint: 'clean',
      status: 'CLEAN'
    },
    ''
  );
}

function injectNextSnapshotSyncFailure(dir: string, message: string): () => void {
  const originalOpen = fs.open.bind(fs);
  const temporaryPathPrefix = `${path.join(dir, 'store.json')}.`;
  let injected = false;
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (
      !injected &&
      String(args[0]).startsWith(temporaryPathPrefix) &&
      String(args[0]).endsWith('.tmp')
    ) {
      injected = true;
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error(message));
    }
    return handle;
  });
  return () => open.mockRestore();
}
