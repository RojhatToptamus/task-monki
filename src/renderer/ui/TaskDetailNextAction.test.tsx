import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialProjection, type Task } from '../../shared/contracts';
import type { NextActionModel } from '../model/nextAction';
import { buildReviewFollowUpInstruction } from '../model/reviewFollowUp';
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

    expect(html).toContain('tm-nextaction--task');
    expect(html).toContain('Move to review');
    expect(html).toContain('Another task action is in progress.');
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
  });

  it('does not create an empty description for an enabled action', () => {
    const html = renderToStaticMarkup(
      <NextActionPanel
        model={moveToReview}
        requirements={[]}
        onAction={() => {}}
        actionState={() => ({})}
      />
    );

    expect(html).toContain('tm-nextaction--rail');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('tm-nextaction__reason');
  });
});

describe('TaskWorkPanels', () => {
  it('groups independently styled panels in a named region while preserving heading order', () => {
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

    expect(html).toContain('class="tm-workpanels"');
    expect(html).toContain('aria-labelledby="task-work-panels-title"');
    expect(html).not.toContain('tm-runsurface');
    expect(html.indexOf('Progress, review, and agent controls')).toBeLessThan(
      html.indexOf('Agent progress')
    );
    expect(html.indexOf('Agent progress')).toBeLessThan(html.indexOf('Review'));
    expect(html.indexOf('Review')).toBeLessThan(html.indexOf('<h3>Agent</h3>'));
  });

  it('does not render a decorative container when no panels are available', () => {
    const html = renderToStaticMarkup(<TaskWorkPanels>{null}</TaskWorkPanels>);

    expect(html).toContain('class="tm-workpanels"');
    expect(html).not.toContain('tm-panel');
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

describe('review follow-up instruction', () => {
  it('builds the full instruction from selected findings and the optional note', () => {
    const task = reviewTask();
    const instruction = buildReviewFollowUpInstruction(
      task,
      task.projection.agentReview!,
      undefined,
      ['finding-major'],
      'Keep the public API unchanged.'
    );

    expect(instruction).toContain('[Major] Fix the listener');
    expect(instruction).not.toContain('Skip the unrelated cleanup');
    expect(instruction).toContain('Additional note:\nKeep the public API unchanged.');
  });
});

function reviewTask(): Task {
  const now = '2026-07-19T12:00:00.000Z';
  return {
    id: 'task-review',
    title: 'Review task',
    prompt: 'Implement the change.',
    repositoryId: 'repository-a',
    runtimeId: 'codex',
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: {
      ...createInitialProjection(now),
      agentReview: {
        status: 'NEEDS_CHANGES',
        result: {
          schemaVersion: 'agent-review/v1',
          verdict: 'NEEDS_CHANGES',
          summary: 'Address the selected issue.',
          findings: [
            {
              id: 'finding-major',
              severity: 'MAJOR',
              title: 'Fix the listener',
              explanation: 'The listener leaks.',
              recommendation: 'Remove it during cleanup.'
            },
            {
              id: 'finding-info',
              severity: 'NIT',
              title: 'Skip the unrelated cleanup',
              explanation: 'This is not selected.'
            }
          ]
        }
      }
    }
  };
}
