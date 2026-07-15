import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionContext, AgentOwnerScope } from '../../shared/agentRuntime';
import {
  assertAccessEpochMatches,
  assertAgentRunScope,
  assertDiscourseExecutionContext,
  createAgentSessionAccessEpoch
} from './AgentRuntimeOwnership';

const taskOwner: AgentOwnerScope = { kind: 'TASK', taskId: 'task-1' };
const discourseOwner: AgentOwnerScope = {
  kind: 'DISCOURSE',
  conversationId: 'conversation-1',
  stableParticipantId: 'participant-1'
};

describe('AgentRuntimeOwnership', () => {
  it('hashes the complete execution boundary independent of root and attachment order', () => {
    const first = epoch(executionContext());
    const reordered = epoch({
      ...executionContext(),
      readRoots: [...executionContext().readRoots].reverse(),
      managedAttachments: [...executionContext().managedAttachments].reverse(),
      modelSettings: {
        approvalPolicy: 'NEVER',
        sandbox: 'READ_ONLY',
        reasoningEffort: 'high',
        model: 'gpt-test',
        networkAccess: false
      }
    });
    expect(reordered.executionProfileHash).toBe(first.executionProfileHash);
  });

  it('changes the epoch hash for any permission, model, tool, or attachment boundary change', () => {
    const baseline = epoch(executionContext()).executionProfileHash;
    const variants: AgentExecutionContext[] = [
      { ...executionContext(), primaryCwd: absolute('secondary') },
      {
        ...executionContext(),
        permissionProfileHash: 'b'.repeat(64)
      },
      {
        ...executionContext(),
        modelSettings: { ...executionContext().modelSettings, reasoningEffort: 'medium' }
      },
      {
        ...executionContext(),
        externalTools: { ...executionContext().externalTools, network: true }
      },
      {
        ...executionContext(),
        managedAttachments: [
          ...executionContext().managedAttachments.slice(0, 1),
          {
            attachmentId: 'attachment-3',
            contentSha256: 'c'.repeat(64),
            byteCount: 4
          }
        ]
      }
    ];
    for (const variant of variants) {
      expect(epoch(variant).executionProfileHash).not.toBe(baseline);
    }
    expect(
      createAgentSessionAccessEpoch({
        owner: taskOwner,
        sessionId: 'session-1',
        epoch: 1,
        providerId: 'codex',
        model: 'another-model',
        executionContext: executionContext(),
        createdAt: '2026-07-13T00:00:00.000Z'
      }).executionProfileHash
    ).not.toBe(baseline);
  });

  it('rejects mixed task/discourse ownership and invalid access epochs', () => {
    expect(() =>
      assertAgentRunScope(
        {
          kind: 'DISCOURSE',
          conversationId: 'conversation-1',
          waveId: 'wave-1',
          jobId: 'job-1',
          contextSnapshotId: 'context-1',
          attemptId: 'attempt-1'
        },
        taskOwner
      )
    ).toThrow('does not belong');
    expect(() =>
      assertAccessEpochMatches({
        epoch: epoch(executionContext()),
        owner: discourseOwner,
        sessionId: 'session-1'
      })
    ).toThrow('does not match');
  });

  it('requires discourse to be read-only, offline, tool-free, and fully attested', () => {
    expect(() => assertDiscourseExecutionContext(executionContext())).not.toThrow();
    for (const unsafe of [
      { externalTools: { ...executionContext().externalTools, network: true } },
      { externalTools: { ...executionContext().externalTools, apps: true } },
      { modelSettings: { ...executionContext().modelSettings, sandbox: 'WORKSPACE_WRITE' as const } },
      { modelSettings: { ...executionContext().modelSettings, approvalPolicy: 'ON_REQUEST' as const } }
    ]) {
      expect(() =>
        assertDiscourseExecutionContext({ ...executionContext(), ...unsafe })
      ).toThrow();
    }
    expect(() =>
      assertDiscourseExecutionContext({
        ...executionContext(),
        attestation: {
          status: 'INHERITED_UNATTESTED',
          parentSessionId: 'parent-session',
          reason: 'Provider-spawned child scope.'
        }
      })
    ).toThrow('provider-attested');
  });
});

function epoch(context: AgentExecutionContext) {
  return createAgentSessionAccessEpoch({
    owner: taskOwner,
    sessionId: 'session-1',
    epoch: 1,
    providerId: 'codex',
    model: 'gpt-test',
    executionContext: context,
    createdAt: '2026-07-13T00:00:00.000Z'
  });
}

function executionContext(): AgentExecutionContext {
  return {
    attestation: { status: 'ATTESTED' },
    primaryCwd: absolute('primary'),
    readRoots: [
      { canonicalPath: absolute('secondary'), kind: 'REPOSITORY', entityId: 'repository-2' },
      { canonicalPath: absolute('primary'), kind: 'WORKTREE', entityId: 'worktree-1' }
    ],
    managedAttachments: [
      { attachmentId: 'attachment-2', contentSha256: '2'.repeat(64), byteCount: 2 },
      { attachmentId: 'attachment-1', contentSha256: '1'.repeat(64), byteCount: 1 }
    ],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: {
      model: 'gpt-test',
      reasoningEffort: 'high',
      sandbox: 'READ_ONLY',
      approvalPolicy: 'NEVER',
      networkAccess: false
    },
    externalTools: {
      network: false,
      webSearch: 'disabled',
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: 'operation-1'
  };
}

function absolute(name: string): string {
  return path.join(path.parse(process.cwd()).root, 'tmp', 'task-monki-runtime', name);
}
