import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { describe, expect, it } from 'vitest';
import {
  rendererContentSecurityPolicy,
  VITE_REACT_REFRESH_PREAMBLE_SOURCE
} from './rendererSecurity';

describe('rendererContentSecurityPolicy', () => {
  it('blocks executable and framing surfaces for packaged renderers', () => {
    const policy = rendererContentSecurityPolicy();
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('https:');
  });

  it('adds only the exact development websocket origin for HMR', () => {
    const policy = rendererContentSecurityPolicy({
      developmentWebSocketOrigin: 'ws://127.0.0.1:5173',
      developmentScriptSources: [VITE_REACT_REFRESH_PREAMBLE_SOURCE]
    });
    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:5173");
    expect(policy).toContain(
      `script-src 'self' ${VITE_REACT_REFRESH_PREAMBLE_SOURCE}`
    );
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain('ws:;');
  });

  it('pins the installed Vite React preamble instead of allowing arbitrary inline scripts', () => {
    const preamble = react.preambleCode.replace('__BASE__', '/');
    const actual = `'sha256-${createHash('sha256').update(preamble).digest('base64')}'`;

    expect(actual).toBe(VITE_REACT_REFRESH_PREAMBLE_SOURCE);
    expect(() =>
      rendererContentSecurityPolicy({ developmentScriptSources: ["'unsafe-inline'"] })
    ).toThrow('SHA-256');
  });
});
