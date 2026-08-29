import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionSettings, AgentModel } from '../../shared/agent';
import type { AgentTurnAttachment } from '../agent/AgentAttachmentDelivery';
import {
  imageAttachmentLooksRelevant,
  type PromptRefinementRun,
  PromptRefinementCanceledError,
  PromptRefinementService,
  PromptRefinementTerminationUnconfirmedError
} from './PromptRefinementService';

describe('PromptRefinementService', () => {
  it('selects image inspection from task relevance instead of attachment presence alone', () => {
    expect(
      imageAttachmentLooksRelevant('Fix the database connection timeout.', 'unrelated.png')
    ).toBe(false);
    expect(imageAttachmentLooksRelevant('Fix this.', 'reference.png')).toBe(true);
    expect(
      imageAttachmentLooksRelevant('Match the attached UI screenshot.', 'reference.png')
    ).toBe(true);
  });

  it('accepts a concise rewrite without forcing repository inspection or headings', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    let capturedInstruction = '';
    const service = new PromptRefinementService(async ({ instruction }) => {
      capturedInstruction = instruction;
      return completedRun(refinementJson({
        titleSuggestion: 'Use the brand blue',
        prompt: 'Change the primary button color to the existing brand blue.',
        repositoryInspection: 'none'
      }));
    });

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'make the primary button use our brand blue'
    }));

    expect(refined).toMatchObject({
      source: 'model',
      prompt: 'Change the primary button color to the existing brand blue.',
      evidence: {
        repositoryInspection: 'none',
        repositoryFilesInspected: []
      }
    });
    expect(refined.prompt).not.toContain('##');
    expect(capturedInstruction).toContain('A clear, simple task may require no repository inspection');
    expect(capturedInstruction).toContain('Keep simple tasks simple');
    expect(capturedInstruction).toContain('Preserve every explicit requirement');
  });

  it('accepts only repository facts backed by inspected files', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    await fs.mkdir(path.join(repositoryPath, 'src'));
    await fs.writeFile(path.join(repositoryPath, 'src', 'StatusBadge.tsx'), 'export {}\n');
    const service = new PromptRefinementService(async () =>
      completedRun(refinementJson({
        titleSuggestion: 'Add GitHub sync badges',
        prompt: 'Update `src/StatusBadge.tsx` to render the persisted GitHub sync state.',
        repositoryInspection: 'focused',
        repositoryFilesInspected: ['src/StatusBadge.tsx']
      }))
    );

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'add github sync badges'
    }));

    expect(refined.source).toBe('model');
    expect(refined.evidence.repositoryFilesInspected).toEqual(['src/StatusBadge.tsx']);
  });

  it('keeps the original request unchanged when model evidence is ungrounded', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    const service = new PromptRefinementService(async () =>
      completedRun(refinementJson({
        titleSuggestion: 'Invented context',
        prompt: 'Modify `src/does-not-exist.ts`.',
        repositoryInspection: 'focused',
        repositoryFilesInspected: ['src/does-not-exist.ts']
      }))
    );

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'Keep this exact request.'
    }));

    expect(refined.source).toBe('unchanged-fallback');
    expect(refined.prompt).toBe('Keep this exact request.');
    expect(refined.warning).toContain('kept unchanged');
    expect(refined.warning).toContain('could not validate');
    expect(refined.evidence.repositoryFilesInspected).toEqual([]);
  });

  it('sends relevant images natively only to an image-capable refinement model', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    const attachment = await createAttachment(repositoryPath, 'screenshot.png', 'image');
    let capturedAttachments: readonly AgentTurnAttachment[] = [];
    const service = new PromptRefinementService(async (request) => {
      capturedAttachments = request.attachments;
      return completedRun(refinementJson({
        titleSuggestion: 'Match the screenshot',
        prompt: 'Match the empty state shown in screenshot.png while preserving current interactions.',
        repositoryInspection: 'none',
        attachmentIdsInspected: [attachment.attachmentId],
        attachmentIdsReferenced: [attachment.attachmentId]
      }));
    });

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'Match the attached UI screenshot.',
      refinementModel: model(['text', 'image']),
      attachments: [attachment]
    }));

    expect(refined.source).toBe('model');
    expect(capturedAttachments).toEqual([
      expect.objectContaining({
        attachmentId: attachment.attachmentId,
        path: attachment.path,
        sha256: attachment.sha256
      })
    ]);
    expect(refined.evidence.attachmentIdsInspected).toEqual([attachment.attachmentId]);
  });

  it('accepts ordinal references when several attachments have the same display name', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    const first = await createAttachment(
      repositoryPath,
      'image.png',
      'image',
      'attachment-1',
      0
    );
    const second = await createAttachment(
      repositoryPath,
      'image.png',
      'image',
      'attachment-2',
      1
    );
    let capturedInstruction = '';
    const service = new PromptRefinementService(async ({ instruction }) => {
      capturedInstruction = instruction;
      return completedRun(refinementJson({
        titleSuggestion: 'Improve the landing page direction',
        prompt: 'Treat the first attached screenshot as the current state and the second attached screenshot as the preferred visual direction.',
        repositoryInspection: 'none',
        attachmentIdsInspected: [first.attachmentId, second.attachmentId],
        attachmentIdsReferenced: [first.attachmentId, second.attachmentId]
      }));
    });

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'Improve the site using the second attached image as the better direction.',
      refinementModel: model(['text', 'image']),
      attachments: [first, second]
    }));

    expect(refined.source).toBe('model');
    expect(capturedInstruction).toContain('Attachment 1 (image.png)');
    expect(capturedInstruction).toContain('Attachment 2 (image.png)');
  });

  it('preserves relevant images without claiming inspection for a text-only refiner', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    const attachment = await createAttachment(repositoryPath, 'screenshot.png', 'image');
    let capturedInstruction = '';
    const service = new PromptRefinementService(async (request) => {
      capturedInstruction = request.instruction;
      expect(request.attachments).toEqual([
        expect.objectContaining({
          attachmentId: attachment.attachmentId,
          path: attachment.path,
          sha256: attachment.sha256,
          byteCount: attachment.byteCount
        })
      ]);
      return completedRun(refinementJson({
        titleSuggestion: 'Use the screenshot',
        prompt: 'Use screenshot.png as the visual reference; inspect it with the downstream image-capable agent before editing.',
        repositoryInspection: 'none',
        attachmentIdsReferenced: [attachment.attachmentId]
      }));
    });

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'Use the attached screenshot to fix the layout.',
      attachments: [attachment]
    }));

    expect(refined.source).toBe('model');
    expect(refined.warning).toContain('cannot inspect');
    expect(refined.evidence.attachmentIdsInspected).toEqual([]);
    expect(capturedInstruction).toContain('"providedAsImage":false');
    expect(capturedInstruction).not.toContain(attachment.path);
  });

  it('keeps ephemeral attachment paths out of accepted prompts', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    const attachment = await createAttachment(repositoryPath, 'requirements.txt', 'text');
    const service = new PromptRefinementService(async () =>
      completedRun(refinementJson({
        titleSuggestion: 'Apply the requirements',
        prompt: `Read ${attachment.path} and apply requirements.txt.`,
        repositoryInspection: 'none',
        attachmentIdsInspected: [attachment.attachmentId],
        attachmentIdsReferenced: [attachment.attachmentId]
      }))
    );

    const refined = await service.refine(refinementInput({
      repositoryPath,
      input: 'Apply the attached requirements.',
      attachments: [attachment]
    }));

    expect(refined.source).toBe('unchanged-fallback');
    expect(refined.prompt).toBe('Apply the attached requirements.');
  });

  it('cancels an obsolete refinement run', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    let rejectRun: (cause: unknown) => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const cancel = vi.fn(async () => {
      rejectRun(new Error('canceled'));
    });
    const service = new PromptRefinementService(async () => {
      signalStarted();
      return {
        cancel,
        result: new Promise<string>((_resolve, reject) => {
          rejectRun = reject;
        })
      };
    });
    const refining = service.refine(refinementInput({
      requestId: 'cancel-me',
      repositoryPath,
      input: 'A request that is about to change.'
    }));
    const canceled = expect(refining).rejects.toBeInstanceOf(
      PromptRefinementCanceledError
    );
    await started;

    await service.cancel('cancel-me');

    await canceled;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a run whose process handle arrives after the cancel request', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    let releaseRunner: (run: PromptRefinementRun) => void = () => undefined;
    let signalRunnerStarted: () => void = () => undefined;
    const runnerStarted = new Promise<void>((resolve) => {
      signalRunnerStarted = resolve;
    });
    const waitingForHandle = new Promise<PromptRefinementRun>((resolve) => {
      releaseRunner = resolve;
    });
    const service = new PromptRefinementService(async () => {
      signalRunnerStarted();
      return waitingForHandle;
    });
    const refining = service.refine(refinementInput({
      requestId: 'cancel-before-handle',
      repositoryPath,
      input: 'This request became obsolete before the provider started.'
    }));
    await runnerStarted;
    const canceling = service.cancel('cancel-before-handle');

    let rejectResult: (cause: unknown) => void = () => undefined;
    const cancel = vi.fn(async () => rejectResult(new Error('canceled')));
    releaseRunner({
      cancel,
      result: new Promise<string>((_resolve, reject) => {
        rejectResult = reject;
      })
    });
    await canceling;

    await expect(refining).rejects.toBeInstanceOf(PromptRefinementCanceledError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails closed after process termination becomes unconfirmed', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-refine-'));
    let launches = 0;
    const service = new PromptRefinementService(async () => {
      launches += 1;
      return {
        cancel: async () => undefined,
        result: Promise.reject(
          new PromptRefinementTerminationUnconfirmedError(new Error('simulated failure'))
        )
      };
    });

    expect((await service.refine(refinementInput({
      requestId: 'first',
      repositoryPath,
      input: 'first refinement'
    }))).source).toBe('unchanged-fallback');
    expect((await service.refine(refinementInput({
      requestId: 'second',
      repositoryPath,
      input: 'second refinement'
    }))).warning).toContain('previous refinement process');
    expect(launches).toBe(1);
  });

});

