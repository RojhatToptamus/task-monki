/**
 * A time a platform reported, as the store keeps every time: canonical ISO
 * with milliseconds. GitHub writes `2026-10-17T00:51:22Z`; a value that is not
 * a time is no value.
 */
export function canonicalPlatformTime(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
