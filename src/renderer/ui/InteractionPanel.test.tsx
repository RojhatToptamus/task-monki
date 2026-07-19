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

  it('renders provider-native tool context and exact permission choices', () => {
    const interaction = commandInteraction();
    interaction.runtimeId = 'cursor-agent-acp';
    interaction.policyWarnings = [
      'Selecting a remembered option allows Cursor Agent to persist the choice. Cursor Agent owns its scope, storage, lifetime, and revocation, which may extend beyond this ACP session or process.'
    ];
    interaction.request = {
      startedAtMs: Date.now(),
      command: 'npm test',
      cwd: '/tmp/task/react-repo',
      paths: ['src/core/agent.ts', 'src/core/agent.test.ts'],
      reason: 'Run the project test suite before finishing.',
      networkApprovalContext: {
        protocol: 'https',
        host: 'registry.npmjs.org'
      },
      providerOptions: [
        {
          id: 'allow-edits-session',
          label: 'Allow edits this session',
          action: 'ACCEPT',
          providerRemembersChoice: true
        },
        {
          id: 'allow-once',
          label: 'Yes, proceed',
          action: 'ACCEPT',
          providerRemembersChoice: false
        },
        {
          id: 'reject-once',
          label: 'No, tell Grok why',
          action: 'DECLINE',
          providerRemembersChoice: false
        }
      ]
    };
    interaction.allowedActions = ['ACCEPT', 'DECLINE', 'CANCEL'];

    const html = renderToStaticMarkup(
      <InteractionPanel
        interactions={[interaction]}
        sessions={[sessionFixture()]}
        onRespond={async () => undefined}
      />
    );

    expect(html).toContain('Tool approval');
    expect(html).not.toContain('Command approval');
    expect(html).toContain('Provider context');
    expect(html).toContain('<strong>Untrusted:</strong>');
    expect(html).toContain('Run the project test suite before finishing.');
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('src/core/agent.ts');
    expect(html).toContain('/tmp/task/react-repo');
    expect(html).toContain('https · registry.npmjs.org');
    expect(html).toContain('Yes, proceed');
    expect(html).toContain('No, tell Grok why');
    expect(html).toContain('Allow edits this session');
    expect(html).toMatch(/class="primary-button"[^>]*>Yes, proceed<\/button>/);
    expect(html).toMatch(
      /class="outline-button"[^>]*>Allow edits this session<\/button>/
    );
    expect(html).toContain(
      'Cursor Agent owns its scope, storage, lifetime, and revocation'
    );
    expect(html).not.toContain('Allow for session');
  });

  it('keeps a cancel action when every provider grant is withheld', () => {
    const interaction = commandInteraction();
    interaction.request = {
      startedAtMs: Date.now(),
      providerOptions: []
    };
    interaction.allowedActions = ['ACCEPT', 'DECLINE', 'CANCEL'];

    const html = renderToStaticMarkup(
      <InteractionPanel
        interactions={[interaction]}
        sessions={[sessionFixture()]}
        onRespond={async () => undefined}
      />
    );

    expect(html).toContain('Cancel');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('>Deny<');
    expect(html).not.toContain('Working directory');
    expect(html).not.toContain('/tmp/task');
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
