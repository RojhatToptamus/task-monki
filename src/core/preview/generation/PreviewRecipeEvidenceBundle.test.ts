import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    ) as { files: Array<{ path: string; content: string }>; omissions: string[] };

    expect(evidence.files.map((file) => file.path)).toEqual([
      'package.json',
      'src/server.mjs'
    ]);
    expect(JSON.stringify(evidence)).not.toContain('plaintext-canary');
    expect(evidence.omissions.join(' ')).toContain('likely secret-bearing');
    expect(bundle.includedPaths.has('package.json')).toBe(true);
    expect(bundle.includedPaths.has('.env.local')).toBe(false);

    await bundle.dispose();
    await expect(fs.access(bundle.directoryPath)).rejects.toThrow();
  });
});
