import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface DesignBrowserRuntimePaths {
  executablePath: string;
  browserExecutablePath: string;
}

export function resolveDesignBrowserRuntimePaths(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  arch?: NodeJS.Architecture;
}): DesignBrowserRuntimePaths {
  const root = input.isPackaged
    ? path.join(input.resourcesPath, 'design-browser-runtime')
    : path.join(
        input.appPath,
        '.local',
        'design-browser-runtime',
        input.arch ?? process.arch
      );
  return {
    executablePath: path.join(root, 'agent-browser'),
    browserExecutablePath: path.join(
      root,
      'chrome',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    )
  };
}

export function resolveDesignBrowserSocketRoot(ownerRoot: string): string {
  const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const owner = createHash('sha256').update(path.resolve(ownerRoot)).digest('hex').slice(0, 4);
  return path.join(temporaryRoot, `tmd${user}-${owner}`);
}
