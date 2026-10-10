/**
 * Files the user marked viewed in the Review tab, per task. Each entry keeps
 * the file's change signature, so a file that changes again reads as unviewed.
 * Stored locally and bounded; losing it only unfolds files.
 */
const STORAGE_KEY = 'task-monki.review-viewed.v1';
const MAX_TASKS = 60;

type ViewedStore = Record<string, { at: number; files: Record<string, string> }>;

function readStore(): ViewedStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as ViewedStore) : {};
  } catch {
    return {};
  }
}

export function readViewedFiles(taskId: string): Record<string, string> {
  const entry = readStore()[taskId];
  return entry && typeof entry.files === 'object' ? { ...entry.files } : {};
}

export function writeViewedFiles(taskId: string, files: Record<string, string>): void {
  try {
    const store = readStore();
    if (Object.keys(files).length === 0) delete store[taskId];
    else store[taskId] = { at: Date.now(), files };
    const kept = Object.entries(store).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_TASKS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage can be unavailable; viewed state is a convenience.
  }
}
