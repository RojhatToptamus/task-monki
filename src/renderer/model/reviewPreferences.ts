import type { ReviewFileOrder } from './reviewOrder';

/**
 * Review tab conveniences kept in local storage: the file order the person
 * prefers, the files they marked viewed, and whether the brief is folded for a
 * task's current round. Losing any of them only resets the view.
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

/** Each viewed file keeps its change signature, so a file that changes again reads as unviewed. */
const viewedFiles = taskLocalStore<Record<string, string>>('task-monki.review-viewed.v2');

export function readViewedFiles(taskId: string): Record<string, string> {
  const files = viewedFiles.get(taskId);
  return files && typeof files === 'object' ? { ...files } : {};
}

export function writeViewedFiles(taskId: string, files: Record<string, string>): void {
  viewedFiles.set(taskId, Object.keys(files).length > 0 ? files : undefined);
}

const foldedBriefRounds = taskLocalStore<string>('task-monki.review-brief.v2');

/** The brief opens on the first visit to a round, then stays folded once the person folds it. */
export function readBriefFolded(taskId: string, round: string): boolean {
  return foldedBriefRounds.get(taskId) === round;
}

export function writeBriefFolded(taskId: string, round: string, folded: boolean): void {
  foldedBriefRounds.set(taskId, folded ? round : undefined);
}
