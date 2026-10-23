import type { ReviewMode } from './reviewNavigation';
import type { ReviewFileOrder } from './reviewOrder';

/**
 * Review tab conveniences kept in local storage: the file order the person
 * prefers, the files they marked viewed, whether the brief is folded for a
 * task's current round, and the mode they last read a task's review in. Losing
 * any of them only resets the view.
 */
const ORDER_KEY = 'task-monki.review-order.v1';

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

/** A per-task value in local storage, kept for the most recently written tasks only. */
function taskLocalStore<T>(key: string) {
  const maxTasks = 60;
  type Store = Record<string, { at: number; value: T }>;
  const read = (): Store => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (taskId: string): T | undefined => read()[taskId]?.value,
    set(taskId: string, value: T | undefined): void {
      try {
        const store = read();
        if (value === undefined) delete store[taskId];
        else store[taskId] = { at: Date.now(), value };
        const kept = Object.entries(store).sort(([, a], [, b]) => b.at - a.at).slice(0, maxTasks);
        window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
      } catch {
        // Storage can be unavailable; the value is a convenience.
      }
    }
  };
}

/**
 * Each viewed file keeps the signatures of its change as the modes read it
 * (`diffFileSignature`), so a file reads as viewed in a mode while its change
 * there is one of them, and as unviewed once it changes again.
 */
const viewedFiles = taskLocalStore<Record<string, string[]>>('task-monki.review-viewed.v3');

export function readViewedFiles(taskId: string): Record<string, string[]> {
  const files = viewedFiles.get(taskId);
  if (!files || typeof files !== 'object') return {};
  return Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])));
}

export function writeViewedFiles(taskId: string, files: Record<string, string[]>): void {
  viewedFiles.set(taskId, Object.keys(files).length > 0 ? files : undefined);
}

const reviewModes = taskLocalStore<ReviewMode>('task-monki.review-mode.v1');

/** The mode the person last read this task's review in, if they chose one. */
export function readReviewMode(taskId: string): ReviewMode | undefined {
  const mode = reviewModes.get(taskId);
  return mode === 'guide' || mode === 'diff' ? mode : undefined;
}

export function writeReviewMode(taskId: string, mode: ReviewMode): void {
  reviewModes.set(taskId, mode);
}

const foldedBriefRounds = taskLocalStore<string>('task-monki.review-brief.v2');

/** The brief opens on the first visit to a round, then stays folded once the person folds it. */
export function readBriefFolded(taskId: string, round: string): boolean {
  return foldedBriefRounds.get(taskId) === round;
}

export function writeBriefFolded(taskId: string, round: string, folded: boolean): void {
  foldedBriefRounds.set(taskId, folded ? round : undefined);
}
