import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DiscourseModeMenu } from './DiscourseModeMenu';

describe('DiscourseModeMenu', () => {
  it('exposes the current mode as a named menu trigger without a native select', () => {
    const html = renderToStaticMarkup(
      <DiscourseModeMenu
        value="CHAT"
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Conversation: Chat"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('One selected agent');
    expect(html).not.toContain('<select');
  });
});
