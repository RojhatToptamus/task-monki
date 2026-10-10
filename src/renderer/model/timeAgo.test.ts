import { describe, expect, it } from 'vitest';
import { formatShortAge } from './timeAgo';

describe('formatShortAge', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');

  it('steps from minutes to hours to days, and never shows a future age', () => {
    expect(formatShortAge('2026-10-10T11:59:30.000Z', now)).toBe('now');
    expect(formatShortAge('2026-10-10T12:00:30.000Z', now)).toBe('now');
    expect(formatShortAge('2026-10-10T11:46:00.000Z', now)).toBe('14m');
    expect(formatShortAge('2026-10-10T09:00:00.000Z', now)).toBe('3h');
    expect(formatShortAge('2026-10-08T12:00:00.000Z', now)).toBe('2d');
  });

  it('falls back to a date after a week and ignores unparseable input', () => {
    expect(formatShortAge('2026-09-01T12:00:00.000Z', now)).not.toMatch(/^\d+[mhd]$/);
    expect(formatShortAge('not a date', now)).toBeUndefined();
  });
});
