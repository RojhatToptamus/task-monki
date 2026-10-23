import type { BrowserWindowConstructorOptions } from 'electron';

export const TITLEBAR_HEIGHT = 44;
const MAC_TRAFFIC_LIGHT_X = 18;
const MAC_TRAFFIC_LIGHT_HEIGHT = 14;
/**
 * The renderer's zoom until the person chooses another: the app opens at 125%.
 * A zoom they choose is kept for the page across restarts.
 */
export const DEFAULT_ZOOM_FACTOR = 1.25;

export type MainWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
>;

/** The renderer's titlebar, in window points, at `zoomFactor`. */
function zoomedTitlebarHeight(zoomFactor: number): number {
  return TITLEBAR_HEIGHT * (Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : DEFAULT_ZOOM_FACTOR);
}

export function getMacTrafficLightPosition(zoomFactor = DEFAULT_ZOOM_FACTOR): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_X,
    y: Math.max(0, Math.round((zoomedTitlebarHeight(zoomFactor) - MAC_TRAFFIC_LIGHT_HEIGHT) / 2))
  };
}

/** The native window controls' overlay on Windows and Linux, as tall as the renderer's titlebar. */
export function getTitleBarOverlayHeight(zoomFactor = DEFAULT_ZOOM_FACTOR): number {
  return Math.round(zoomedTitlebarHeight(zoomFactor));
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
      height: getTitleBarOverlayHeight()
    }
  };
}
