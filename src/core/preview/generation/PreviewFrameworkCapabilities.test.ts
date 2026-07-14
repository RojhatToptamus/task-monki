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
        knowledgeVersion: 'nextjs-cli-15-16/v2',
        conflicts: [],
        compatiblePreviewCommand: ['npm', 'run', 'dev'],
        dependencyPreparation: expect.objectContaining({
          installCommand: ['npm', 'ci', '--no-audit', '--no-fund'],
          lockfilePath: 'package-lock.json'
        }),
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
        './node_modules/.bin/next', 'dev', '--turbopack',
        '--hostname', '127.0.0.1'
      ],
      dependencyPreparation: {
        packageManager: 'npm',
        lockfilePath: 'package-lock.json',
        lockfileVersion: 3,
        cwd: '.',
        installCommand: ['npm', 'ci', '--no-audit', '--no-fund'],
        installCommandMayRunLifecycleScripts: true,
        repositoryLifecycleScripts: [],
        yamlCommentLines: [
          '# Installs exactly from package-lock.json inside this captured Preview generation.',
          '# npm may run repository and dependency lifecycle scripts.'
        ]
      },
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

  it('fails closed when dependency installation is not proven by a root lockfile', () => {
    const result = analyzePreviewFrameworkCapabilities([
      {
        path: 'package.json',
        content: JSON.stringify({
          dependencies: { next: '^16.1.6' },
          scripts: { dev: 'next dev' }
        })
      }
    ]);

    expect(result.analyses[0].compatiblePreviewCommand).toBeUndefined();
    expect(result.analyses[0].limitation).toContain('package-lock.json is missing');
  });

  it('fails closed for a stale lockfile or an unsupported package manager', () => {
    const packageJson = {
      dependencies: { next: '^16.1.6' },
      scripts: { dev: 'next dev' }
    };
    const stale = analyzePreviewFrameworkCapabilities(
      [{ path: 'package.json', content: JSON.stringify(packageJson) }],
      npmFacts('^15.5.2', '16.2.3')
    );
    const pnpm = analyzePreviewFrameworkCapabilities(
      [{
        path: 'package.json',
        content: JSON.stringify({ ...packageJson, packageManager: 'pnpm@10.0.0' })
      }],
      { rootLockfiles: ['pnpm-lock.yaml'], npmPackageLock: { status: 'MISSING', path: 'package-lock.json' } }
    );

    expect(stale.analyses[0].limitation).toContain('does not consistently lock');
    expect(pnpm.analyses[0].limitation).toContain('package manager pnpm');
  });

  it('reports repository install lifecycle scripts without inventing separate jobs', () => {
    const analysis = analyze({
      dependencies: { next: '^16.1.6' },
      scripts: {
        dev: 'next dev',
        preinstall: 'node scripts/preinstall.mjs',
        postinstall: 'node scripts/postinstall.mjs',
        unrelated: 'node scripts/unrelated.mjs'
      }
    }).analyses[0];

    expect(analysis.dependencyPreparation?.repositoryLifecycleScripts).toEqual([
      'preinstall',
      'postinstall'
    ]);
  });
});

function analyze(packageJson: Record<string, unknown>) {
  const next = (packageJson.dependencies as Record<string, unknown> | undefined)?.next ??
    (packageJson.devDependencies as Record<string, unknown> | undefined)?.next;
  const declared = typeof next === 'string' ? next : '';
  const locked = declared.startsWith('^16') || declared.startsWith('~16')
    ? '16.2.3'
    : declared.startsWith('^15') || declared.startsWith('~15')
      ? '15.5.2'
      : declared.replace(/^[~^]/, '');
  return analyzePreviewFrameworkCapabilities([
    { path: 'package.json', content: JSON.stringify(packageJson) }
  ], npmFacts(declared, locked));
}

function npmFacts(rootNextSpec: string, lockedNextVersion: string) {
  return {
    rootLockfiles: ['package-lock.json'] as const,
    npmPackageLock: {
      status: 'VALID' as const,
      path: 'package-lock.json' as const,
      lockfileVersion: 3 as const,
      rootNextSpec,
      lockedNextVersion
    }
  };
}
