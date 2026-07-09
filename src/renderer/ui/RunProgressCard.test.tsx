import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunProgressViewModel } from '../model/runProgress';
import { RunProgressCard } from './RunProgressCard';

describe('RunProgressCard', () => {
  it('renders the live plan, activity tail, and debug output link for running runs', () => {
    const html = renderToStaticMarkup(
      <RunProgressCard
        progress={{
          ...progressFixture(),
          state: 'RUNNING',
          headerLabel: 'Running',
          activityTail: [
            {
              key: 'cmd:npm-test',
              category: 'verify',
              kind: 'command',
              icon: 'terminal',
              label: 'Running',
              detail: 'npm test',
              detailKind: 'command',
              tone: 'action',
              status: 'active',
              at: '2026-07-07T10:00:02.000Z',
              sourceItemIds: ['item-1'],
              sourceInteractionIds: []
            }
          ],
          activityOutputSummary: 'show full output · 12 lines'
        }}
        runStartedAt="2026-07-07T10:00:00.000Z"
        scope="abc12345 · 2 files · dirty"
        onShowDebug={() => {}}
        onStop={() => {}}
        animate={false}
      />
    );

    expect(html).toContain('Agent progress');
    expect(html).toContain('abc12345 · 2 files · dirty');
    expect(html).toContain('Register route');
    expect(html).toContain('Activity');
    expect(html).toContain('Running');
    expect(html).toContain('npm test');
    expect(html).toContain('show full output · 12 lines');
    expect(html).toContain('Stop');
  });

  it('renders completed runs with the quiet footer and no live activity tail', () => {
    const html = renderToStaticMarkup(
      <RunProgressCard
        progress={{
          ...progressFixture(),
          runStatus: 'COMPLETED',
          state: 'COMPLETED',
          headerLabel: 'Completed',
          activityTail: [],
          footer: {
            title: 'Completed',
            detail: '10 files changed · verification not run',
            tone: 'success'
          }
        }}
        completedChangeSummary={<span>change summary</span>}
      />
    );

    expect(html).toContain('Completed: 10 files changed · verification not run');
    expect(html).toContain('change summary');
    expect(html).not.toContain('Activity');
  });
});

function progressFixture(): RunProgressViewModel {
  return {
    runId: 'run-1',
    runStatus: 'RUNNING',
    state: 'RUNNING',
    headerLabel: 'Running',
    steps: [
      { step: 'Explore existing files', status: 'COMPLETED' },
      { step: 'Register route', status: 'IN_PROGRESS' },
      { step: 'Verify tests', status: 'PENDING' }
    ],
    activityTail: [],
    footer: undefined
  };
}
