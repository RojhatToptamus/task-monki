import type { ReviewFileOrder } from './reviewOrder';

/**
 * Two small Review tab conveniences kept in local storage: the file order the
 * person prefers, and whether the brief is folded for a task's current round.
 * Losing either only resets the view.
 */
const ORDER_KEY = 'task-monki.review-order.v1';
const BRIEF_KEY = 'task-monki.review-brief.v1';
const MAX_TASKS = 60;

export function readReviewFileOrder(): ReviewFileOrder {
  try {
    return window.localStorage.getItem(ORDER_KEY) === 'path' ? 'path' : 'importance';
  } catch {
    return 'importance';
  }
}

export function writeReviewFileOrder(order: ReviewFileOrder): void {
  try {
    window.localStorage.setItem(ORDER_KEY, order);
  } catch {
    // Storage can be unavailable; the order is a convenience.
  }
}

type BriefStore = Record<string, { at: number; round: string }>;

function readBriefStore(): BriefStore {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BRIEF_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as BriefStore) : {};
  } catch {
    return {};
  }
}

/** The brief opens on the first visit to a round, then stays folded once the person folds it. */
export function readBriefFolded(taskId: string, round: string): boolean {
  return readBriefStore()[taskId]?.round === round;
}

export function writeBriefFolded(taskId: string, round: string, folded: boolean): void {
  try {
    const store = readBriefStore();
    if (folded) store[taskId] = { at: Date.now(), round };
    else delete store[taskId];
    const kept = Object.entries(store).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_TASKS);
    window.localStorage.setItem(BRIEF_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage can be unavailable; folding is a convenience.
  }
}
