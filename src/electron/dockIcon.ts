import path from 'node:path';

export interface DockIconPathInput {
  appPath: string;
  isPackaged: boolean;
}

export function getMacDockIconPath(input: DockIconPathInput): string | undefined {
  if (input.isPackaged) {
    return undefined;
  }

  return path.join(input.appPath, 'build', 'icon.png');
}
