import { describe, expect, it } from 'vitest';
import { boundedPreviewFailure } from './PreviewFailure';

describe('boundedPreviewFailure', () => {
  it('normalizes failures to bounded single-line messages', () => {
    expect(boundedPreviewFailure(new Error('first\r\nsecond'))).toBe('first second');
    expect(boundedPreviewFailure('abcdef', { maxLength: 3 })).toBe('abc');
  });

  it('redacts before bounding the persisted value', () => {
    const secret = 'private-token';
    const value = boundedPreviewFailure(`${'x'.repeat(506)}${secret}`, {
      maxLength: 512,
      redact: (message) => message.replace(secret, '[REDACTED]')
    });

    expect(value).toBe(`${'x'.repeat(506)}[REDAC`);
    expect(value).not.toContain(secret.slice(0, 6));
  });
});
