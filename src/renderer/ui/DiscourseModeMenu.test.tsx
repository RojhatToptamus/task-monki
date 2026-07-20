import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DiscourseModeMenu } from './DiscourseModeMenu';

describe('DiscourseModeMenu', () => {
  it('exposes the current mode as a named menu trigger without a native select', () => {
    const html = renderToStaticMarkup(
      <DiscourseModeMenu
        value="DIRECT"
        disabled={false}
        teamReady
        onChange={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Response mode: Direct"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('lucide-message-square');
    expect(html).not.toContain('One selected agent');
    expect(html).not.toContain('<select');
  });
});
