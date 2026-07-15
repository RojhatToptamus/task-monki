import { DISCOURSE_LIMITS } from '../../shared/discourse';

export interface DiscourseDeltaAccumulatorState {
  jobId: string;
  attempt: number;
  visibleDraft: string;
  pendingText: string;
  pendingBytes: number;
  pendingEventCount: number;
  publicationMode: 'DELTAS' | 'SNAPSHOT';
  truncated: boolean;
}

export type DiscourseDeltaPublication =
  | { kind: 'DELTAS'; text: string; byteCount: number; eventCount: number }
  | { kind: 'SNAPSHOT'; text: string; byteCount: number; truncated: boolean };

export function createDiscourseDeltaAccumulator(
  jobId: string,
  attempt: number
): DiscourseDeltaAccumulatorState {
  if (!jobId.trim() || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('Discourse delta accumulator identity is invalid.');
  }
  return {
    jobId,
    attempt,
    visibleDraft: '',
    pendingText: '',
    pendingBytes: 0,
    pendingEventCount: 0,
    publicationMode: 'DELTAS',
    truncated: false
  };
}

export function appendDiscourseDelta(
  state: DiscourseDeltaAccumulatorState,
  input: { jobId: string; attempt: number; text: string }
): { state: DiscourseDeltaAccumulatorState; accepted: boolean } {
  if (input.jobId !== state.jobId || input.attempt !== state.attempt) {
    return { state, accepted: false };
  }
  if (!input.text || state.truncated) return { state, accepted: false };
  const remaining = DISCOURSE_LIMITS.maxAgentContributionBytes - utf8Bytes(state.visibleDraft);
  const acceptedText = takeUtf8Prefix(input.text, remaining);
  const truncated = utf8Bytes(acceptedText) < utf8Bytes(input.text);
  const visibleDraft = `${state.visibleDraft}${acceptedText}`;
  const nextPendingText = `${state.pendingText}${acceptedText}`;
  const nextPendingBytes = utf8Bytes(nextPendingText);
  const nextEventCount = state.pendingEventCount + 1;
  const snapshotRequired =
    state.publicationMode === 'SNAPSHOT' ||
    nextPendingBytes > DISCOURSE_LIMITS.maxPendingDeltaBytesPerJob ||
    nextEventCount > DISCOURSE_LIMITS.maxDeltaEventsPerBatch;
  const next: DiscourseDeltaAccumulatorState = {
    ...state,
    visibleDraft,
    pendingText: snapshotRequired ? visibleDraft : nextPendingText,
    pendingBytes: snapshotRequired ? utf8Bytes(visibleDraft) : nextPendingBytes,
    pendingEventCount: snapshotRequired ? 1 : nextEventCount,
    publicationMode: snapshotRequired ? 'SNAPSHOT' : 'DELTAS',
    truncated
  };
  return { state: next, accepted: acceptedText.length > 0 };
}

export function drainDiscourseDeltas(state: DiscourseDeltaAccumulatorState): {
  state: DiscourseDeltaAccumulatorState;
  publication?: DiscourseDeltaPublication;
} {
  if (state.pendingEventCount === 0) return { state };
  const publication: DiscourseDeltaPublication =
    state.publicationMode === 'SNAPSHOT'
      ? {
          kind: 'SNAPSHOT',
          text: state.visibleDraft,
          byteCount: utf8Bytes(state.visibleDraft),
          truncated: state.truncated
        }
      : {
          kind: 'DELTAS',
          text: state.pendingText,
          byteCount: state.pendingBytes,
          eventCount: state.pendingEventCount
        };
  return {
    state: {
      ...state,
      pendingText: '',
      pendingBytes: 0,
      pendingEventCount: 0,
      publicationMode: 'DELTAS'
    },
    publication
  };
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const nextBytes = utf8Bytes(character);
    if (bytes + nextBytes > maxBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
