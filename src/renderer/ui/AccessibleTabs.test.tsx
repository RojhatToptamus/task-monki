import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccessibleTab, nextTabIndex } from './AccessibleTabs';

describe('AccessibleTab', () => {
  it('exposes the selected tab and its controlled panel without merging a badge into the name', () => {
    const html = renderToStaticMarkup(
      <AccessibleTab
        id="debug-tab"
        panelId="debug-panel"
        label="Debug"
        selected
        badge="1"
        badgeAccessibleLabel="1 run"
        onSelect={() => undefined}
      />
    );

    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-controls="debug-panel"');
    expect(html).toContain('aria-label="Debug, 1 run"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-hidden="true">1</span>');
  });

  it('moves horizontally with wraparound and supports Home and End', () => {
    expect(nextTabIndex(0, 4, 'ArrowLeft')).toBe(3);
    expect(nextTabIndex(3, 4, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(2, 4, 'Home')).toBe(0);
    expect(nextTabIndex(1, 4, 'End')).toBe(3);
    expect(nextTabIndex(1, 4, 'ArrowDown')).toBeUndefined();
  });
});
