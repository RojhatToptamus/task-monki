import { describe, expect, it } from 'vitest';
import {
  MASCOT_VIDEO_SOURCES,
  getMascotStateForTask,
  type MascotState,
  type MascotTaskStateInput
} from './mascotState';

const baseInput: MascotTaskStateInput = {
  workflowPhase: 'READY',
  agentRun: 'IDLE',
  reviewStatus: 'NOT_RUN'
};

function mascot(overrides: Partial<MascotTaskStateInput>): MascotState {
  return getMascotStateForTask({ ...baseInput, ...overrides });
}

describe('getMascotStateForTask', () => {
  it.each([
    ['idle', 'assets/brand/videos/mascot-idle.webm'],
    ['working', 'assets/brand/videos/mascot-working.webm'],
    ['watching-checks', 'assets/brand/videos/mascot-watching-checks.webm'],
    ['reviewing', 'assets/brand/videos/mascot-reviewing.webm'],
    ['needs-you', 'assets/brand/videos/mascot-needs-you.webm'],
    ['ready-for-review', 'assets/brand/videos/mascot-ready-for-review.webm'],
    ['waiting', 'assets/brand/videos/mascot-waiting.webm'],
    ['done', 'assets/brand/videos/mascot-done.webm'],
    ['failed', 'assets/brand/videos/mascot-failed.webm']
  ] satisfies Array<[MascotState, string]>)('maps %s to an app asset', (state, source) => {
    expect(MASCOT_VIDEO_SOURCES[state]).toBe(source);
  });

  it('keeps ready and backlog tasks idle', () => {
    expect(mascot({ workflowPhase: 'READY' })).toBe('idle');
    expect(mascot({ workflowPhase: 'BACKLOG' })).toBe('idle');
  });

  it('uses the done mascot only for the explicit Done workflow phase', () => {
    expect(mascot({ workflowPhase: 'DONE' })).toBe('done');

    expect(
      mascot({
        workflowPhase: 'REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'READY_TO_MERGE'
      })
    ).toBe('waiting');
  });

  it('maps user-decision states to the needs-you mascot', () => {
    expect(mascot({ agentRun: 'AWAITING_APPROVAL' })).toBe('needs-you');
    expect(mascot({ agentRun: 'AWAITING_USER_INPUT' })).toBe('needs-you');
    expect(mascot({ workflowPhase: 'REVIEW', reviewStatus: 'NEEDS_CHANGES' })).toBe('needs-you');
  });

  it('maps active work without consulting delivery status', () => {
    expect(
      mascot({
        workflowPhase: 'IN_PROGRESS',
        agentRun: 'RUNNING',
        prStatusKind: 'CHECKS_FAILED'
      })
    ).toBe('working');
  });

  it('keeps interrupted in-progress work in a waiting state', () => {
    expect(mascot({ workflowPhase: 'IN_PROGRESS', agentRun: 'INTERRUPTING' })).toBe('waiting');
    expect(mascot({ workflowPhase: 'IN_PROGRESS', agentRun: 'INTERRUPTED' })).toBe('waiting');
  });

  it('maps review phases through review and PR status kinds', () => {
    expect(
      mascot({
        workflowPhase: 'IN_REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'CHECKS_PENDING'
      })
    ).toBe('watching-checks');
    expect(
      mascot({
        workflowPhase: 'IN_REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'GITHUB_CHANGES_REQUESTED'
      })
    ).toBe('needs-you');
    expect(
      mascot({
        workflowPhase: 'IN_REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'READY_TO_MERGE'
      })
    ).toBe('waiting');
    expect(mascot({ workflowPhase: 'REVIEW', reviewStatus: 'FAILED' })).toBe('failed');
    expect(mascot({ workflowPhase: 'REVIEW', reviewStatus: 'STALE' })).toBe('waiting');
  });

  it('does not let a merged PR status imply Task Monki completion', () => {
    expect(
      mascot({
        workflowPhase: 'IN_REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'MERGED'
      })
    ).toBe('waiting');
  });

  it('keeps active review work visible over older presentation state', () => {
    expect(
      mascot({
        workflowPhase: 'IN_REVIEW',
        reviewStatus: 'PASSED',
        prStatusKind: 'CHECKS_FAILED',
        reviewActive: true
      })
    ).toBe('reviewing');
  });

  it('maps error headers to the failed mascot', () => {
    expect(mascot({ agentRun: 'LOST' })).toBe('failed');
    expect(mascot({ workflowPhase: 'BLOCKED' })).toBe('failed');
  });
});
