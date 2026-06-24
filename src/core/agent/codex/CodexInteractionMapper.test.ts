import { describe, expect, it } from 'vitest';
import {
  mapCodexInteractionRequest,
  mapCodexInteractionResponse
} from './CodexInteractionMapper';

describe('Codex interaction mapping', () => {
  it('maps command approval proposals without inventing decisions', () => {
    const mapped = mapCodexInteractionRequest({
      method: 'item/commandExecution/requestApproval',
      id: 12,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        proposedExecpolicyAmendment: ['npm', 'test']
      }
    });

    expect(mapped?.type).toBe('COMMAND_APPROVAL');
    expect(mapped?.request).toMatchObject({
      command: 'npm test',
      proposedExecPolicyAmendment: ['npm', 'test']
    });
  });

  it('maps typed decisions to exact App Server response shapes', () => {
    expect(
      mapCodexInteractionResponse({
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
        amendment: ['npm', 'test']
      })
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['npm', 'test']
        }
      }
    });
    expect(
      mapCodexInteractionResponse({
        interactionType: 'PERMISSION_APPROVAL',
        action: 'DECLINE'
      })
    ).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('maps every supported interaction response class', () => {
    expect(
      mapCodexInteractionResponse({
        interactionType: 'FILE_CHANGE_APPROVAL',
        action: 'ACCEPT_FOR_SESSION'
      })
    ).toEqual({ decision: 'acceptForSession' });
    expect(
      mapCodexInteractionResponse({
        interactionType: 'MCP_ELICITATION',
        action: 'ACCEPT',
        content: { ticket: 'ABC-1' }
      })
    ).toEqual({
      action: 'accept',
      content: { ticket: 'ABC-1' },
      _meta: null
    });
    expect(
      mapCodexInteractionResponse({
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: { scope: ['repository'] }
      })
    ).toEqual({
      answers: { scope: { answers: ['repository'] } }
    });
    expect(
      mapCodexInteractionResponse({
        interactionType: 'DYNAMIC_TOOL',
        action: 'REJECT_UNREGISTERED'
      })
    ).toMatchObject({ success: false });
  });
});
