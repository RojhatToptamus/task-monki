import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePackagedRuntime } from './verify-packaged-runtime.mjs';

describe('packaged runtime selection', () => {
  const releaseDir = path.resolve('release-test');

  it.each([
    ['darwin', 'x64', ['mac', 'Task Monki.app', 'Contents', 'MacOS', 'Task Monki']],
    ['darwin', 'arm64', ['mac-arm64', 'Task Monki.app', 'Contents', 'MacOS', 'Task Monki']],
    ['win32', 'x64', ['win-unpacked', 'Task Monki.exe']],
    ['linux', 'x64', ['linux-unpacked', 'task-monki']]
  ])('selects the %s/%s executable', (platform, arch, segments) => {
    expect(resolvePackagedRuntime({ platform, arch, releaseDir })).toBe(
      path.join(releaseDir, ...segments)
    );
  });

  it.each([
    ['darwin', 'ia32'],
    ['win32', 'arm64'],
    ['linux', 'arm64'],
    ['freebsd', 'x64']
  ])('rejects unsupported %s/%s runners', (platform, arch) => {
    expect(() => resolvePackagedRuntime({ platform, arch, releaseDir })).toThrow(
      `Unsupported packaged runtime platform: ${platform}/${arch}`
    );
  });
});
