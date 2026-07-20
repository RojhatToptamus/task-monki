import { describe, expect, it } from 'vitest';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
import {
  appendDiscourseDelta,
  createDiscourseDeltaAccumulator,
  drainDiscourseDeltas
} from './DiscourseDeltaAccumulator';

describe('Discourse delta accumulator', () => {
  it('coalesces small deltas into one bounded publication', () => {
    let state = createDiscourseDeltaAccumulator('job-1', 1);
    state = appendDiscourseDelta(state, { jobId: 'job-1', attempt: 1, text: 'Hello ' }).state;
    state = appendDiscourseDelta(state, { jobId: 'job-1', attempt: 1, text: 'world' }).state;

    const drained = drainDiscourseDeltas(state);
    expect(drained.publication).toEqual({
      kind: 'DELTAS',
      text: 'Hello world',
      byteCount: 11,
      eventCount: 2
    });
    expect(drained.state.pendingBytes).toBe(0);
  });

  it('switches to a compact visible-draft snapshot under backpressure', () => {
    let state = createDiscourseDeltaAccumulator('job-1', 1);
    for (let index = 0; index < 300; index += 1) {
      state = appendDiscourseDelta(state, {
        jobId: 'job-1',
        attempt: 1,
        text: 'x'.repeat(160)
      }).state;
    }

    expect(state.publicationMode).toBe('SNAPSHOT');
    expect(state.pendingEventCount).toBe(1);
    expect(state.pendingBytes).toBeLessThanOrEqual(DISCOURSE_LIMITS.maxAgentContributionBytes);
    const publication = drainDiscourseDeltas(state).publication;
    expect(publication).toMatchObject({ kind: 'SNAPSHOT' });
  });

  it('caps the visible draft at a UTF-8 boundary and marks it incomplete', () => {
    let state = createDiscourseDeltaAccumulator('job-1', 1);
    state = appendDiscourseDelta(state, {
      jobId: 'job-1',
      attempt: 1,
      text: '🙂'.repeat(DISCOURSE_LIMITS.maxAgentContributionBytes)
    }).state;

    expect(Buffer.byteLength(state.visibleDraft, 'utf8')).toBe(
      DISCOURSE_LIMITS.maxAgentContributionBytes
    );
    expect(state.truncated).toBe(true);
    expect(state.visibleDraft.endsWith('🙂')).toBe(true);
  });

  it('discards late deltas from another attempt without changing state', () => {
    const state = createDiscourseDeltaAccumulator('job-1', 2);
    const late = appendDiscourseDelta(state, {
      jobId: 'job-1',
      attempt: 1,
      text: 'stale'
    });
    expect(late).toEqual({ state, accepted: false });
  });
});
