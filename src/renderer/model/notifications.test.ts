import { describe, expect, it } from 'vitest';
import { appendUniqueNotification } from './notifications';

describe('appendUniqueNotification', () => {
  it('deduplicates concurrent equivalent feedback while preserving distinct notices', () => {
    const unavailable = {
      id: 'one',
      tone: 'error',
      message: 'The development API is unavailable.'
    };
    expect(appendUniqueNotification([unavailable], {
      ...unavailable,
      id: 'duplicate'
    })).toEqual([unavailable]);
    expect(appendUniqueNotification([unavailable], {
      id: 'two',
      tone: 'info',
      message: 'Trying again.'
    })).toHaveLength(2);
  });

  it('keeps the most recent distinct notifications within the visible bound', () => {
    const current = [1, 2, 3].map((id) => ({
      id: String(id),
      tone: 'info',
      message: `Notice ${id}`
    }));
    expect(appendUniqueNotification(current, {
      id: '4',
      tone: 'success',
      message: 'Notice 4'
    })).toEqual([...current.slice(1), expect.objectContaining({ id: '4' })]);
  });
});
