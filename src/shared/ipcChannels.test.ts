import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_INVOKE_CHANNELS } from './ipcChannels';

const repositoryRoot = process.cwd();

function channelsIn(source: string, call: string): string[] {
  const pattern = new RegExp(`${call}\\(\\s*'([^']+)'`, 'gu');
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

describe('Electron IPC channel manifest', () => {
  it('is unique and sorted so channel changes produce stable reviews', () => {
    const channels = [...IPC_INVOKE_CHANNELS];
    expect(channels).toEqual([...new Set(channels)].sort());
  });

  it('matches both the preload bridge and trusted main-process handlers', () => {
    const preload = fs.readFileSync(
      path.join(repositoryRoot, 'src/electron/preload.ts'),
      'utf8'
    );
    const main = fs.readFileSync(
      path.join(repositoryRoot, 'src/electron/main.ts'),
      'utf8'
    );

    expect(channelsIn(preload, 'invokeIpc')).toEqual([...IPC_INVOKE_CHANNELS]);
    expect(channelsIn(main, 'handleTrustedIpc')).toEqual([
      ...IPC_INVOKE_CHANNELS
    ]);
  });
});
