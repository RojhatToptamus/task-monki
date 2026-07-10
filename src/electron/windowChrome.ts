import type { BrowserWindowConstructorOptions } from 'electron';

export const TITLEBAR_HEIGHT = 52;
const MAC_TRAFFIC_LIGHT_X = 18;
const MAC_TRAFFIC_LIGHT_HEIGHT = 14;

export type MainWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
>;

export function getMacTrafficLightPosition(zoomFactor = 1): { x: number; y: number } {
  const normalizedZoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: MAC_TRAFFIC_LIGHT_X,
    y: Math.max(
      0,
      Math.round((TITLEBAR_HEIGHT * normalizedZoom - MAC_TRAFFIC_LIGHT_HEIGHT) / 2)
    )
  };
}

export function getMainWindowChromeOptions(
  platform: NodeJS.Platform
): MainWindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: getMacTrafficLightPosition()
    };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: TITLEBAR_HEIGHT
    }
  };
}
