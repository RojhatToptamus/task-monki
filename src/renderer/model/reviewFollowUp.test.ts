import { describe, expect, it } from 'vitest';
import { makeTaskRecord } from '../../testSupport/rendererRecords';
import { buildReviewFollowUpInstruction } from './reviewFollowUp';

describe('buildReviewFollowUpInstruction', () => {
  it('uses only explicitly supplied review content', () => {
    const task = makeTaskRecord({
      title: 'Bound review output',
      workflowPhase: 'REVIEW',
      projection: {
        agentReview: {
          status: 'INCONCLUSIVE',
          summary: 'Review needs operator judgment.'
        }
      }
    });

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
    expect(availableArtifact).toContain('Review output:\ncomplete retained review output');
  });

  it('includes only selected findings plus the operator note', () => {
    const task = makeTaskRecord({
      id: 'task-review',
      title: 'Review task',
      workflowPhase: 'REVIEW',
      projection: {
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
    });

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
