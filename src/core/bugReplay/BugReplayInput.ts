import type { BugCaptureDraft, BugCaseAction, BugExpectationEdit, BugExpectationsDraft, BugReplaySnapshot } from '../../shared/bugReplay';
import { BUG_REPLAY_STORAGE_LIMIT_BYTES } from '../../shared/bugReplay';

/**
 * Bug Replay's requests come from the renderer and are untrusted: each is checked for shape and
 * bounds here before any service reads it. A malformed request is refused with one message.
 */

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const ACTIONS: ReadonlySet<BugCaseAction> = new Set<BugCaseAction>([
  'verify-again',
  'run-again',
  'keep-browser-storage',
  'use-new-env-files',
  'save-without-check',
  'remove'
]);
const TEMPLATES = new Set(['equals', 'contains', 'visible', 'hidden', 'count']);
const REQUEST_CHECKS = new Set(['success', 'answered', 'none']);

class BugReplayInputError extends Error {
  constructor() {
    super('This bug request is not valid.');
    this.name = 'BugReplayInputError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BugReplayInputError();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BugReplayInputError();
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new BugReplayInputError();
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max);
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BugReplayInputError();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BugReplayInputError();
  return value;
}

function list<T>(value: unknown, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new BugReplayInputError();
  return value.map(item);
}

function task(value: unknown): { taskId: string } {
  return { taskId: id(object(value).taskId) };
}

function session(value: unknown): { taskId: string; sessionId: string } {
  const input = object(value);
  return { taskId: id(input.taskId), sessionId: id(input.sessionId) };
}

function captureDraft(value: unknown): BugCaptureDraft {
  const input = object(value);
  const statement = optionalText(input.statement, 2_000);
  return {
    title: text(input.title, 200),
    ...(statement !== undefined ? { statement } : {}),
    checks: list(input.checks, 20, (entry) => {
      const check = object(entry);
      const template = text(check.template, 16);
      if (!TEMPLATES.has(template)) throw new BugReplayInputError();
      const expected = optionalText(check.expected, 1_000);
      return {
        pickIndex: integer(check.pickIndex, 0, 99),
        template: template as BugCaptureDraft['checks'][number]['template'],
        ...(expected !== undefined ? { expected } : {}),
        ...(check.count !== undefined ? { count: integer(check.count, 0, 10_000) } : {}),
        alsoAfterReload: boolean(check.alsoAfterReload)
      };
    }),
    requestRules: list(input.requestRules, 100, (entry) => {
      const rule = object(entry);
      const check = text(rule.check, 16);
      if (!REQUEST_CHECKS.has(check)) throw new BugReplayInputError();
      return { requestKey: text(rule.requestKey, 600), check: check as 'success' | 'answered' | 'none', sentOnce: boolean(rule.sentOnce) };
    }),
    valueChecks: list(input.valueChecks, 40, (entry) => {
      const valueCheck = object(entry);
      const side = text(valueCheck.side, 16);
      if (side !== 'request' && side !== 'response') throw new BugReplayInputError();
      const pointer = text(valueCheck.pointer, 300);
      if (pointer !== '' && !pointer.startsWith('/')) throw new BugReplayInputError();
      return { requestKey: text(valueCheck.requestKey, 600), side, pointer, expected: text(valueCheck.expected, 2_000) };
    }),
    ...(input.noPageError !== undefined ? { noPageError: boolean(input.noPageError) } : {}),
    ...(input.picksSeen !== undefined ? { picksSeen: integer(input.picksSeen, 0, 99) } : {})
  };
}

/** The expectations editor's draft: each kept expectation by its id, with what the person set. */
function expectationsDraft(value: unknown): BugExpectationsDraft {
  const input = object(value);
  return {
    versionId: id(input.versionId),
    expectations: list(input.expectations, 20, (entry): BugExpectationEdit => {
      const edit = object(entry);
      const editId = id(edit.id);
      switch (edit.kind) {
        case 'element': {
          const template = text(edit.template, 16);
          if (!TEMPLATES.has(template)) throw new BugReplayInputError();
          const expected = optionalText(edit.expected, 1_000);
          return {
            kind: 'element',
            id: editId,
            template: template as Extract<BugExpectationEdit, { kind: 'element' }>['template'],
            ...(expected !== undefined ? { expected } : {}),
            ...(edit.count !== undefined ? { count: integer(edit.count, 0, 10_000) } : {}),
            alsoAfterReload: boolean(edit.alsoAfterReload)
          };
        }
        case 'status': {
          const check = text(edit.check, 16);
          if (check !== 'success' && check !== 'answered') throw new BugReplayInputError();
          return { kind: 'status', id: editId, check };
        }
        case 'value':
          return { kind: 'value', id: editId, expected: text(edit.expected, 2_000) };
        case 'keep':
          return { kind: 'keep', id: editId };
        default:
          throw new BugReplayInputError();
      }
    })
  };
}

