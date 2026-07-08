import path from 'node:path';

export interface DockIconPathInput {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}

export function getMacDockIconPath(input: DockIconPathInput): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, 'icon.png');
  }

  return path.join(input.appPath, 'build', 'icon.png');
}
