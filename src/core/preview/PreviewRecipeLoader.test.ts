import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePreviewRecipe, PreviewRecipeLoader } from './PreviewRecipeLoader';

const RECIPE = `
version: 1
jobs:
  prepare:
    label: Prepare application
    command: [node, scripts/prepare.mjs]
services:
  web:
    label: Start web
    command: [node, server.mjs]
    needs:
      prepare: succeeded
    env:
      NODE_ENV: development
    ports:
      http:
        env: PORT
    ready:
      type: http
      port: http
      path: /health
routes:
  app:
    service: web
    port: http
    primary: true
`;
const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('PreviewRecipeLoader', () => {
  it('loads only the explicit recipe and returns a typed missing result without execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recipe-'));
    fixtureRoots.push(root);
    const loader = new PreviewRecipeLoader();
    await expect(loader.load(root)).resolves.toEqual(
      expect.objectContaining({ status: 'MISSING' })
    );
    await fs.mkdir(path.join(root, '.taskmonki'));
    await fs.writeFile(path.join(root, '.taskmonki', 'preview.yaml'), RECIPE);
    const loaded = await loader.load(root);
    expect(loaded.status).toBe('LOADED');
    if (loaded.status === 'LOADED') {
      expect(loaded.parsed.executionPlan.services[0]?.command).toEqual(['node', 'server.mjs']);
    }
  });

  it('keeps the execution digest stable across formatting, defaults, key order, and labels', () => {
    const first = parsePreviewRecipe(RECIPE);
    const reformatted = parsePreviewRecipe(`
routes: { app: { primary: true, port: http, service: web } }
services:
  web:
    ready: { path: /health, port: http, type: http, timeoutSeconds: 30 }
    ports: { http: { env: PORT } }
    env: { NODE_ENV: development }
    needs: { prepare: succeeded }
    command: [node, server.mjs]
    cwd: .
    label: A different display label
jobs:
  prepare:
    needs: {}
    cwd: .
    command: [node, scripts/prepare.mjs]
version: 1
`);
    expect(reformatted.executionDigest).toBe(first.executionDigest);
    expect(reformatted.recipeDigest).not.toBe(first.recipeDigest);
  });

  it.each([
    ['command', RECIPE.replace('server.mjs', 'other-server.mjs')],
    ['cwd', RECIPE.replace('command: [node, server.mjs]', 'cwd: apps/web\n    command: [node, server.mjs]')],
    ['environment', RECIPE.replace('NODE_ENV: development', 'NODE_ENV: test')],
    ['readiness', RECIPE.replace('path: /health', 'path: /ready')],
    [
      'route',
      RECIPE.replace('port: http\n    primary', 'port: other\n    primary').replace(
        'ports:\n      http:',
        'ports:\n      http:\n        env: PORT\n      other:'
      )
    ]
  ])('changes the execution digest for a capability-bearing %s edit', (_label, changed) => {
    expect(parsePreviewRecipe(changed).executionDigest).not.toBe(
      parsePreviewRecipe(RECIPE).executionDigest
    );
  });

  it.each([
    ['duplicate keys', `${RECIPE}\nversion: 1\n`],
    ['alias', `version: 1\njobs: &jobs {}\nservices: *jobs\nroutes: {}\n`],
    ['merge key', `version: 1\njobs: {}\nbase: &base { command: [node, a] }\nservices: { web: { <<: *base } }\nroutes: {}\n`],
    ['custom tag', `version: 1\njobs: !custom {}\nservices: {}\nroutes: {}\n`],
    ['non-string key', `version: 1\njobs: { 3: {} }\nservices: {}\nroutes: {}\n`],
    ['unknown field', `${RECIPE}\nprivileged: true\n`],
    ['shell command', RECIPE.replace('[node, server.mjs]', 'node server.mjs')],
    ['cwd escape', RECIPE.replace('command: [node, server.mjs]', 'cwd: ../outside\n    command: [node, server.mjs]')]
  ])('rejects unsafe or ambiguous input: %s', (_label, source) => {
    expect(() => parsePreviewRecipe(source)).toThrow();
  });

  it('rejects dependency cycles and multiple long-running services in Phase 1', () => {
    expect(() =>
      parsePreviewRecipe(
        RECIPE.replace(
          'command: [node, scripts/prepare.mjs]',
          'command: [node, scripts/prepare.mjs]\n    needs: { prepare: succeeded }'
        )
      )
    ).toThrow('cycle');
    expect(() =>
      parsePreviewRecipe(
        RECIPE.replace('services:\n  web:', 'services:\n  api:\n    command: [node, api.mjs]\n    ports: { http: { env: API_PORT } }\n    ready: { type: http, port: http, path: /ready }\n  web:')
      )
    ).toThrow('exactly one service');
  });

  it('rejects oversized input and executable YAML tags before conversion', () => {
    expect(() => parsePreviewRecipe(`${RECIPE}\n#${'x'.repeat(70_000)}`)).toThrow(
      'exceeds 65536 bytes'
    );
    expect(() =>
      parsePreviewRecipe(`version: 1\njobs: !!js/function function () {}\nservices: {}\nroutes: {}`)
    ).toThrow();
  });

  it('rejects external symlinks, special entries, and oversized files before parsing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recipe-boundary-'));
    fixtureRoots.push(root);
    const recipeDir = path.join(root, '.taskmonki');
    const outside = path.join(root, '..', `outside-${path.basename(root)}.yaml`);
    await fs.mkdir(recipeDir);
    await fs.writeFile(outside, RECIPE);
    await fs.symlink(outside, path.join(recipeDir, 'preview.yaml'));
    const loader = new PreviewRecipeLoader();
    await expect(loader.load(root)).rejects.toThrow('regular file');

    await fs.rm(path.join(recipeDir, 'preview.yaml'));
    await fs.rmdir(recipeDir);
    const externalDir = path.join(root, '..', `external-dir-${path.basename(root)}`);
    await fs.mkdir(externalDir);
    await fs.writeFile(path.join(externalDir, 'preview.yaml'), RECIPE);
    await fs.symlink(externalDir, recipeDir);
    await expect(loader.load(root)).rejects.toThrow('escapes the task worktree');

    await fs.rm(recipeDir);
    await fs.rm(externalDir, { recursive: true });
    await fs.mkdir(recipeDir);
    await fs.mkdir(path.join(recipeDir, 'preview.yaml'));
    await expect(loader.load(root)).rejects.toThrow('regular file');

    await fs.rm(path.join(recipeDir, 'preview.yaml'), { recursive: true });
    await fs.writeFile(path.join(recipeDir, 'preview.yaml'), 'x'.repeat(65_537));
    await expect(loader.load(root)).rejects.toThrow('exceeds 65536 bytes');
    await fs.rm(outside, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
});
