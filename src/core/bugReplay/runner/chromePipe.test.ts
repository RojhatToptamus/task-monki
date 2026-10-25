import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('Chrome for replays', () => {
  it('starts with the launch switches of the playwright-core that drives it', () => {
    // PLAYWRIGHT_163_CHROMIUM_SWITCHES is Playwright's own list, copied: connecting to a browser
    // launched without it can break Playwright features. Another version needs the list copied again.
    expect((require('playwright-core/package.json') as { version: string }).version).toBe('1.63.0');
  });
});
