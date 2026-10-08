import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_FRAMEWORK_CAPABILITIES_VERSION } from './PreviewFrameworkCapabilities';
import { preparePreviewRecipeEvidenceBundle } from './PreviewRecipeEvidenceBundle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('PreviewRecipeEvidenceBundle', () => {
  it('preserves framework-public configuration while concealing private bindings and leaving delivered logs intact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-context-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '16.2.3' } }));
    const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-context-evidence-'));
    roots.push(evidenceRoot);
    const bundle = await preparePreviewRecipeEvidenceBundle(root, {
      rootDirectory: evidenceRoot, generationId: 'context',
      configuration: { name: 'preview.yaml', text: 'name: app\ntype: command\ncwd: .\ncommand: [node, server.js]\nenv:\n  APP_ID: ordinary-looking-private-value\n  ACCESS: abc\n  NEXT_TELEMETRY_DISABLED: "1"\n  NEXT_PUBLIC_LABEL: browser-visible-value\n' },
      diagnostics: { logs: 'ordinary-looking-private-value is a filename in this different attempt\nstep 1 of 10\nAPP_ID=[REDACTED]' }
    });
    const context = JSON.parse(await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8')).preview;
    expect(context.configuration.env.APP_ID).toContain('concealed');
    expect(context.configuration.env.ACCESS).toContain('concealed');
    expect(context.configuration.env.NEXT_TELEMETRY_DISABLED).toBe('1');
    expect(context.configuration.env.NEXT_PUBLIC_LABEL).toBe('browser-visible-value');
    expect(context.diagnostics.logs).toBe('ordinary-looking-private-value is a filename in this different attempt\nstep 1 of 10\nAPP_ID=[REDACTED]');
    await bundle.dispose();
  });

  it('includes bounded source evidence while excluding likely secret-bearing files and contents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-evidence-test-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node src/server.mjs' } }),
      'utf8'
    );
    await fs.writeFile(path.join(root, 'src', 'server.mjs'), 'console.log("ready")\n', 'utf8');
    await fs.writeFile(path.join(root, '.env.local'), 'API_TOKEN=plaintext-canary\n', 'utf8');
    await fs.writeFile(
      path.join(root, 'notes.md'),
      '-----BEGIN PRIVATE KEY-----\nplaintext-canary\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'config.ts'),
      'export const password = "hardcoded-password-canary";\n',
      'utf8'
    );

    const bundle = await prepareEvidence(root, 'bounded');
    const evidence = JSON.parse(
      await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8')
    ) as {
      files: Array<{ path: string; content: string }>;
      frameworkCapabilities: { schemaVersion: string; analyses: unknown[] };
      omissions: string[];
    };

    expect(evidence.files.map((file) => file.path)).toEqual([
      'package.json',
      'src/server.mjs'
    ]);
    expect(JSON.stringify(evidence)).not.toContain('plaintext-canary');
    expect(evidence.omissions.join(' ')).toContain('likely secret-bearing');
    expect(evidence.frameworkCapabilities).toEqual({
      schemaVersion: PREVIEW_FRAMEWORK_CAPABILITIES_VERSION,
      analyses: []
    });
    expect(bundle.includedPaths.has('package.json')).toBe(true);
    expect(bundle.includedPaths.has('.env.local')).toBe(false);

    await bundle.dispose();
    await expect(fs.access(bundle.directoryPath)).rejects.toThrow();
  });

  it('preserves a selected backend while withholding credential-bearing connection URLs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-connections-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'client.ts'), 'const api = process.env.NEXT_PUBLIC_API_URL || "https://remote.example.com";');
    const configuration = (url: string) => ({ type: 'environment', services: {
      api: { type: 'attach', url }, web: { type: 'command', env: { NEXT_PUBLIC_API_URL: { service: 'api' } } }
    } });
    const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-connection-evidence-'));
    roots.push(evidenceRoot);
    for (const url of ['http://localhost:8001', 'http://user:private-canary@localhost:8001']) {
      const bundle = await preparePreviewRecipeEvidenceBundle(root, { rootDirectory: evidenceRoot,
        generationId: 'connection', diagnostics: { configuration: configuration(url) } });
      const evidence = await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8');
      expect(evidence).not.toContain('private-canary');
      const policy = bundle.publicEnvironment.candidates[0].targetPolicy;
      if (url === 'http://localhost:8001') expect(policy).toEqual({ kind: 'CONFIGURED', publicHttpTarget: { scheme: 'http', host: 'localhost', port: 8001, basePath: '/' } });
      else expect(policy).not.toMatchObject({ publicHttpTarget: { host: 'localhost' } });
      await bundle.dispose();
    }
  });

  it('adds trusted actionable framework facts without exposing dependency contents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-next-evidence-test-'));
    roots.push(root);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^16.1.6' },
        scripts: { dev: 'next dev --turbopack --experimental-https -p 8000' }
      }),
      'utf8'
    );
    await writePackageLock(root, '^16.1.6', '16.2.3', 'lockfile-content-canary');

    const bundle = await prepareEvidence(root, 'framework');
    const evidence = JSON.parse(
      await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8')
    ) as {
      files: Array<{ path: string; content: string }>;
      frameworkCapabilities: typeof bundle.frameworkCapabilities;
    };

    expect(evidence.frameworkCapabilities).toEqual(bundle.frameworkCapabilities);
    expect(evidence.frameworkCapabilities.analyses[0]).toMatchObject({
      conflicts: [{ code: 'HTTPS_LISTENER' }, { code: 'FIXED_PORT' }],
      compatiblePreviewCommand: [
        './node_modules/.bin/next', 'dev', '--turbopack',
        '--hostname', '127.0.0.1'
      ],
      dependencyPreparation: expect.objectContaining({
        installCommand: ['npm', 'ci', '--no-audit', '--no-fund'],
        lockfilePath: 'package-lock.json'
      })
    });
    expect(bundle.includedPaths.has('package-lock.json')).toBe(true);
    expect(evidence.files.some((file) => file.path === 'package-lock.json')).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain('lockfile-content-canary');

    await bundle.dispose();
  });

  it('fails closed without following a symlinked dependency lockfile', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-next-symlink-test-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-next-lock-outside-'));
    roots.push(root, outside);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^16.1.6' },
        scripts: { dev: 'next dev' }
      }),
      'utf8'
    );
    await writePackageLock(outside, '^16.1.6', '16.2.3', 'outside-lock-canary');
    await fs.symlink(
      path.join(outside, 'package-lock.json'),
      path.join(root, 'package-lock.json')
    );

    const bundle = await prepareEvidence(root, 'symlink');
    const evidenceText = await fs.readFile(
      path.join(bundle.directoryPath, bundle.fileName),
      'utf8'
    );
    const evidence = JSON.parse(evidenceText) as {
      frameworkCapabilities: typeof bundle.frameworkCapabilities;
    };

    expect(evidence.frameworkCapabilities.analyses[0].compatiblePreviewCommand).toBeUndefined();
    expect(evidence.frameworkCapabilities.analyses[0].limitation).toContain(
      'safe regular file'
    );
    expect(bundle.includedPaths.has('package-lock.json')).toBe(false);
    expect(evidenceText).not.toContain('outside-lock-canary');

    await bundle.dispose();
  });

  it('keeps nested application evidence for a monorepo layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-monorepo-evidence-test-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'apps', 'web'), { recursive: true });
    await fs.mkdir(path.join(root, 'services', 'api'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'services', 'api', 'server.py'),
      'from http.server import HTTPServer\n',
      'utf8'
    );

    const bundle = await prepareEvidence(root, 'monorepo');
    const evidence = JSON.parse(
      await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8')
    ) as { files: Array<{ path: string }> };

    expect(evidence.files.map((file) => file.path)).toEqual([
      'apps/web/package.json',
      'package.json',
      'services/api/server.py'
    ]);
    await bundle.dispose();
  });
});

async function prepareEvidence(root: string, generationId: string) {
  const evidenceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'preview-evidence-owner-test-')
  );
  roots.push(evidenceRoot);
  return preparePreviewRecipeEvidenceBundle(root, {
    rootDirectory: evidenceRoot,
    generationId
  });
}

async function writePackageLock(
  root: string,
  declaredVersion: string,
  lockedVersion: string,
  excludedCanary: string
): Promise<void> {
  await fs.writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      name: 'preview-next-fixture',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { next: declaredVersion } },
        'node_modules/next': { version: lockedVersion }
      },
      ignoredPadding: excludedCanary
    }),
    'utf8'
  );
}
