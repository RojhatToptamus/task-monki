import type { BrowserWindowConstructorOptions } from 'electron';

export const TITLEBAR_HEIGHT = 52;

export type MainWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
>;

export function getMainWindowChromeOptions(
  platform: NodeJS.Platform
): MainWindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 17 }
    };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: TITLEBAR_HEIGHT
    }
  };
}
