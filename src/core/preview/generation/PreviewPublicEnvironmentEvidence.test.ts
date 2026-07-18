import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../../git/gitCli';
import {
  inspectPreviewPublicEnvironmentEvidence,
  PREVIEW_PUBLIC_ENVIRONMENT_EVIDENCE_VERSION
} from './PreviewPublicEnvironmentEvidence';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Preview public environment evidence', () => {
  it('derives a public HTTP candidate from source and a tracked template without exposing other values', async () => {
    const root = await repository();
    await fs.mkdir(path.join(root, 'src'));
    const source = [
      '// process.env.NEXT_PUBLIC_COMMENT_URL',
      'const example = "process.env.NEXT_PUBLIC_STRING_URL";',
      'const pattern = /process\\.env\\.NEXT_PUBLIC_REGEX_URL/;',
      "export const api = process.env.NEXT_PUBLIC_API_URL || 'https://api.dev.example';"
    ].join('\n');
    await fs.writeFile(path.join(root, 'src', 'config.ts'), source, 'utf8');
    await fs.writeFile(
      path.join(root, 'src', 'config.test.ts'),
      'process.env.NEXT_PUBLIC_TEST_URL;\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'example.env'),
      [
        'NEXT_PUBLIC_API_URL=https://api.staging.example/base',
        'PRIVATE_TOKEN=template-secret-canary'
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(path.join(root, '.gitignore'), '.env*\n', 'utf8');
    await fs.writeFile(path.join(root, '.env.local'), 'NEXT_PUBLIC_API_URL=http://127.0.0.1:8001\n', 'utf8');
    await git(root, ['add', 'src/config.ts', 'src/config.test.ts', 'example.env', '.gitignore']);

    const evidence = await inspectPreviewPublicEnvironmentEvidence(root, [
      { path: 'src/config.ts', content: source },
      { path: 'src/config.test.ts', content: 'process.env.NEXT_PUBLIC_TEST_URL;\n' }
    ]);

    expect(evidence.schemaVersion).toBe(PREVIEW_PUBLIC_ENVIRONMENT_EVIDENCE_VERSION);
    expect(evidence.templates).toEqual([{
      path: 'example.env',
      keys: [
        {
          key: 'NEXT_PUBLIC_API_URL',
          exposure: 'NEXT_PUBLIC',
          valueKind: 'CREDENTIAL_FREE_HTTP_URL',
          publicHttpTarget: {
            scheme: 'https', host: 'api.staging.example', port: 443, basePath: '/base'
          }
        },
        { key: 'PRIVATE_TOKEN', exposure: 'UNKNOWN', valueKind: 'REDACTED' }
      ]
    }]);
    expect(evidence.candidates).toEqual([{
      id: 'next-public:NEXT_PUBLIC_API_URL',
      key: 'NEXT_PUBLIC_API_URL',
      kind: 'POSSIBLE_HTTP_ORIGIN',
      sourceEvidencePaths: ['src/config.ts'],
      templateEvidence: [{
        path: 'example.env',
        publicHttpTarget: {
          scheme: 'https', host: 'api.staging.example', port: 443, basePath: '/base'
        }
      }],
      sourceDefault: {
        scheme: 'https', host: 'api.dev.example', port: 443, basePath: '/'
      },
      targetPolicy: { kind: 'LOCAL_REQUIRED' }
    }]);
    expect(JSON.stringify(evidence)).not.toContain('template-secret-canary');
    expect(JSON.stringify(evidence)).not.toContain('127.0.0.1');
    expect(JSON.stringify(evidence)).not.toContain('NEXT_PUBLIC_COMMENT_URL');
    expect(JSON.stringify(evidence)).not.toContain('NEXT_PUBLIC_STRING_URL');
    expect(JSON.stringify(evidence)).not.toContain('NEXT_PUBLIC_REGEX_URL');
  });

  it('does not inspect an untracked template or a tracked template symlink', async () => {
    const root = await repository();
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'preview-env-outside-')), 'values');
    roots.push(path.dirname(outside));
    await fs.writeFile(outside, 'NEXT_PUBLIC_API_URL=https://outside.example\n', 'utf8');
    await fs.symlink(outside, path.join(root, 'example.env'));
    await git(root, ['add', 'example.env']);
    await fs.writeFile(path.join(root, '.env.example'), 'NEXT_PUBLIC_API_URL=https://untracked.example\n', 'utf8');

    const evidence = await inspectPreviewPublicEnvironmentEvidence(root, []);

    expect(evidence.templates).toEqual([]);
    expect(evidence.candidates).toEqual([]);
  });

  it('does not follow a replaced parent directory outside the repository', async () => {
    const root = await repository();
    await fs.mkdir(path.join(root, 'config'));
    await fs.writeFile(
      path.join(root, 'config', 'example.env'),
      'NEXT_PUBLIC_API_URL=https://tracked.example\n',
      'utf8'
    );
    await git(root, ['add', 'config/example.env']);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-env-parent-outside-'));
    roots.push(outside);
    await fs.writeFile(
      path.join(outside, 'example.env'),
      'NEXT_PUBLIC_API_URL=https://outside.example\n',
      'utf8'
    );
    await fs.rm(path.join(root, 'config'), { recursive: true });
    await fs.symlink(outside, path.join(root, 'config'));

    const evidence = await inspectPreviewPublicEnvironmentEvidence(root, []);

    expect(evidence.templates).toEqual([]);
  });

  it('allows only one exact URL and requires local configuration for unresolved templates', async () => {
    const root = await repository();
    await fs.writeFile(
      path.join(root, 'example.env'),
      'NEXT_PUBLIC_API_URL=https://api.example/v1\nNEXT_PUBLIC_OTHER_URL=<configure-me>\n',
      'utf8'
    );
    await git(root, ['add', 'example.env']);
    const source = [
      "const api = process.env.NEXT_PUBLIC_API_URL || 'https://api.example/v1';",
      "const other = process.env.NEXT_PUBLIC_OTHER_URL || 'https://other.example';"
    ].join('\n');

    const evidence = await inspectPreviewPublicEnvironmentEvidence(root, [{
      path: 'src/config.ts', content: source
    }]);

    expect(evidence.candidates.map((candidate) => candidate.targetPolicy)).toEqual([
      {
        kind: 'LITERAL_ALLOWED',
        publicHttpTarget: {
          scheme: 'https', host: 'api.example', port: 443, basePath: '/v1'
        }
      },
      { kind: 'LOCAL_REQUIRED' }
    ]);
  });
});

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-public-env-test-'));
  roots.push(root);
  await git(root, ['init']);
  return root;
}
