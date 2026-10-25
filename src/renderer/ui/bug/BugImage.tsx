import { useEffect, useState } from 'react';
import { taskManagerApi } from '../../api/taskManagerClient';

/**
 * Kept screenshots as object URLs, shared by every surface that shows one: the Overview's pair,
 * the compare dialog and a replay's drawer read a file once. Unused URLs stay for the next
 * surface, at most `UNUSED_LIMIT` of them, and are revoked when they fall out.
 */
const UNUSED_LIMIT = 6;

interface CachedImage {
  url?: string;
  failed: boolean;
  loading?: Promise<void>;
  users: number;
  lastUsed: number;
  listeners: Set<() => void>;
}

const images = new Map<string, CachedImage>();

function evictUnused(): void {
  const unused = [...images.entries()].filter(([, entry]) => entry.users === 0 && !entry.loading).sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [key, entry] of unused.slice(0, Math.max(0, unused.length - UNUSED_LIMIT))) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    images.delete(key);
  }
}

function acquire(taskId: string, fileId: string, onChange: () => void): { entry: CachedImage; release(): void } {
  const key = `${taskId}:${fileId}`;
  let entry = images.get(key);
  if (!entry) {
    entry = { failed: false, users: 0, lastUsed: Date.now(), listeners: new Set() };
    images.set(key, entry);
    const loading = entry;
    loading.loading = taskManagerApi.readBugReplayImage({ taskId, fileId }).then(
      (image) => {
        loading.url = URL.createObjectURL(new Blob([Uint8Array.from(image.data)], { type: image.mimeType }));
      },
      () => {
        loading.failed = true;
      }
    ).finally(() => {
      loading.loading = undefined;
      for (const listener of loading.listeners) listener();
      evictUnused();
    });
  }
  const held = entry;
  held.users += 1;
  held.lastUsed = Date.now();
  held.listeners.add(onChange);
  return {
    entry: held,
    release() {
      held.users -= 1;
      held.lastUsed = Date.now();
      held.listeners.delete(onChange);
      // A read that failed is tried again by the next surface that shows the file.
      if (held.failed && held.users === 0 && images.get(key) === held) images.delete(key);
      evictUnused();
    }
  };
}

/** A kept screenshot's object URL, read once and shared while any surface shows it. */
export function useBugImage(taskId: string, fileId: string): { url?: string; failed: boolean } {
  const [state, setState] = useState<{ key: string; url?: string; failed: boolean }>({ key: '', failed: false });
  useEffect(() => {
    const key = `${taskId}:${fileId}`;
    let held: ReturnType<typeof acquire> | undefined;
    const sync = () => {
      if (!held) return;
      setState({ key, ...(held.entry.url ? { url: held.entry.url } : {}), failed: held.entry.failed });
    };
    held = acquire(taskId, fileId, sync);
    sync();
    return () => held?.release();
  }, [taskId, fileId]);
  // A new file shows nothing of the old one while it loads.
  return state.key === `${taskId}:${fileId}` ? { ...(state.url ? { url: state.url } : {}), failed: state.failed } : { failed: false };
}
