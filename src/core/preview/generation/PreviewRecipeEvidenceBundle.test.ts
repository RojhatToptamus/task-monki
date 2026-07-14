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

    const bundle = await preparePreviewRecipeEvidenceBundle(root);
    const evidence = JSON.parse(
      await fs.readFile(path.join(bundle.directoryPath, bundle.fileName), 'utf8')
    ) as { frameworkCapabilities: typeof bundle.frameworkCapabilities };

    expect(evidence.frameworkCapabilities).toEqual(bundle.frameworkCapabilities);
    expect(evidence.frameworkCapabilities.analyses[0]).toMatchObject({
      conflicts: [{ code: 'HTTPS_LISTENER' }, { code: 'FIXED_PORT' }],
      compatiblePreviewCommand: [
        'npm', 'exec', '--offline', '--', 'next', 'dev', '--turbopack',
        '--hostname', '127.0.0.1'
      ]
    });

    await bundle.dispose();
  });
});
