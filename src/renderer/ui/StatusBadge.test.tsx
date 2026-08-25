import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, StatusChip, StatusGlyph } from './StatusBadge';

describe('status presentation', () => {
  it('uses a shape-specific glyph instead of an abstract dot', () => {
    const waiting = renderToStaticMarkup(<Chip tone="action" label="Needs approval" />);
    const blocked = renderToStaticMarkup(<StatusGlyph kind="blocked" />);

    expect(waiting).toContain('tm-status-glyph--waiting');
    expect(waiting).toContain('lucide-circle-chevron-right');
    expect(blocked).toContain('tm-status-glyph--blocked');
    expect(blocked).toContain('lucide-circle-x');
    expect(waiting).not.toContain('status-pill__dot');
  });

  it('keeps dense status values as words and shows no mark for idle state', () => {
    const idle = renderToStaticMarkup(<Chip tone="neutral" label="Ready" />);
    const running = renderToStaticMarkup(
      <StatusChip label="Agent" value="RUNNING" />
    );

    expect(idle).not.toContain('tm-status-glyph');
    expect(running).not.toContain('tm-status-glyph');
    expect(running).toContain('Running');
  });
});
