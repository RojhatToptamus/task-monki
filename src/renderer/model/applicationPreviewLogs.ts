/** Retain complete UTF-8 characters within the same bound as the runtime reader. */
export function appendApplicationLog(previous: string, next: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(previous + next);
  let start = Math.max(0, bytes.length - 65_536);
  const truncated = start > 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated };
}
