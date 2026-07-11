import { describe, expect, it } from 'vitest';
import { buildPreviewEnvironment } from './PreviewEnvironment';

describe('PreviewEnvironment', () => {
  it('inherits only an allowlist and layers recipe and generated values explicitly', () => {
    const result = buildPreviewEnvironment({
      inherited: {
        PATH: '/bin',
        HOME: '/home/test',
        AWS_SECRET_ACCESS_KEY: 'do-not-inherit',
        GH_TOKEN: 'do-not-inherit'
      },
      recipe: { NODE_ENV: 'development' },
      generated: { PORT: '43123' },
      platform: 'darwin'
    });
    expect(result).toMatchObject({
      PATH: '/bin',
      HOME: '/home/test',
      NODE_ENV: 'development',
      PORT: '43123',
      TASK_MONKI_PREVIEW: '1'
    });
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.GH_TOKEN).toBeUndefined();
  });
});