function refinementInput(
  overrides: Partial<Parameters<PromptRefinementService['refine']>[0]> = {}
): Parameters<PromptRefinementService['refine']>[0] {
  return {
    requestId: 'refinement-request',
    repositoryPath: '/tmp/example',
    input: 'Refine this request.',
    refinementModel: model(['text']),
    settings: readOnlySettings(),
    ...overrides
  };
}

function readOnlySettings(): AgentExecutionSettings {
  return {
    runtimeId: 'codex',
    model: 'test-model',
    reasoningEffort: 'low',
    sandbox: 'READ_ONLY',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    networkAccess: false
  };
}

function model(inputModalities: string[]): AgentModel {
  return {
    id: 'codex:test-model',
    runtimeId: 'codex',
    model: 'test-model',
    displayName: 'Test model',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    inputModalities
  };
}

function refinementJson(input: {
  titleSuggestion: string;
  prompt: string;
  repositoryInspection: 'none' | 'focused' | 'expanded';
  repositoryFilesInspected?: string[];
  attachmentIdsInspected?: string[];
  attachmentIdsReferenced?: string[];
}): string {
  return JSON.stringify({
    repositoryFilesInspected: [],
    attachmentIdsInspected: [],
    attachmentIdsReferenced: [],
    ...input
  });
}

function completedRun(output: string): PromptRefinementRun {
  return {
    result: Promise.resolve(output),
    cancel: async () => undefined
  };
}

async function createAttachment(
  repositoryPath: string,
  displayName: string,
  kind: AgentTurnAttachment['kind'],
  attachmentId = 'attachment-1',
  ordinal = 0
): Promise<AgentTurnAttachment> {
  const directory = path.join(repositoryPath, 'staged');
  await fs.mkdir(directory, { recursive: true });
  const attachmentPath = path.join(directory, `${attachmentId}-${displayName}`);
  const bytes = Buffer.from('verified attachment');
  await fs.writeFile(attachmentPath, bytes, { mode: 0o400 });
  await fs.chmod(attachmentPath, 0o400);
  return {
    attachmentId,
    ordinal,
    displayName,
    kind,
    mediaType: kind === 'image' ? 'image/png' : 'text/plain',
    byteCount: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    path: attachmentPath,
    verifiedAt: new Date().toISOString()
  };
}
