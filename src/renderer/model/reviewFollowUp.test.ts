import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/contracts';
import { buildReviewFollowUpInstruction } from './reviewFollowUp';

describe('buildReviewFollowUpInstruction', () => {
  const task = {
    id: 'task-1',
    title: 'Bound review output',
    projection: {
      agentReview: {
        status: 'INCONCLUSIVE',
        summary: 'Review needs operator judgment.'
      }
    }
  } as unknown as Task;

  it('uses only explicitly supplied review content', () => {
    const withoutAvailableContent = buildReviewFollowUpInstruction(
      task,
      task.projection.agentReview!,
      undefined,
      []
    );
    expect(withoutAvailableContent).not.toContain('Task Monki omitted');
    expect(withoutAvailableContent).not.toContain('Review output:');

    const availableArtifact = buildReviewFollowUpInstruction(
      task,
      task.projection.agentReview!,
      'complete retained review output',
      []
    );
    expect(availableArtifact).toContain(
      'Review output:\ncomplete retained review output'
    );
  });
});
