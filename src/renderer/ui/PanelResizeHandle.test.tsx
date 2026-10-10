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

  it('resizes rows with the vertical arrow keys and lets the owner define reset', () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <PanelResizeHandle
        label="Resize log rows"
        orientation="horizontal"
        value={200}
        min={120}
        max={360}
        defaultValue={240}
        onChange={onChange}
        onReset={onReset}
      />
    );
    const handle = screen.getByRole('separator', { name: 'Resize log rows' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true });
    fireEvent.doubleClick(handle);

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([216, 168]);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
  });
});
