import fs from 'node:fs';
import path from 'node:path';

export interface DesktopCliPathInput {
  platform: NodeJS.Platform;
  existingPath?: string;
  homeDir?: string;
  localAppData?: string;
}

export function buildDesktopCliPath(input: DesktopCliPathInput): string {
  const existingEntries = splitPath(input.existingPath);
  const commonEntries = commonCliDirectories(input.platform, input.localAppData);
  const userEntries = input.homeDir
    ? userCliDirectories(input.platform, input.homeDir)
    : [];

  return [...new Set([...userEntries, ...commonEntries, ...existingEntries])].join(
    path.delimiter
  );
}

function commonCliDirectories(
  platform: NodeJS.Platform,
  localAppData?: string
): string[] {
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  }
  if (platform === 'linux') {
    return ['/usr/local/bin', '/usr/bin', '/bin'];
  }
  return [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\GitHub CLI',
    ...(localAppData ? [path.join(localAppData, 'Programs', 'Git', 'cmd')] : [])
  ];
}

function userCliDirectories(platform: NodeJS.Platform, homeDir: string): string[] {
  if (platform !== 'darwin') return [];

  return [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.opencode', 'bin'),
    ...nvmNodeBinDirectories(homeDir)
  ];
}

function nvmNodeBinDirectories(homeDir: string): string[] {
  const versionsRoot = path.join(homeDir, '.nvm', 'versions', 'node');
  try {
    return fs
      .readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareNodeVersionsDescending)
      .map((version) => path.join(versionsRoot, version, 'bin'));
  } catch {
    return [];
  }
}

function compareNodeVersionsDescending(left: string, right: string): number {
  const leftParts = left.slice(1).split('.').map(Number);
  const rightParts = right.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = rightParts[index]! - leftParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function splitPath(value?: string): string[] {
  return (value ?? '').split(path.delimiter).filter(Boolean);
}
