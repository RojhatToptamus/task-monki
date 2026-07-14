import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentSessionRecord, InteractionRequestRecord } from '../../shared/contracts';
import { InteractionPanel } from './InteractionPanel';

describe('InteractionPanel', () => {
  it('renders command approval as one command and three clear decisions', () => {
    const html = renderToStaticMarkup(
      <InteractionPanel
        interactions={[commandInteraction()]}
        sessions={[sessionFixture()]}
        onRespond={async () => undefined}
      />
    );

    expect(html).toContain('Command approval');
    expect(html).toContain('<code>cd react-repo &amp;&amp; npm install</code>');
    expect(html).toContain('Always allow matching commands');
    expect(html).toContain('Deny');
    expect(html).toContain('Allow once');
    expect(html).toContain('Allow for session');
    expect(html).not.toContain('Stop current turn');
  });

  it('keeps provider rationale and policy details out of the approval surface', () => {
    const html = renderToStaticMarkup(
      <InteractionPanel
        interactions={[commandInteraction()]}
        sessions={[sessionFixture()]}
        onRespond={async () => undefined}
      />
    );

    expect(html).not.toContain('Agent rationale');
    expect(html).not.toContain('Install dependencies so the tests can run.');
    expect(html).not.toContain('prefix_rule');
    expect(html).not.toContain('Request details');
    expect(html).not.toContain('/bin/zsh -lc');
    expect(html).not.toContain('/tmp/task/react-repo');
  });

  it('shows only deny when policy warnings block command approval', () => {
    const interaction = commandInteraction();
    interaction.allowedActions = ['DECLINE', 'CANCEL'];
    interaction.policyWarnings = ['The command working directory is outside the task worktree.'];
    const html = renderToStaticMarkup(
      <InteractionPanel
        interactions={[interaction]}
        sessions={[sessionFixture()]}
        onRespond={async () => undefined}
      />
    );

    expect(html).toContain('The command working directory is outside the task worktree.');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Stop current turn');
  });
});

function commandInteraction(): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    runtimeId: 'codex',
    serverInstanceId: 'server-1',
    providerRequestId: 5,
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: {
      startedAtMs: Date.now(),
      command: "/bin/zsh -lc 'cd react-repo && npm install'",
      cwd: '/tmp/task/react-repo',
      reason: 'Install dependencies so the tests can run.',
      commandActions: [{ type: 'unknown', command: 'cd react-repo && npm install' }],
      networkApprovalContext: { protocol: 'https', host: 'registry.npmjs.org' },
      proposedExecPolicyAmendment: ['prefix_rule(["npm", "install"])']
    },
    allowedActions: [
      'ACCEPT',
      'ACCEPT_FOR_SESSION',
      'ACCEPT_EXEC_POLICY_AMENDMENT',
      'DECLINE',
      'CANCEL'
    ],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-07-10T10:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    requestedAt: '2026-07-10T10:00:00.000Z'
  };
}

function sessionFixture(): AgentSessionRecord {
  return {
    id: 'session-1',
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    worktreePath: '/tmp/task',
    status: 'ACTIVE',
    materialized: true,
    requestedSettings: {},
    ownership: 'TASK_MONKI',
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:00.000Z'
  };
}
