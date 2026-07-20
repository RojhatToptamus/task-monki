import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavItem } from './App';

describe('collapsed navigation semantics', () => {
  it('describes a task count once without putting it in the item name', () => {
    const html = renderToStaticMarkup(
      <NavItem
        label="Inbox"
        icon={<span aria-hidden="true">icon</span>}
        count={16}
        urgent
        active={false}
        collapsed
        onClick={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Inbox"');
    expect(html).toContain('data-tip="Inbox"');
    expect(html).toMatch(/aria-describedby="([^"]+)"/);
    expect(html).toContain('aria-hidden="true">16</span>');
    expect(html).toContain('>16 tasks</span>');
    expect(html).not.toContain('aria-label="Inbox, 16 tasks"');
  });

  it('does not add an empty task-count description', () => {
    const html = renderToStaticMarkup(
      <NavItem
        label="Settings"
        icon={<span aria-hidden="true">icon</span>}
        active
        collapsed
        onClick={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('tm-nav__count');
  });
});
