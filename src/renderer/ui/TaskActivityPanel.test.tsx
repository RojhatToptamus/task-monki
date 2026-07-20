import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskActivityPanel, formatTaskActivityTimestamp } from './TaskActivityPanel';

describe('Activity Timeline timestamp formatting', () => {
  it('uses stable absolute local date and time labels', () => {
    const timestamp = formatTaskActivityTimestamp('2026-07-02T10:05:00.000Z');

    expect(timestamp.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timestamp.time).toMatch(/^\d{2}:\d{2}$/);
    expect(timestamp.full).toBe(`${timestamp.date} ${timestamp.time}`);
    expect(`${timestamp.date} ${timestamp.time}`).not.toMatch(/now|^\d+m$/i);
  });

  it('does not describe invalid timestamps as recent activity', () => {
    expect(formatTaskActivityTimestamp('not-a-date')).toEqual({
      date: 'Unknown',
      time: '',
      full: 'Unknown time'
    });
  });

  it('keeps actionable evidence collapsed and avoids badge-style status duplication', () => {
    const html = renderToStaticMarkup(
      <TaskActivityPanel
        variant="overview"
        view={{
          hiddenCount: 0,
          totalCount: 1,
          items: [
            {
              id: 'item-1',
              at: '2026-07-02T10:05:00.000Z',
              actor: 'GitHub',
              title: 'Checks failed',
              tone: 'error',
              category: 'delivery',
              evidence: {
                summary: '1 failed check blocks PR readiness.',
                rows: [
                  {
                    label: 'CI / lint-and-test',
                    value: 'Blocks PR readiness',
                    href: 'https://github.com/example/repo/actions/runs/1'
                  }
                ]
              }
            }
          ]
        }}
      />
    );

    expect(html).toContain('<details class="tm-taskactivity__details">');
    expect(html).toContain('<summary>1 failed check blocks PR readiness.</summary>');
    expect(html).toContain('CI / lint-and-test');
    expect(html).toContain('Blocks PR readiness');
    expect(html).not.toContain('tm-taskactivity__chip');
    expect(html).not.toContain('<summary>Details</summary>');
  });

  it('shows only the latest Overview item and accounts for bounded and hidden history', () => {
    const html = renderToStaticMarkup(
      <TaskActivityPanel
        variant="overview"
        onViewAll={() => {}}
        view={{
          hiddenCount: 2,
          totalCount: 4,
          items: [
            {
              id: 'older',
              at: '2026-07-02T10:04:00.000Z',
              actor: 'Task Monki',
              title: 'Worktree ready',
              tone: 'success',
              category: 'workflow'
            },
            {
              id: 'latest',
              at: '2026-07-02T10:05:00.000Z',
              actor: 'Review',
              title: 'Completed',
              tone: 'action',
              category: 'review'
            }
          ]
        }}
      />
    );

    expect(html).toContain('<h3 class="tm-panel__title">Activity</h3>');
    expect(html).toContain('Completed');
    expect(html).not.toContain('Worktree ready');
    expect(html).toContain('3 earlier items');
    expect(html).toContain('View full activity');
  });

  it('omits the Overview activity surface when there are no items', () => {
    const html = renderToStaticMarkup(
      <TaskActivityPanel
        variant="overview"
        view={{ hiddenCount: 0, totalCount: 0, items: [] }}
      />
    );

    expect(html).toBe('');
  });

  it('renders debug task activity with the same evidence rows and a separate raw audit', () => {
    const html = renderToStaticMarkup(
      <TaskActivityPanel
        variant="debug"
        view={{
          hiddenCount: 0,
          totalCount: 1,
          items: [
            {
              id: 'item-1',
              at: '2026-07-02T10:05:00.000Z',
              actor: 'GitHub',
              title: 'Checks failed',
              tone: 'error',
              category: 'delivery',
              evidence: {
                summary: '1 failed check blocks PR readiness.',
                rows: [{ label: 'CI / lint-and-test', value: 'Blocks PR readiness' }]
              }
            }
          ]
        }}
        rawEvents={[
          {
            id: 'event-1',
            type: 'TASK_CREATED',
            taskId: 'task-1',
            source: 'ui',
            sourceEventId: 'event-1',
            occurredAt: '2026-07-02T10:04:00.000Z',
            receivedAt: '2026-07-02T10:04:00.000Z',
            payload: { title: 'Add task activity' }
          },
          {
            id: 'event-2',
            type: 'CI_ROLLUP_CAPTURED',
            taskId: 'task-1',
            source: 'github',
            sourceEventId: 'event-2',
            occurredAt: '2026-07-02T10:05:00.000Z',
            receivedAt: '2026-07-02T10:05:00.000Z',
            payload: { status: 'FAILING' }
          }
        ]}
      />
    );

    expect(html).toContain('<h3>Task activity</h3>');
    expect(html).toContain('CI / lint-and-test');
    expect(html).toContain('Blocks PR readiness');
    expect(html).toContain('Full event audit · 2 events');
    expect(html).toContain('Task created');
    expect(html).toContain('Checks synced');
  });

  it('makes the Debug activity region programmatically focusable when a focus target is supplied', () => {
    const html = renderToStaticMarkup(
      <TaskActivityPanel
        variant="debug"
        rootRef={createRef<HTMLElement>()}
        view={{ hiddenCount: 0, totalCount: 0, items: [] }}
      />
    );

    expect(html).toContain('aria-label="Task activity"');
    expect(html).toContain('tabindex="-1"');
  });
});
