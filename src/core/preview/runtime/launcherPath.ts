import path from 'node:path';

export function resolveNativePreviewLauncherPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'native-preview-launcher.mjs')
    : path.join(input.appPath, 'src/core/preview/runtime/native-preview-launcher.mjs');
}

export function resolveManagedDesignStaticServerPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'managed-design-static-server.mjs')
    : path.join(
        input.appPath,
        'src/core/preview/runtime/managed-design-static-server.mjs'
      );
}
