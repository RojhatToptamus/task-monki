import { describe, expect, it } from 'vitest';
import { getMainWindowChromeOptions, TITLEBAR_HEIGHT } from './windowChrome';

describe('getMainWindowChromeOptions', () => {
  it('keeps native macOS traffic lights with a hidden inset titlebar', () => {
    expect(getMainWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 17 }
    });
  });

  it('uses native window controls overlay on Windows', () => {
    expect(getMainWindowChromeOptions('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: TITLEBAR_HEIGHT }
    });
  });

  it('uses native window controls overlay on Linux', () => {
    expect(getMainWindowChromeOptions('linux')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: TITLEBAR_HEIGHT }
    });
  });
});
