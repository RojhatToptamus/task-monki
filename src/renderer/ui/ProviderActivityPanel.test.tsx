import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  AgentSessionRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { ProviderActivityPanel } from './ProviderActivityPanel';

describe('ProviderActivityPanel', () => {
  it('renders curated grouped sections while keeping raw provider detail disclosed', () => {
    const run = runFixture();
    const html = renderToStaticMarkup(
      <ProviderActivityPanel
        runs={[run]}
        sessions={[sessionFixture()]}
        items={[
          itemFixture({
            id: 'command-1',
            type: 'COMMAND_EXECUTION',
            payload: {
              command: "/bin/zsh -lc 'npm run typecheck /Users/rojhat/project/src/app.ts'",
              commandActions: [{ type: 'unknown' }],
              exitCode: 0,
              aggregatedOutput: 'secret output line'
            }
          })
        ]}
        planRevisions={[planFixture()]}
        interactions={[
          interactionFixture({
            type: 'COMMAND_APPROVAL',
            status: 'PENDING',
            request: { startedAtMs: 1, command: 'npm run typecheck' }
          })
        ]}
        events={[]}
      />
    );

    const rawIndex = html.indexOf('Raw protocol');
    expect(rawIndex).toBeGreaterThan(-1);
    const curatedHtml = html.slice(0, rawIndex);

    expect(curatedHtml).toContain('Plan history');
    expect(curatedHtml).toContain('Commands');
    expect(curatedHtml).toContain('Requests');
    expect(curatedHtml).toContain('Verify');
    expect(curatedHtml).toContain('command approval');
    expect(curatedHtml).not.toContain('/bin/zsh');
    expect(curatedHtml).not.toContain('/Users/rojhat/project');
    expect(curatedHtml).not.toContain('secret output line');

    expect(html).toContain('/bin/zsh');
    expect(html).toContain('secret output line');
  });

  it('shows path-free attachment submission evidence without claiming consumption', () => {
    const run = runFixture({
      status: 'COMPLETED',
      attachmentSubmissions: [
        {
          attachmentId: 'attachment-1',
          ordinal: 0,
          kind: 'image',
          mediaType: 'image/png',
          byteCount: 1_024,
          sha256: 'a'.repeat(64),
          submittedAs: 'localImage',
          verifiedAt: '2026-07-07T10:00:30.000Z',
          providerTurnId: 'turn-1',
          submittedAt: '2026-07-07T10:00:31.000Z'
        }
      ]
    });

    const html = renderToStaticMarkup(
      <ProviderActivityPanel
        runs={[run]}
        sessions={[sessionFixture()]}
        items={[]}
        planRevisions={[]}
        interactions={[]}
        events={[]}
      />
    );

    expect(html).toContain('Attachment submissions');
    expect(html).toContain('recorded after provider start');
    expect(html).toContain('does not prove that the model read or used a file');
    expect(html).toContain('sha256:aaaaaaaaaaaa…');
    expect(html).not.toContain('/attachment-deliveries/');
  });
});

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 0,
    ...overrides
  };
}

function sessionFixture(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'session-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    provider: 'codex',
    role: 'PRIMARY',
    providerSessionId: 'thread-1',
    relationshipState: 'RESOLVED',
    worktreePath: '/tmp/worktree',
    status: 'IDLE',
    materialized: true,
    requestedSettings: {},
    ownership: 'TASK_MONKI',
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides
  };
}

function planFixture(
  overrides: Partial<AgentPlanRevisionRecord> = {}
): AgentPlanRevisionRecord {
  return {
    id: 'plan-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    provider: 'codex',
    revision: 1,
    explanation: 'Plan',
    steps: [{ step: 'Verify', status: 'IN_PROGRESS' }],
    rawMessage: rawMessageFixture(),
    observedAt: '2026-07-07T10:01:00.000Z',
    ...overrides
  };
}

function itemFixture(overrides: Partial<AgentItemRecord> = {}): AgentItemRecord {
  return {
    id: 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: overrides.id ?? 'provider-item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: { text: 'Progress: Working.' },
    rawMessage: rawMessageFixture(),
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    providerCompletedAt: '2026-07-07T10:02:00.000Z',
    ...overrides
  };
}

function interactionFixture(
  overrides: Partial<InteractionRequestRecord> = {}
): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    serverInstanceId: 'server-1',
    providerRequestId: 'request-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: { startedAtMs: 1, command: 'npm run typecheck' },
    allowedActions: ['ACCEPT', 'DECLINE'],
    policyWarnings: [],
    requestRawMessage: rawMessageFixture(),
    requestedAt: '2026-07-07T10:01:30.000Z',
    ...overrides
  };
}

function rawMessageFixture() {
  return {
    serverInstanceId: 'server-1',
    sequence: 1,
    direction: 'INBOUND' as const,
    recordedAt: '2026-07-07T10:00:00.000Z',
    byteOffset: 0,
    byteLength: 1,
    sha256: 'hash'
  };
}
