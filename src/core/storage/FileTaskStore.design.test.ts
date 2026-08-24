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
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-create-reference-client-0001',
      displayName: 'direction.md',
      bytes: Buffer.from('# Keep the layout calm.')
    });
    await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-create-reference-client-0002',
      displayName: 'content.txt',
      bytes: Buffer.from('Primary action: Open dashboard')
    });
    const request = {
      brief:
        '  Create a calm dashboard for monitoring a small greenhouse with clear status.  ',
      creationToken: 'design-request-0001',
      model: '  gpt-5.5  ',
      reasoningEffort: ' high ',
      attachmentDraftId: draft.id
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
    expect(created.references).toHaveLength(2);
    expect(created.turn.referenceIds).toEqual(created.references.map(({ id }) => id));
    await expect(
      store.getTurnAttachments({
        taskId: created.task.id,
        mode: 'DESIGN',
        generationKey: created.turn.id
      })
    ).resolves.toEqual([
      expect.objectContaining({ displayName: 'direction.md' }),
      expect.objectContaining({ displayName: 'content.txt' })
    ]);
    expect((await store.getBoardSnapshot()).tasks).toEqual([]);
    expect((await store.getBoardSnapshot()).repositories).toEqual([]);
    await expect(store.listDesigns()).resolves.toEqual([
      expect.objectContaining({ id: created.task.id, status: 'STARTING' })
    ]);
    const detail = await store.getDesignDetail(created.task.id);
    expect(detail.references).toEqual([
      expect.objectContaining({ id: created.references[0]?.id, state: 'ACTIVE' }),
      expect.objectContaining({ id: created.references[1]?.id, state: 'ACTIVE' })
    ]);
    expect(detail.attachments).toEqual([
      expect.objectContaining({ displayName: 'direction.md' }),
      expect.objectContaining({ displayName: 'content.txt' })
    ]);
    expect(detail).toMatchObject({
      conversation: [
        expect.objectContaining({
          userMessage: request.brief.trim(),
          turn: expect.objectContaining({ referenceIds: created.turn.referenceIds })
        })
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
      message: 'Make the primary action easier to find.',
      referenceIds: []
    };
    const turn = await store.createInlineDesignTurn(input);
    await expect(store.createInlineDesignTurn(input)).resolves.toEqual(turn);
    await expect(
      store.createInlineDesignTurn({ ...input, message: 'Different bytes' })
    ).rejects.toThrow('already used for different content');
    const queued = await store.createInlineDesignTurn({
      ...input,
      clientMessageId: 'design-message-0002',
      message: 'Use a warmer accent color.',
      referenceIds: []
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
        message: `Queued change ${index}`,
        referenceIds: []
      });
    }
    await expect(
      store.createInlineDesignTurn({
        designId: created.task.id,
        clientMessageId: 'design-message-0021',
        message: 'This message exceeds the queue limit.',
        referenceIds: []
      })
    ).rejects.toThrow('queue is full');
    await expect(store.getDesignDetail(created.task.id)).resolves.toMatchObject({
      actions: { canRefine: false, queuedTurnCount: 20 }
    });
    await store.close();
  });

  it('adopts post-create references, records exact turn selection, and keeps inactive history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-references-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: {
        brief: 'Create the initial page.',
        creationToken: 'design-reference-create'
      },
      repository: managedRepository(dir)
    });
    await store.settleDesignTurn({
      designId: created.task.id,
      turnId: created.turn.id,
      outcome: 'CANCELED'
    });
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-reference-client-0001',
      displayName: 'mood.png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    });
    await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-reference-client-0002',
      displayName: 'content.txt',
      bytes: Buffer.from('Use a concise heading.')
    });

    const references = await store.addDesignReferences({
      designId: created.task.id,
      attachmentDraftId: draft.id
    });
    await expect(
      store.addDesignReferences({
        designId: created.task.id,
        attachmentDraftId: draft.id
      })
    ).resolves.toEqual(references);
    const selected = references[1]!;
    const unselected = references[0]!;
    const turn = await store.createInlineDesignTurn({
      designId: created.task.id,
      clientMessageId: 'design-reference-turn-0001',
      message: 'Use only the selected content reference.',
      referenceIds: [selected.id]
    });

    await expect(
      store.getTurnAttachments({
        taskId: created.task.id,
        mode: 'DESIGN',
        generationKey: turn.id
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: selected.attachmentId,
        displayName: 'content.txt'
      })
    ]);
    const storedContent = await store.readDesignReferenceContent(
      created.task.id,
      selected.id
    );
    expect(Buffer.from(storedContent.content.bytes).toString('utf8')).toBe(
      'Use a concise heading.'
    );
    await expect(
      store.recordDesignReferenceAsset({
        designId: created.task.id,
        referenceId: selected.id,
        projectAssetPath: 'assets/content.txt'
      })
    ).resolves.toMatchObject({
      role: 'PROJECT_ASSET_SOURCE',
      projectAssetPath: 'assets/content.txt'
    });

    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: created.task,
      branchName: 'task-monki/design-references',
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
      generationKey: turn.id,
      prompt: 'Use only the selected content reference.'
    });
    await expect(store.prepareRunAttachments(run.id, created.task.id)).resolves.toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          id: selected.attachmentId,
          ordinal: 1,
          displayName: 'content.txt'
        })
      })
    ]);
    await store.linkDesignTurnRun({
      designId: created.task.id,
      turnId: turn.id,
      runId: run.id
    });
    const attachment = (await store.getTurnAttachments({
      taskId: created.task.id,
      mode: 'DESIGN',
      generationKey: turn.id
    }))[0]!;
    const submittedAt = new Date().toISOString();
    await store.updateRun(run.id, {
      providerTurnId: 'provider-design-reference-turn',
      attachmentSubmissions: [{
        attachmentId: attachment.id,
        ordinal: attachment.ordinal,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        byteCount: attachment.byteCount,
        sha256: attachment.sha256,
        submittedAs: 'prompt-file-reference',
        verifiedAt: submittedAt,
        providerTurnId: 'provider-design-reference-turn',
        submittedAt
      }]
    });
    expect(
      (await store.getDesignDetail(created.task.id)).references.find(
        (reference) => reference.id === selected.id
      )
    ).toMatchObject({ firstDeliveredAt: submittedAt });

    await store.removeDesignReference({
      designId: created.task.id,
      referenceId: selected.id
    });
    await expect(
      store.createInlineDesignTurn({
        designId: created.task.id,
        clientMessageId: 'design-reference-turn-0002',
        message: 'Try to reuse an inactive reference.',
        referenceIds: [selected.id]
      })
    ).rejects.toThrow('not active');
    const detail = await store.getDesignDetail(created.task.id);
    expect(detail.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: selected.id, state: 'INACTIVE' }),
        expect.objectContaining({ id: unselected.id, state: 'ACTIVE' })
      ])
    );
    expect(detail.attachments).toHaveLength(2);
    expect(detail.turns.find((candidate) => candidate.id === turn.id)?.referenceIds).toEqual([
      selected.id
    ]);
    await store.close();
  });

  it('adopts message files once and records exact references for consecutive queued turns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-turn-files-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: {
        brief: 'Create the initial page.',
        creationToken: 'design-turn-files-create'
      },
      repository: managedRepository(dir)
    });
    const reusableDraft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: reusableDraft.id,
      clientToken: 'design-turn-existing-reference',
      displayName: 'existing.md',
      bytes: Buffer.from('Existing direction')
    });
    const [existingReference] = await store.addDesignReferences({
      designId: created.task.id,
      attachmentDraftId: reusableDraft.id
    });
    const messageDraft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: messageDraft.id,
      clientToken: 'design-turn-new-reference',
      displayName: 'new-direction.txt',
      bytes: Buffer.from('New direction')
    });
    const firstInput = {
      designId: created.task.id,
      clientMessageId: 'design-turn-files-first',
      message: 'Use the two selected directions.',
      referenceIds: [existingReference!.id],
      attachmentDraftId: messageDraft.id
    };

    const first = await store.createInlineDesignTurn(firstInput);
    const retry = await store.createInlineDesignTurn(firstInput);
    const firstDetail = await store.getDesignDetail(created.task.id);
    const newReference = firstDetail.references.find(
      (reference) => reference.sourceDraftId === messageDraft.id
    );
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ attachmentDraftId: messageDraft.id });
    expect(first.referenceIds).toEqual([existingReference!.id, newReference!.id]);
    await expect(
      store.getTurnAttachments({
        taskId: created.task.id,
        mode: 'DESIGN',
        generationKey: first.id
      })
    ).resolves.toEqual([
      expect.objectContaining({ displayName: 'existing.md' }),
      expect.objectContaining({ displayName: 'new-direction.txt' })
    ]);
    await expect(store.listAttachmentDraft(messageDraft.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_DRAFT_NOT_FOUND'
    });

    const second = await store.createInlineDesignTurn({
      designId: created.task.id,
      clientMessageId: 'design-turn-files-second',
      message: 'Use only the newly added direction.',
      referenceIds: [newReference!.id]
    });
    const third = await store.createInlineDesignTurn({
      designId: created.task.id,
      clientMessageId: 'design-turn-files-third',
      message: 'Do not use a reference for this message.',
      referenceIds: []
    });

    expect(second.referenceIds).toEqual([newReference!.id]);
    expect(third.referenceIds).toEqual([]);
    await expect(
      store.getTurnAttachments({
        taskId: created.task.id,
        mode: 'DESIGN',
        generationKey: third.id
      })
    ).resolves.toEqual([]);
    expect((await store.getDesignDetail(created.task.id)).actions.queuedTurnCount).toBe(4);
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
        message: `Refinement ${index}`,
        referenceIds: []
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

  it('publishes a post-create attachment and reference together or publishes neither', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-reference-rollback-'));
    const store = new FileTaskStore(dir);
    const created = await store.createDesignBundle({
      request: {
        brief: 'Create a page.',
        creationToken: 'design-reference-rollback-create'
      },
      repository: managedRepository(dir)
    });
    const draft = await store.createAttachmentDraft();
    const staged = await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-reference-rollback-client',
      displayName: 'reference.txt',
      bytes: Buffer.from('Reference bytes')
    });
    const restoreFailure = injectNextSnapshotSyncFailure(
      dir,
      'injected Design reference persistence failure'
    );

    try {
      await expect(
        store.addDesignReferences({
          designId: created.task.id,
          attachmentDraftId: draft.id
        })
      ).rejects.toThrow('Design reference persistence failure');
    } finally {
      restoreFailure();
    }

    const detail = await store.getDesignDetail(created.task.id);
    expect(detail.references).toEqual([]);
    expect(detail.attachments).toEqual([]);
    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ id: staged.id })]
    });
    await expect(
      fs.access(path.join(dir, 'attachments', 'tasks', created.task.id))
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
    const draft = await store.createAttachmentDraft();
    const staged = await store.stageTaskAttachment({
      draftId: draft.id,
      clientToken: 'design-turn-rollback-reference',
      displayName: 'rollback-reference.txt',
      bytes: Buffer.from('Keep this staged after failure.')
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
          message: 'Add a more prominent primary action.',
          referenceIds: [],
          attachmentDraftId: draft.id
        })
      ).rejects.toThrow('Design turn persistence failure');
    } finally {
      restoreFailure();
    }

    const snapshot = await store.snapshot();
    expect(snapshot.designTurns).toEqual([
      expect.objectContaining({ id: created.turn.id, outcome: 'CANCELED' })
    ]);
    expect(snapshot.designReferences).toEqual([]);
    expect(snapshot.attachments).toEqual([]);
    expect(snapshot.artifacts.filter((artifact) => artifact.kind === 'design-message')).toEqual(
      []
    );
    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ id: staged.id })]
    });
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
      message: 'Try a different direction.',
      referenceIds: []
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
