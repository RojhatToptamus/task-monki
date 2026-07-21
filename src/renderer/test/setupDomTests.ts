import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => cleanup());

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
});

class TestResizeObserver implements ResizeObserver {
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
}

globalThis.ResizeObserver = TestResizeObserver;

// JSDOM has no layout engine. Treat mounted controls as visible so focus-trap
// tests exercise the component lifecycle instead of JSDOM's empty rectangles.
HTMLElement.prototype.getClientRects = function getClientRects() {
  return [{ width: 1, height: 1 }] as unknown as DOMRectList;
};

window.requestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(performance.now());
  return 1;
};
window.cancelAnimationFrame = () => undefined;
