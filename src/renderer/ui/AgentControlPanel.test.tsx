import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '../../testSupport/rendererRecords';
import { AgentControlPanel } from './AgentControlPanel';

describe('AgentControlPanel', () => {
  it('renders the controls selected by the post-run action model', () => {
    const cases = [
      {
        name: 'running',
        run: makeRunRecord({ status: 'RUNNING' }),
        includes: ['Add instruction'],
        excludes: ['Stop run', 'Retry implementation', 'Run review']
      },
      {
        name: 'failed',
        run: makeRunRecord({ status: 'FAILED', endedAt: '2026-07-19T12:01:00.000Z' }),
        includes: ['Retry implementation', 'Continue work', 'Fork alternative'],
        excludes: ['Run review']
      },
      {
        name: 'recovery required',
        run: makeRunRecord({
          status: 'RECOVERY_REQUIRED',
          recoveryState: 'REQUIRES_USER_ACTION',
          endedAt: '2026-07-19T12:01:00.000Z'
        }),
        includes: ['Recovery requires action', 'Continue work', 'Retry implementation'],
        excludes: ['Recovery requires review', 'Run review']
      },
      {
        name: 'completed',
        run: makeRunRecord({ status: 'COMPLETED', endedAt: '2026-07-19T12:01:00.000Z' }),
        includes: ['Follow up', 'Fork alternative'],
        excludes: ['Retry implementation', 'Run review']
      }
    ];

    for (const testCase of cases) {
      const html = renderPanel(testCase.run);
      for (const value of testCase.includes) expect(html, testCase.name).toContain(value);
      for (const value of testCase.excludes) expect(html, testCase.name).not.toContain(value);
    }

    const locallyBlocked = renderPanel(
      makeRunRecord({ status: 'COMPLETED', endedAt: '2026-07-19T12:01:00.000Z' }),
      true
    );
    expect(locallyBlocked).toContain('Retry implementation');
    expect(locallyBlocked).not.toContain('Follow up');
  });
});

function renderPanel(run: ReturnType<typeof makeRunRecord>, requiresRecovery = false): string {
  return renderToStaticMarkup(
    <AgentControlPanel
      run={run}
      requiresRecovery={requiresRecovery}
      interactions={[]}
      onSteer={async () => {}}
      onInterrupt={async () => {}}
      onContinue={async () => {}}
      onRetry={async () => {}}
    />
  );
}
