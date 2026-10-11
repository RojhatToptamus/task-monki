const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A compact age for list rows: "now", "4m", "3h", "2d", then the date. Rows
 * compare ages at a glance; the exact time belongs in the element's title.
 */
export function formatShortAge(iso: string, now: number = Date.now()): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
