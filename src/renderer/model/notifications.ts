export interface DedupeableNotification {
  tone: string;
  message: string;
}

/** Keep one visible copy of equivalent feedback while preserving newer notices. */
export function appendUniqueNotification<T extends DedupeableNotification>(
  current: readonly T[],
  next: T,
  maximumVisible = 3
): T[] {
  if (current.some((notification) =>
    notification.tone === next.tone && notification.message === next.message
  )) {
    return [...current];
  }
  return [...current.slice(-(maximumVisible - 1)), next];
}
