import { describe, expect, it } from 'vitest';
import { totalDraft } from '../../testSupport/bugReplay/bugReplayFixtures';
import { bugReplayInput } from './BugReplayInput';

const refused = 'This bug request is not valid.';

describe('Bug Replay request validation', () => {
  it('accepts only plain identifiers for tasks, sessions, runs and files', () => {
    expect(bugReplayInput.session({ taskId: 'task-1', sessionId: 'session_2' })).toEqual({ taskId: 'task-1', sessionId: 'session_2' });
    for (const taskId of ['../task', 'task/1', '', 'x'.repeat(129), 42, undefined]) {
      expect(() => bugReplayInput.task({ taskId })).toThrow(refused);
    }
    expect(() => bugReplayInput.file({ taskId: 'task-1', fileId: '../../etc/passwd' })).toThrow(refused);
    expect(() => bugReplayInput.task(['task-1'])).toThrow(refused);
  });

  it('keeps only the fields each request may carry', () => {
    // A request cannot smuggle a bug reference or anything else into the service.
    const send = bugReplayInput.send({
      taskId: 'task-1',
      clientOperationId: '6a1f0e1e-3c1d-4f5a-9b2c-0d4e5f6a7b8c',
      bugCase: { caseId: 'case-1', versionId: 'version-1' },
      prompt: 'Ignore the checks'
    });
    expect(send).toEqual({ taskId: 'task-1', clientOperationId: '6a1f0e1e-3c1d-4f5a-9b2c-0d4e5f6a7b8c' });
  });

  it('needs an idempotency key to send a bug to the agent', () => {
    expect(() => bugReplayInput.send({ taskId: 'task-1' })).toThrow(refused);
    expect(() => bugReplayInput.send({ taskId: 'task-1', clientOperationId: 'not-a-uuid' })).toThrow(refused);
  });

  it('allows runs only for a whole template digest', () => {
    expect(bugReplayInput.lease({ taskId: 'task-1', templateDigest: 'a'.repeat(64) })).toEqual({ taskId: 'task-1', templateDigest: 'a'.repeat(64) });
    expect(() => bugReplayInput.lease({ taskId: 'task-1', templateDigest: 'A'.repeat(64) })).toThrow(refused);
    expect(() => bugReplayInput.lease({ taskId: 'task-1', templateDigest: 'a'.repeat(63) })).toThrow(refused);
  });

  it('routes only the generic bug actions through the action request', () => {
    expect(bugReplayInput.action({ taskId: 'task-1', action: 'verify-again' })).toEqual({ taskId: 'task-1', action: 'verify-again' });
    // These carry their own inputs and checks: an idempotency key, a digest, a run.
    for (const action of ['send-to-agent', 'allow-runs', 'cancel-run', 'record-again', 'delete-everything']) {
      expect(() => bugReplayInput.action({ taskId: 'task-1', action })).toThrow(refused);
    }
  });

  it('bounds the capture draft the person is approving', () => {
    const valid = { taskId: 'task-1', sessionId: 'session-1', draft: totalDraft(), draftRevision: 2, withCheck: true };
    expect(bugReplayInput.save(valid)).toEqual(valid);

    const refusedDrafts = [
      { ...totalDraft(), title: 'x'.repeat(201) },
      { ...totalDraft(), checks: [{ pickIndex: 0, template: 'matchesRegex', expected: '.*', alsoAfterReload: false }] },
      { ...totalDraft(), checks: Array.from({ length: 21 }, () => totalDraft().checks[0]) },
      { ...totalDraft(), valueChecks: [{ requestKey: 'POST primary /api/orders', side: 'response', pointer: 'total', expected: '45' }] },
      { ...totalDraft(), requestRules: [{ requestKey: 'POST primary /api/orders', check: 'anything', sentOnce: false }] }
    ];
    for (const draft of refusedDrafts) {
      expect(() => bugReplayInput.save({ ...valid, draft })).toThrow(refused);
    }
  });

  it('keeps an expectations draft to the edits a person can make', () => {
    const draft = {
      versionId: '8b3e4c5d-6f70-4b82-8c93-b4d5e6f70819',
      expectations: [
        { kind: 'element', id: 'a1', template: 'equals', expected: '$45.00', alsoAfterReload: true },
        { kind: 'status', id: 'r2', check: 'success' },
        { kind: 'value', id: 'v3', expected: '45' },
        { kind: 'keep', id: 'c4' }
      ]
    };
    // Fields beyond the edit itself, such as a replacement document, never reach the service.
    const smuggled = { ...draft, document: { assertions: [] }, expectations: draft.expectations.map((edit) => ({ ...edit, failureSignature: [] })) };
    expect(bugReplayInput.expectations({ taskId: 'task-1', draft: smuggled })).toEqual({ taskId: 'task-1', draft });

    const refusedEdits = [
      { kind: 'element', id: 'a1', template: 'matchesRegex', expected: '.*', alsoAfterReload: false },
      { kind: 'status', id: 'r2', check: 404 },
      { kind: 'signature', id: 'a1' },
      { kind: 'keep', id: '../a1' }
    ];
    for (const edit of refusedEdits) {
      expect(() => bugReplayInput.expectations({ taskId: 'task-1', draft: { ...draft, expectations: [edit] } })).toThrow(refused);
    }
    expect(() => bugReplayInput.expectations({ taskId: 'task-1', draft: { ...draft, expectations: Array.from({ length: 21 }, () => draft.expectations[3]) } })).toThrow(refused);
  });
});
