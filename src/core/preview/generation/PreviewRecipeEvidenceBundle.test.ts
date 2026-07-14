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

    const bundle = await preparePreviewRecipeEvidenceBundle(root);
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

    const bundle = await preparePreviewRecipeEvidenceBundle(root);
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

    const bundle = await preparePreviewRecipeEvidenceBundle(root);
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
});

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