export const bugReplayInput = {
  task,
  session,
  envFiles(value: unknown): { taskId: string; sessionId: string; include: string[] } {
    const input = object(value);
    return { ...session(input), include: list(input.include, 12, (entry) => text(entry, 400)) };
  },
  lease(value: unknown): { taskId: string; approvalDigest: string; keep: boolean } {
    const input = object(value);
    const approvalDigest = text(input.approvalDigest, 64);
    if (!DIGEST.test(approvalDigest)) throw new BugReplayInputError();
    return { ...task(input), approvalDigest, keep: input.keep === undefined ? false : boolean(input.keep) };
  },
  approval(value: unknown): { approvalId: string } {
    const approvalId = text(object(value).approvalId, 64);
    if (!UUID.test(approvalId)) throw new BugReplayInputError();
    return { approvalId };
  },
  page(value: unknown): { taskId: string; sessionId: string; path: string } {
    const input = object(value);
    return { ...session(input), path: text(input.path, 512) };
  },
  optionalDraft(value: unknown): { taskId: string; sessionId: string; draft?: BugCaptureDraft } {
    const input = object(value);
    return { ...session(input), ...(input.draft !== undefined ? { draft: captureDraft(input.draft) } : {}) };
  },
  draft(value: unknown): { taskId: string; sessionId: string; draft: BugCaptureDraft } {
    const input = object(value);
    return { ...session(input), draft: captureDraft(input.draft) };
  },
  save(value: unknown): { taskId: string; sessionId: string; draft: BugCaptureDraft; draftRevision: number; withCheck: boolean } {
    const input = object(value);
    return {
      ...session(input),
      draft: captureDraft(input.draft),
      draftRevision: integer(input.draftRevision, 0, Number.MAX_SAFE_INTEGER),
      withCheck: boolean(input.withCheck)
    };
  },
  send(value: unknown): { taskId: string; clientOperationId: string; attachmentDraftId?: string } {
    const input = object(value);
    const clientOperationId = text(input.clientOperationId, 64);
    if (!UUID.test(clientOperationId)) throw new BugReplayInputError();
    return { ...task(input), clientOperationId, ...(input.attachmentDraftId !== undefined ? { attachmentDraftId: id(input.attachmentDraftId) } : {}) };
  },
  run(value: unknown): { taskId: string; runId: string } {
    const input = object(value);
    return { ...task(input), runId: id(input.runId) };
  },
  action(value: unknown): { taskId: string; action: BugCaseAction } {
    const input = object(value);
    const action = text(input.action, 40) as BugCaseAction;
    if (!ACTIONS.has(action)) throw new BugReplayInputError();
    return { ...task(input), action };
  },
  expectations(value: unknown): { taskId: string; draft: BugExpectationsDraft } {
    const input = object(value);
    return { ...task(input), draft: expectationsDraft(input.draft) };
  },
  evidence(value: unknown): { taskId: string; caseId: string } {
    const input = object(value);
    return { ...task(input), caseId: id(input.caseId) };
  },
  file(value: unknown): { taskId: string; fileId: string } {
    const input = object(value);
    return { ...task(input), fileId: id(input.fileId) };
  },
  /** What a build without Bug Replay answers: nothing to show, nothing offered. */
  unavailable(taskId: string): BugReplaySnapshot {
    return {
      taskId,
      availability: { canRecord: false, hiddenReason: 'Bug Replay is not available here.' },
      runs: [],
      runCount: 0,
      earlierCases: [],
      storage: { usedBytes: 0, limitBytes: BUG_REPLAY_STORAGE_LIMIT_BYTES }
    };
  }
};
