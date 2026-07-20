import { describe, expect, it } from 'vitest';
import { assertSandboxedPreloadBundle } from './build-preload.mjs';

describe('sandboxed preload bundle verification', () => {
  it('accepts the Electron API and sandbox-supported Node modules', () => {
    expect(() =>
      assertSandboxedPreloadBundle(
        'const electron = require("electron"); const timers = require("timers");'
      )
    ).not.toThrow();
  });

  it('rejects relative imports that the sandboxed preload loader cannot resolve', () => {
    expect(() =>
      assertSandboxedPreloadBundle(
        'const electron = require("electron"); require("../shared/attachments");'
      )
    ).toThrow('unsupported require imports: ../shared/attachments');
  });

  it('rejects unsupported Node modules', () => {
    expect(() =>
      assertSandboxedPreloadBundle(
        'const electron = require("electron"); require("node:fs");'
      )
    ).toThrow('unsupported require imports: node:fs');
  });

  it('rejects a bundle that does not expose Electron APIs', () => {
    expect(() => assertSandboxedPreloadBundle('const value = 1;')).toThrow(
      'does not import Electron'
    );
  });
});
