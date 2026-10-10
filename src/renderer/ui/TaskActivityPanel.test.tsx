import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskActivityViewModel } from '../model/taskActivity';
import { TaskActivityPanel, formatTaskActivityTimestamp } from './TaskActivityPanel';

describe('Activity Timeline timestamp formatting', () => {
  it('uses stable absolute local date and time labels', () => {
    const timestamp = formatTaskActivityTimestamp('2026-07-02T10:05:00.000Z');

    expect(timestamp.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timestamp.time).toMatch(/^\d{2}:\d{2}$/);
    expect(timestamp.full).toBe(`${timestamp.date} ${timestamp.time}`);
    expect(`${timestamp.date} ${timestamp.time}`).not.toMatch(/now|^\d+m$/i);
    // The compact label stays absolute: a day and a clock time, never "now" or "5m ago".
    expect(timestamp.label).toContain(timestamp.time);
    expect(timestamp.label).not.toMatch(/now|ago/i);
  });

  it('does not describe invalid timestamps as recent activity', () => {
    expect(formatTaskActivityTimestamp('not-a-date')).toEqual({
      date: 'Unknown',
      time: '',
      full: 'Unknown time',
      label: 'Unknown time'
    });
  });

  it('keeps evidence in the full ledger, collapsed, and out of the Overview History', () => {
    const view: TaskActivityViewModel = {
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
    };
    const ledger = renderToStaticMarkup(<TaskActivityPanel variant="debug" view={view} />);
    expect(ledger).toContain('<details');
    expect(ledger).toContain('<span>1 failed check blocks PR readiness.</span>');
    expect(ledger).toContain('CI / lint-and-test');
    expect(ledger).not.toContain('<summary>Details</summary>');

    // The Overview says what happened, who and when; its Now panel owns the evidence.
    const overview = renderToStaticMarkup(<TaskActivityPanel variant="overview" view={view} />);
    expect(overview).toContain('Checks failed');
    expect(overview).not.toContain('<details');
    expect(overview).not.toContain('blocks PR readiness');
  });

  it('shows the latest Overview history in order with a way to the full ledger', () => {
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
              actor: 'Reviewer',
              title: 'Review completed',
              tone: 'action',
              category: 'review'
            }
          ]
        }}
      />
    );

    expect(html).toContain('>History</h3>');
    // Every bounded entry is visible, oldest first; nothing hides behind a disclosure.
    expect(html.indexOf('Worktree ready')).toBeLessThan(html.indexOf('Review completed'));
    expect(html).not.toContain('<details');
    expect(html).toContain('Full history');
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
