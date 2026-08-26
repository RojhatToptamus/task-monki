import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createIgnore, isJitCode, signingOptionsForFile } = require('./trusted-mac-sign.cjs');

const app = path.join('/tmp', 'Task Monki.app');
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-mac-sign-test-'));

afterAll(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

describe('trusted macOS entitlement policy', () => {
  it.each([
    app,
    path.join(app, 'Contents', 'MacOS', 'Task Monki'),
    helper('Task Monki Helper'),
    helper('Task Monki Helper (GPU)'),
    helper('Task Monki Helper (Renderer)'),
    chromeHelper('Google Chrome for Testing Helper (GPU)'),
    chromeHelper('Google Chrome for Testing Helper (Renderer)')
  ])('grants JIT only to a known JIT process: %s', (filePath) => {
    expect(isJitCode(filePath)).toBe(true);
    expect(path.basename(signingOptionsForFile(filePath).entitlements)).toBe(
      'entitlements.mac.jit.plist'
    );
  });

  it.each([
    helper('Task Monki Helper (Plugin)'),
    chromeHelper('Google Chrome for Testing Helper'),
    path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'),
    path.join(app, 'Contents', 'Resources', 'design-browser-runtime', 'agent-browser'),
    path.join(app, 'Contents', 'Resources', 'unknown-tool')
  ])('grants no exception to other code: %s', (filePath) => {
    expect(isJitCode(filePath)).toBe(false);
    expect(path.basename(signingOptionsForFile(filePath).entitlements)).toBe(
      'entitlements.mac.none.plist'
    );
  });

  it('sends only Mach-O files and bundle directories to codesign', () => {
    const machO = path.join(testDirectory, 'native-code');
    const data = path.join(testDirectory, 'Assets.car');
    const bundle = path.join(testDirectory, 'Nested.app');
    fs.writeFileSync(machO, Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
    fs.writeFileSync(data, Buffer.from('binary resource'));
    fs.mkdirSync(bundle);

    const ignore = createIgnore();
    expect(ignore(machO)).toBe(false);
    expect(ignore(data)).toBe(true);
    expect(ignore(bundle)).toBe(false);
  });
});

function helper(name) {
  return path.join(app, 'Contents', 'Frameworks', `${name}.app`);
}

function chromeHelper(name) {
  return path.join(
    app,
    'Contents',
    'Resources',
    'design-browser-runtime',
    'chrome',
    'Google Chrome for Testing.app',
    'Contents',
    'Frameworks',
    `${name}.app`
  );
}
