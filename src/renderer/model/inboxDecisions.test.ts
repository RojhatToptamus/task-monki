import { describe, expect, it } from 'vitest';
import type {
  AgentInteractionAction,
  InteractionRequestRecord,
  InteractionRequestType
} from '../../shared/contracts';
import { inboxInteractionDecisions } from './inboxDecisions';

function interaction(
  type: InteractionRequestType,
  allowedActions: AgentInteractionAction[],
  request: unknown = {},
  status: InteractionRequestRecord['status'] = 'PENDING',
  policyWarnings: string[] = []
): InteractionRequestRecord {
  return {
    id: 'i1',
    runtimeId: 'codex',
    serverInstanceId: 's',
    providerRequestId: 1,
    taskId: 't1',
    iterationId: 'it1',
    runId: 'r1',
    sessionId: 'sess1',
    type,
    status,
    request: request as InteractionRequestRecord['request'],
    allowedActions,
    policyWarnings,
    requestRawMessage: {
      serverInstanceId: 's',
      sequence: 0,
      direction: 'INBOUND',
      recordedAt: '2026-06-24T10:00:00.000Z',
      byteOffset: 0,
      byteLength: 0,
      sha256: ''
    },
    requestedAt: '2026-06-24T10:00:00.000Z'
  };
}

const COMMAND = { startedAtMs: 1, command: "/bin/zsh -lc 'npm test -- shortlist'" };

describe('inboxInteractionDecisions', () => {
  it('offers Allow once and Deny for a plain command approval and names the command', () => {
    const d = inboxInteractionDecisions(
      interaction('COMMAND_APPROVAL', ['ACCEPT', 'DECLINE'], COMMAND)
    );
    expect(d.subject).toBe('npm test -- shortlist');
    expect(d.approve).toEqual({
      label: 'Allow once',
      decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
    });
    expect(d.deny).toEqual({
      label: 'Deny',
      decision: { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' }
    });
  });

  it('never offers an inline decision whose subject the row cannot show', () => {
    const inline = (request: unknown, warnings: string[] = []) =>
      inboxInteractionDecisions(
        interaction('COMMAND_APPROVAL', ['ACCEPT', 'DECLINE'], request, 'PENDING', warnings)
      );
    expect(inline({ startedAtMs: 1 })).toEqual({});
    expect(inline(COMMAND, ['Writes outside the worktree.'])).toEqual({});
    // A second line or a long tail would hide part of what "Allow once" runs.
    expect(inline({ startedAtMs: 1, command: "/bin/zsh -lc 'npm test\nrm -rf build'" })).toEqual({});
    expect(inline({ startedAtMs: 1, command: `npm test && ${'x'.repeat(120)}` })).toEqual({});
    // A host or extra paths widen the grant beyond the command text.
    expect(inline({ ...COMMAND, networkApprovalContext: { protocol: 'https', host: 'registry.npmjs.org' } })).toEqual({});
    expect(inline({ ...COMMAND, paths: ['/etc/hosts'] })).toEqual({});
    expect(inline({ startedAtMs: 1, command: "bash -c 'npm run lint'" }).subject).toBe('npm run lint');
  });

  it('requires opening the task for provider-native choices and their context', () => {
    const d = inboxInteractionDecisions(
      interaction(
        'COMMAND_APPROVAL',
        ['ACCEPT', 'DECLINE', 'CANCEL'],
        {
          ...COMMAND,
          providerOptions: [
            { id: 'allow-once', label: 'Allow once', action: 'ACCEPT', providerRemembersChoice: false },
            { id: 'allow-always', label: 'Allow always', action: 'ACCEPT', providerRemembersChoice: true },
            { id: 'reject-once', label: 'Reject', action: 'DECLINE', providerRemembersChoice: false }
          ]
        }
      )
    );

    expect(d).toEqual({});
  });

  it('requires opening the task for file changes, permission profiles, forms and typed answers', () => {
    expect(inboxInteractionDecisions(
      interaction('FILE_CHANGE_APPROVAL', ['ACCEPT', 'DECLINE'], { startedAtMs: 1, changes: [{ path: 'a.ts', kind: 'update', diff: '' }] })
    )).toEqual({});
    expect(inboxInteractionDecisions(
      interaction('PERMISSION_APPROVAL', ['GRANT_TURN', 'DECLINE'], { permissions: ['fs.write'] })
    )).toEqual({});
    expect(inboxInteractionDecisions(
      interaction('MCP_ELICITATION', ['ACCEPT', 'DECLINE', 'CANCEL'])
    )).toEqual({});
    expect(inboxInteractionDecisions(interaction('USER_INPUT', ['ANSWER', 'CANCEL']))).toEqual({});
  });

  it('offers no inline action once the request is already responding', () => {
    const d = inboxInteractionDecisions(
      interaction('COMMAND_APPROVAL', ['ACCEPT', 'DECLINE'], COMMAND, 'RESPONDING')
    );
    expect(d).toEqual({});
  });
});
