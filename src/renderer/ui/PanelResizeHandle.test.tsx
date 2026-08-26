// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelResizeHandle } from './PanelResizeHandle';

describe('PanelResizeHandle', () => {
  it('supports arrow, range, and reset interactions without owning panel state', () => {
    const onChange = vi.fn();
    render(
      <PanelResizeHandle
        label="Resize conversation"
        value={400}
        min={320}
        max={520}
        defaultValue={380}
        onChange={onChange}
      />
    );
    const handle = screen.getByRole('separator', { name: 'Resize conversation' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.doubleClick(handle);

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([416, 320, 380]);
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
  });
});
