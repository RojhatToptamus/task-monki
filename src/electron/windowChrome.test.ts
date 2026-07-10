import { describe, expect, it } from 'vitest';
import {
  getMacTrafficLightPosition,
  getMainWindowChromeOptions,
  TITLEBAR_HEIGHT
} from './windowChrome';

describe('getMainWindowChromeOptions', () => {
  it('keeps native macOS traffic lights with a hidden inset titlebar', () => {
    expect(getMainWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 19 }
    });
  });

  it('keeps macOS traffic lights centered with scaled renderer controls', () => {
    expect(getMacTrafficLightPosition(0.25)).toEqual({ x: 18, y: 0 });
    expect(getMacTrafficLightPosition(0.8)).toEqual({ x: 18, y: 14 });
    expect(getMacTrafficLightPosition(1)).toEqual({ x: 18, y: 19 });
    expect(getMacTrafficLightPosition(1.25)).toEqual({ x: 18, y: 26 });
  });

  it('falls back to the default zoom for invalid scale values', () => {
    expect(getMacTrafficLightPosition(0)).toEqual({ x: 18, y: 19 });
    expect(getMacTrafficLightPosition(Number.NaN)).toEqual({ x: 18, y: 19 });
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
