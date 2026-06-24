import { describe, expect, it } from 'vitest';
import type {
  AgentSessionRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import {
  buildInteractionPolicy,
  validateInteractionDecision
} from './AgentInteractionPolicy';

describe('Agent interaction policy', () => {
  it('fails closed for commands outside the task worktree or requiring blocked network', () => {
    const outside = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'curl https://example.com',
        cwd: '/tmp/other',
        networkApprovalContext: { host: 'example.com', protocol: 'https' }
      },
      session: sessionFixture(),
      run: runFixture()
    });

    expect(outside.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(outside.warnings).toHaveLength(2);
  });

  it('exposes only provider-supplied command amendments', () => {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        proposedExecPolicyAmendment: ['npm', 'test']
      },
      session: sessionFixture(),
      run: runFixture()
    });
    expect(policy.allowedActions).toContain('ACCEPT_EXEC_POLICY_AMENDMENT');

    const interaction = interactionFixture({
      request: {
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        proposedExecPolicyAmendment: ['npm', 'test']
      },
      allowedActions: policy.allowedActions
    });
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
          amendment: ['npm', 'publish']
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('does not match');
  });

  it('does not delegate Task Monki-controlled Git delivery actions to Codex', () => {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'git commit -am "generated"',
        cwd: '/tmp/worktree'
      },
      session: sessionFixture(),
      run: runFixture()
    });

    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('reserves commit');
  });

  it('rejects permission grants outside the requested and task-owned subset', () => {
    const interaction = interactionFixture({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: {
          fileSystem: { write: ['/tmp/worktree/cache'] }
        }
      },
      allowedActions: ['GRANT_TURN', 'DECLINE']
    });

    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'PERMISSION_APPROVAL',
          action: 'GRANT_TURN',
          permissions: {
            fileSystem: { write: ['/tmp/other'] }
          }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('subset');
  });

  it('validates accepted MCP form content against the provider schema', () => {
    const interaction = interactionFixture({
      type: 'MCP_ELICITATION',
      request: {
        mode: 'form',
        serverName: 'tickets',
        message: 'Select severity',
        requestedSchema: {
          type: 'object',
          required: ['severity'],
          properties: {
            severity: { type: 'string', enum: ['low', 'high'] }
          }
        }
      },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL']
    });

    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'MCP_ELICITATION',
          action: 'ACCEPT',
          content: { severity: 'critical' }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('not an allowed value');
  });
});

function sessionFixture(): AgentSessionRecord {
  return {
    id: 'session-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    provider: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    worktreePath: '/tmp/worktree',
    status: 'ACTIVE',
    materialized: true,
    requestedSettings: {
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request'
    },
    ownership: 'TASK_MONKI',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z'
  };
}

function runFixture(): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    serverInstanceId: 'server-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'AWAITING_APPROVAL',
    recoveryState: 'NONE',
    requestedSettings: {
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request'
    },
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: '2026-06-22T00:00:00.000Z',
    eventCount: 0
  };
}

function interactionFixture(
  overrides: Partial<InteractionRequestRecord> = {}
): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    serverInstanceId: 'server-1',
    providerRequestId: 7,
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: {
      startedAtMs: 1,
      command: 'npm test',
      cwd: '/tmp/worktree'
    },
    allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-06-22T00:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    requestedAt: '2026-06-22T00:00:00.000Z',
    ...overrides
  };
}
