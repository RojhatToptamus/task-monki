import { describe, expect, it } from 'vitest';
import {
  getMacTrafficLightPosition,
  getMainWindowChromeOptions,
  getTitleBarOverlayHeight
} from './windowChrome';

describe('getMainWindowChromeOptions', () => {
  it('keeps native macOS traffic lights with a hidden inset titlebar, placed for the default zoom from the start', () => {
    expect(getMainWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 21 }
    });
  });

  it('keeps macOS traffic lights centered with scaled renderer controls', () => {
    expect(getMacTrafficLightPosition(0.25)).toEqual({ x: 18, y: 0 });
    expect(getMacTrafficLightPosition(0.8)).toEqual({ x: 18, y: 11 });
    expect(getMacTrafficLightPosition(1)).toEqual({ x: 18, y: 15 });
    expect(getMacTrafficLightPosition(1.25)).toEqual({ x: 18, y: 21 });
  });

  it('falls back to the default zoom for invalid scale values', () => {
    expect(getMacTrafficLightPosition(0)).toEqual({ x: 18, y: 21 });
    expect(getMacTrafficLightPosition(Number.NaN)).toEqual({ x: 18, y: 21 });
  });

  it('keeps the Windows and Linux controls overlay as tall as the zoomed titlebar', () => {
    expect(getTitleBarOverlayHeight(1)).toBe(44);
    expect(getTitleBarOverlayHeight(1.25)).toBe(55);
    expect(getTitleBarOverlayHeight(1.5)).toBe(66);
  });

  it('uses native window controls overlay on Windows and Linux, as tall as the titlebar at the default zoom', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(getMainWindowChromeOptions(platform)).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: { height: 55 }
      });
    }
  });
});
