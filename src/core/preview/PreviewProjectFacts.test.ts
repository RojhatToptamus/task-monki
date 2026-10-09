import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPreviewProjectFacts } from './PreviewProjectFacts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-facts-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return root;
}

describe('readPreviewProjectFacts', () => {
  it('names the application, its install method, environment keys, and Compose services without reading values', async () => {
    const root = await project({
      'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '19' } }),
      'package-lock.json': ' '.repeat(300_000),
      '.env.example': 'DATABASE_URL=postgres://user:pass@localhost/db\nexport API_SECRET=keep-me-out\n# comment\nMALFORMED LINE\nDATABASE_URL=dup\n',
      '.env': 'REAL_SECRET=never-read\n',
      'docker-compose.yml': 'x-base: &base\n  restart: unless-stopped\nservices:\n  db:\n    <<: *base\n    image: postgres\n  cache:\n    image: redis\n'
    });
    const facts = await readPreviewProjectFacts(root);
    expect(facts).toEqual([
      { label: 'Application', detail: 'Next.js · npm run dev', source: 'package.json' },
      { label: 'Dependencies', detail: 'npm · package-lock.json', source: 'package-lock.json' },
      { label: 'Environment', detail: 'DATABASE_URL, API_SECRET', source: '.env.example' },
      { label: 'Services', detail: 'db, cache', source: 'docker-compose.yml' }
    ]);
    expect(JSON.stringify(facts)).not.toMatch(/pass|keep-me-out|never-read|REAL_SECRET/);
  });

  it('reports a missing lockfile, a declared package manager, a nested frontend, and other ecosystems', async () => {
    const nested = await project({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { start: 'node server.js' }, dependencies: { fastify: '5' } }),
      'web/package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } })
    });
    expect(await readPreviewProjectFacts(nested)).toEqual([
      { label: 'Application', detail: 'Fastify · npm run start', source: 'package.json' },
      { label: 'Dependencies', detail: 'pnpm · no lockfile committed', source: 'package.json' },
      { label: 'Application', detail: 'Vite in web · npm run dev', source: 'web/package.json' }
    ]);
    const python = await project({ 'pyproject.toml': '[project]\nname = "api"\n' });
    expect(await readPreviewProjectFacts(python)).toEqual([{ label: 'Application', detail: 'Python project', source: 'pyproject.toml' }]);
    expect(await readPreviewProjectFacts(await project({}))).toEqual([]);
  });
});
