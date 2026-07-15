import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../shared/contracts';
import { AgentControlPanel } from './AgentControlPanel';

describe('AgentControlPanel', () => {
  it('makes retry the primary recovery action after an implementation failure', () => {
    const html = renderToStaticMarkup(
      <AgentControlPanel
        run={runFixture({ status: 'FAILED', terminalReason: 'Provider rejected the turn.' })}
        interactions={[]}
        onSteer={async () => {}}
        onInterrupt={async () => {}}
        onContinue={async () => {}}
        onRetry={async () => {}}
      />
    );

    expect(html).toContain('Run failed');
    expect(html).toContain('Retry in this session or continue from the current worktree state.');
    expect(html).toMatch(/class="primary-button"[^>]*>Retry in session<\/button>/);
    expect(html.indexOf('Retry in session')).toBeLessThan(html.indexOf('>Continue<'));
    expect(html).not.toContain('Run review');
  });

  it('does not describe provider-state recovery as agent review', () => {
    const html = renderToStaticMarkup(
      <AgentControlPanel
        run={runFixture({
          status: 'RECOVERY_REQUIRED',
          recoveryState: 'REQUIRES_USER_ACTION',
          terminalReason: 'The provider turn outcome is ambiguous.'
        })}
        interactions={[]}
        onSteer={async () => {}}
        onInterrupt={async () => {}}
        onContinue={async () => {}}
        onRetry={async () => {}}
      />
    );

    expect(html).toContain('Recovery requires action');
    expect(html).not.toContain('Recovery requires review');
    expect(html).not.toContain('Run review');
  });
});

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runtimeId: 'opencode',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'FAILED',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T10:00:01.000Z',
    eventCount: 0,
    ...overrides
  };
}
