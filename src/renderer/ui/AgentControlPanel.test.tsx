import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../shared/contracts';
import { AgentControlPanel } from './AgentControlPanel';

describe('AgentControlPanel', () => {
  it('keeps steering in the Agent card while the progress header owns Stop', () => {
    const html = renderToStaticMarkup(
      <AgentControlPanel
        run={runFixture({ status: 'RUNNING', endedAt: undefined })}
        interactions={[]}
        onSteer={async () => {}}
        onInterrupt={async () => {}}
        onContinue={async () => {}}
        onRetry={async () => {}}
      />
    );

    expect(html).toContain('Add instruction');
    expect(html).not.toContain('Stop run');
  });

  it('makes Retry implementation primary after a definitive implementation failure', () => {
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
    expect(html).toContain(
      'Retry the original implementation or continue unfinished work from the current state.'
    );
    expect(html).toMatch(/class="primary-button"[^>]*>Retry implementation<\/button>/);
    expect(html.indexOf('Retry implementation')).toBeLessThan(html.indexOf('>Continue work<'));
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
    expect(html).toMatch(/class="primary-button"[^>]*>Continue work<\/button>/);
    expect(html).toContain('Retry implementation');
    expect(html).not.toContain('Run review');
  });

  it('makes retry primary when Task Monki blocks review after provider completion', () => {
    const html = renderToStaticMarkup(
      <AgentControlPanel
        run={runFixture({ status: 'COMPLETED' })}
        requiresRecovery
        interactions={[]}
        onSteer={async () => {}}
        onInterrupt={async () => {}}
        onContinue={async () => {}}
        onRetry={async () => {}}
      />
    );

    expect(html).toContain('Implementation needs another pass');
    expect(html).toMatch(/class="primary-button"[^>]*>Retry implementation<\/button>/);
    expect(html).not.toContain('Follow up');
    expect(html).not.toContain('Run review');
  });

  it('offers Follow up and Fork alternative, but not Retry, after successful completion', () => {
    const html = renderToStaticMarkup(
      <AgentControlPanel
        run={runFixture({ status: 'COMPLETED' })}
        interactions={[]}
        onSteer={async () => {}}
        onInterrupt={async () => {}}
        onContinue={async () => {}}
        onRetry={async () => {}}
      />
    );

    expect(html).toContain('Follow up');
    expect(html).toContain('Fork alternative');
    expect(html).not.toContain('Retry implementation');
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
