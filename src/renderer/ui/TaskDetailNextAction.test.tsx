import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NextActionModel } from '../model/nextAction';
import {
  NextActionPanel,
  TaskWorkPanels,
  focusRequestedActivityHistory
} from './TaskDetail';

const moveToReview: NextActionModel = {
  sentence: 'Implementation finished. Move it to review to run the quality gate.',
  primary: { id: 'move-to-review', label: 'Move to review' },
  secondaries: []
};

describe('NextActionPanel', () => {
  it('keeps a disabled task-level action visible with an accessible reason', () => {
    const html = renderToStaticMarkup(
      <NextActionPanel
        placement="task"
        model={moveToReview}
        requirements={[]}
        onAction={() => {}}
        actionState={() => ({
          disabled: true,
          title: 'Another task action is in progress.'
        })}
      />
    );
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];

    expect(html).toContain('Move to review');
    expect(html).toContain('Another task action is in progress.');
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
  });
});

describe('TaskWorkPanels', () => {
  it('groups task work controls in a named region', () => {
    const html = renderToStaticMarkup(
      <TaskWorkPanels>
        <section className="tm-panel">
          <h3>Agent progress</h3>
        </section>
        <section className="tm-reviewcard">
          <h3>Review</h3>
        </section>
        <section className="card agent-controls">
          <h3>Agent</h3>
        </section>
      </TaskWorkPanels>
    );

    expect(html).toContain('aria-labelledby="task-work-panels-title"');
    expect(html).toContain('Progress, review, and agent controls');
    expect(html).toContain('Agent progress');
    expect(html).toContain('Review');
    expect(html).toContain('<h3>Agent</h3>');
  });
});

describe('activity history focus', () => {
  it('moves focus only after the activity navigation requests the Debug target', () => {
    const requested = { current: true };
    const focusCalls: string[] = [];
    const target = { focus: () => focusCalls.push('focus') };

    expect(focusRequestedActivityHistory('overview', requested, target)).toBe(false);
    expect(requested.current).toBe(true);
    expect(focusCalls).toEqual([]);

    expect(focusRequestedActivityHistory('debug', requested, target)).toBe(true);
    expect(requested.current).toBe(false);
    expect(focusCalls).toEqual(['focus']);

    expect(focusRequestedActivityHistory('debug', requested, target)).toBe(false);
    expect(focusCalls).toEqual(['focus']);
  });
});
