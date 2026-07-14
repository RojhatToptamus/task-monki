import { describe, expect, it } from 'vitest';
import {
  analyzePreviewFrameworkCapabilities,
  PREVIEW_FRAMEWORK_CAPABILITIES_VERSION
} from './PreviewFrameworkCapabilities';

describe('Preview framework capabilities', () => {
  it('proves that a standard supported Next.js dev script accepts Task Monki PORT delivery', () => {
    const result = analyze({
      dependencies: { next: '15.5.2' },
      scripts: { dev: 'next dev --turbopack' }
    });

    expect(result.schemaVersion).toBe(PREVIEW_FRAMEWORK_CAPABILITIES_VERSION);
    expect(result.analyses).toEqual([
      expect.objectContaining({
        framework: 'nextjs',
        knowledgeVersion: 'nextjs-cli-15-16/v1',
        conflicts: [],
        compatiblePreviewCommand: ['npm', 'run', 'dev'],
        portBinding: { type: 'environment', name: 'PORT' },
        upstreamProtocol: 'http'
      })
    ]);
  });

  it('translates fixed-port HTTPS Next.js scripts to a local-only dynamic HTTP command', () => {
    const result = analyze({
      dependencies: { next: '^16.1.6' },
      scripts: { dev: 'next dev --turbopack --experimental-https -p 8000' }
    });

    expect(result.analyses[0]).toMatchObject({
      conflicts: [
        { code: 'HTTPS_LISTENER', argument: '--experimental-https' },
        { code: 'FIXED_PORT', argument: '-p 8000' }
      ],
      compatiblePreviewCommand: [
        'npm', 'exec', '--offline', '--', 'next', 'dev', '--turbopack',
        '--hostname', '127.0.0.1'
      ],
      yamlCommentLines: [
        "# The repository's existing development script pins port 8000 and enables",
        '# HTTPS. This Preview command intentionally uses standard HTTP and Task',
        "# Monki's dynamically allocated port."
      ]
    });
  });

  it.each([
    ['next dev --port 4100', 'FIXED_PORT'],
    ['next dev --port=4100', 'FIXED_PORT'],
    ['next dev -p4100', 'FIXED_PORT'],
    ['next dev -p=4100', 'FIXED_PORT'],
    ['next dev --experimental-https-cert certificate.pem', 'HTTPS_LISTENER'],
    ['next dev --hostname preview.example', 'INCOMPATIBLE_HOST']
  ])('detects runtime conflict in %s', (script, code) => {
    const analysis = analyze({
      dependencies: { next: '^15.5.2' },
      scripts: { dev: script }
    }).analyses[0];

    expect(analysis.conflicts.map((conflict) => conflict.code)).toContain(code);
    expect(analysis.compatiblePreviewCommand).toBeDefined();
  });

  it('fails closed for unknown arguments instead of inventing a rewrite', () => {
    const analysis = analyze({
      dependencies: { next: '^16.1.6' },
      scripts: { dev: 'next dev --experimental-upload-trace https://trace.example' }
    }).analyses[0];

    expect(analysis.conflicts).toContainEqual(expect.objectContaining({
      code: 'UNSUPPORTED_SCRIPT',
      argument: '--experimental-upload-trace'
    }));
    expect(analysis.compatiblePreviewCommand).toBeUndefined();
    expect(analysis.limitation).toContain('cannot be safely translated');
  });

  it('does not apply version knowledge outside its explicit support range', () => {
    const analysis = analyze({
      dependencies: { next: '^17.0.0' },
      scripts: { dev: 'next dev' }
    }).analyses[0];

    expect(analysis.compatiblePreviewCommand).toBeUndefined();
    expect(analysis.limitation).toContain('outside the trusted 15-16 capability range');
  });

  it('rejects ambiguous ranges that could select an unsupported major', () => {
    const analysis = analyze({
      dependencies: { next: '^16.1.6 || ^17.0.0' },
      scripts: { dev: 'next dev' }
    }).analyses[0];

    expect(analysis.compatiblePreviewCommand).toBeUndefined();
    expect(analysis.limitation).toContain('outside the trusted 15-16 capability range');
  });
});

function analyze(packageJson: Record<string, unknown>) {
  return analyzePreviewFrameworkCapabilities([
    { path: 'package.json', content: JSON.stringify(packageJson) }
  ]);
}
