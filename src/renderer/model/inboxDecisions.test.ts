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
  status: InteractionRequestRecord['status'] = 'PENDING'
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
    policyWarnings: [],
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

describe('inboxInteractionDecisions', () => {
  it('offers Approve + Deny for a command approval', () => {
    const d = inboxInteractionDecisions(
      interaction('COMMAND_APPROVAL', ['ACCEPT', 'DECLINE'])
    );
    expect(d.approve?.decision).toEqual({
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT'
    });
    expect(d.deny?.decision).toEqual({
      interactionType: 'COMMAND_APPROVAL',
      action: 'DECLINE'
    });
  });

  it('grants the current turn for a permission approval, carrying its permissions', () => {
    const d = inboxInteractionDecisions(
      interaction('PERMISSION_APPROVAL', ['GRANT_TURN', 'DECLINE'], {
        permissions: ['fs.write']
      })
    );
    expect(d.approve?.decision).toEqual({
      interactionType: 'PERMISSION_APPROVAL',
      action: 'GRANT_TURN',
      permissions: ['fs.write']
    });
    expect(d.deny?.decision.action).toBe('DECLINE');
  });

  it('offers no inline action for user input because answers must be typed', () => {
    const d = inboxInteractionDecisions(interaction('USER_INPUT', ['ANSWER', 'CANCEL']));
    expect(d.approve).toBeUndefined();
    expect(d.deny).toBeUndefined();
  });

  it('falls back to Cancel when Decline is unavailable', () => {
    const d = inboxInteractionDecisions(interaction('FILE_CHANGE_APPROVAL', ['ACCEPT', 'CANCEL']));
    expect(d.approve?.decision.action).toBe('ACCEPT');
    expect(d.deny?.label).toBe('Cancel');
    expect(d.deny?.decision.action).toBe('CANCEL');
  });

  it('offers no inline action once the request is already responding', () => {
    const d = inboxInteractionDecisions(
      interaction('COMMAND_APPROVAL', ['ACCEPT', 'DECLINE'], {}, 'RESPONDING')
    );
    expect(d.approve).toBeUndefined();
    expect(d.deny).toBeUndefined();
  });

  it('allows declining MCP elicitations but still requires opening the task to accept form data', () => {
    const d = inboxInteractionDecisions(
      interaction('MCP_ELICITATION', ['ACCEPT', 'DECLINE', 'CANCEL'])
    );
    expect(d.approve).toBeUndefined();
    expect(d.deny?.decision).toEqual({
      interactionType: 'MCP_ELICITATION',
      action: 'DECLINE'
    });
  });
});
