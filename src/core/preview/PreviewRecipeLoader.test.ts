import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePreviewRecipe,
  PreviewRecipeLoader,
  selectPreviewScenario
} from './PreviewRecipeLoader';

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
        'ports:\n      http:\n        env: PORT',
        'ports:\n      http:\n        env: PORT\n      other:\n        env: OTHER_PORT'
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

  it('rejects duplicate generated port environment keys', () => {
    expect(() =>
      parsePreviewRecipe(
        RECIPE.replace(
          'ports:\n      http:\n        env: PORT',
          'ports:\n      http:\n        env: PORT\n      admin:\n        env: PORT'
        )
      )
    ).toThrow('duplicates another generated port environment key');
  });

  it('rejects dependency cycles and accepts multiple Phase 2 services', () => {
    expect(() =>
      parsePreviewRecipe(
        RECIPE.replace(
          'command: [node, scripts/prepare.mjs]',
          'command: [node, scripts/prepare.mjs]\n    needs: { prepare: succeeded }'
        )
      )
    ).toThrow('cycle');
    const parsed = parsePreviewRecipe(
      RECIPE.replace('services:\n  web:', 'services:\n  api:\n    command: [node, api.mjs]\n    ports: { http: { env: API_PORT } }\n    ready: { type: tcp, port: http }\n  web:')
    );
    expect(parsed.executionPlan.services.map((service) => service.id)).toEqual(['api', 'web']);
  });

  it('normalizes workers, typed origins, probes, criticality, and bounded restarts', () => {
    const parsed = parsePreviewRecipe(`
version: 1
jobs:
  install:
    cwd: packages
    command: [npm, install, --ignore-scripts]
services:
  api:
    cwd: apps/api
    command: [node, server.mjs]
    needs: { install: succeeded }
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http, timeoutSeconds: 12 }
    restart: { mode: on-failure, maxRestarts: 2, backoffMs: 50 }
  web:
    cwd: apps/web
    command: [node, server.mjs]
    needs: { install: succeeded, api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
      PUBLIC_ORIGIN: { type: route-origin, route: app }
    ports: { http: { env: PORT } }
    ready: { type: argv, cwd: apps/web, command: [node, check-ready.mjs] }
workers:
  indexer:
    command: [node, worker.mjs]
    needs: { api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
    ready: { type: argv, command: [node, worker-ready.mjs], timeoutSeconds: 8 }
    liveness:
      type: argv
      command: [node, worker-live.mjs]
      timeoutSeconds: 2
      intervalSeconds: 5
      failureThreshold: 2
    critical: true
    restart: { mode: always, maxRestarts: 4 }
routes:
  api: { service: api, port: http, primary: false }
  app: { service: web, port: http, primary: true }
`);
    expect(parsed.executionPlan.jobs[0]?.cwd).toBe('packages');
    expect(parsed.executionPlan.services[0]?.ready).toEqual({
      type: 'tcp', port: 'http', timeoutSeconds: 12
    });
    expect(parsed.executionPlan.services[1]?.env.API_ORIGIN).toEqual({
      type: 'service-origin', service: 'api', port: 'http'
    });
    expect(parsed.executionPlan.workers?.[0]).toEqual(expect.objectContaining({
      id: 'indexer', critical: true,
      restart: { mode: 'always', maxRestarts: 4, backoffMs: 250 },
      liveness: expect.objectContaining({ intervalSeconds: 5, failureThreshold: 2 })
    }));
  });

  it.each([
    ['unbounded restarts', 'restart: { mode: always, maxRestarts: 9 }'],
    ['never with restarts', 'restart: { mode: never, maxRestarts: 1 }'],
    ['unknown service origin', 'env: { API: { type: service-origin, service: missing, port: http } }'],
    ['implicit service dependency', 'env: { API: { type: service-origin, service: web, port: http } }']
  ])('rejects unsafe Phase 2 policy: %s', (_label, field) => {
    const source = RECIPE.replace('    env:\n      NODE_ENV: development', `    ${field}`);
    expect(() => parsePreviewRecipe(source)).toThrow();
  });

  it('normalizes typed OCI data, migration ordering, scenarios, limits, and URL references', () => {
    const parsed = parsePreviewRecipe(PHASE_THREE_RECIPE);

    expect(parsed.executionPlan.resources).toEqual([
      expect.objectContaining({
        id: 'cache', type: 'redis', image: 'redis:7-alpine'
      }),
      expect.objectContaining({
        id: 'database', type: 'postgres', database: 'preview_app',
        limits: { cpus: 1, memoryMb: 512, diskMb: 2048, pids: 256 }
      })
    ]);
    expect(parsed.executionPlan.jobs).toEqual([
      expect.objectContaining({
        id: 'migrate', role: 'migration', retrySafe: false,
        needs: { database: 'ready' },
        env: { DATABASE_URL: { type: 'postgres-url', resource: 'database' } }
      }),
      expect.objectContaining({
        id: 'seed', role: 'seed', retrySafe: true,
        needs: { migrate: 'succeeded' }
      })
    ]);
    expect(parsed.executionPlan.selectedScenarioId).toBe('review');
    expect(parsed.executionPlan.scenarios).toEqual([
      { id: 'empty', jobs: ['migrate'], resources: ['cache', 'database'] },
      { id: 'review', jobs: ['migrate', 'seed'], resources: ['cache', 'database'] }
    ]);
    expect(parsed.executionPlan.services[0].env).toMatchObject({
      DATABASE_URL: { type: 'postgres-url', resource: 'database' },
      REDIS_URL: { type: 'redis-url', resource: 'cache' }
    });

    const empty = selectPreviewScenario(parsed, 'empty');
    expect(empty.executionPlan.selectedScenarioId).toBe('empty');
    expect(empty.executionDigest).not.toBe(parsed.executionDigest);
    expect(() => selectPreviewScenario(parsed, 'missing')).toThrow('does not exist');
  });

  it('rejects generic OCI until PostgreSQL and Redis prove the shared lifecycle', () => {
    const source = PHASE_THREE_RECIPE.replace(
      'resources:\n  cache:',
      `resources:
  mail:
    type: oci
    image: axllent/mailpit:v1.27
    command: [/mailpit]
    env: { MP_MAX_MESSAGES: "100" }
    ports: { smtp: { containerPort: 1025 }, http: { containerPort: 8025 } }
    ready: { type: http, port: http, path: /livez }
    dataMount: /data
    limits: { memoryMb: 128, pids: 64 }
  cache:`
    ).replace(
      'resources: [cache, database]',
      'resources: [cache, database, mail]'
    );
    expect(() => parsePreviewRecipe(source)).toThrow('postgres or redis');
  });

  it('binds explicit safe worker overlap into the execution digest', () => {
    const exclusive = parsePreviewRecipe(RECIPE.replace(
      'routes:\n  app:',
      `workers:
  consumer:
    command: [node, worker.mjs]
    ready: { type: argv, command: [node, worker-ready.mjs], timeoutSeconds: 5 }
routes:
  app:`
    ));
    const safe = parsePreviewRecipe(RECIPE.replace(
      'routes:\n  app:',
      `workers:
  consumer:
    command: [node, worker.mjs]
    ready: { type: argv, command: [node, worker-ready.mjs], timeoutSeconds: 5 }
    overlap: safe
routes:
  app:`
    ));
    expect(exclusive.executionPlan.workers[0].overlap).toBe('exclusive');
    expect(safe.executionPlan.workers[0].overlap).toBe('safe');
    expect(safe.executionDigest).not.toBe(exclusive.executionDigest);
  });

  it.each([
    ['migration retry declaration', PHASE_THREE_RECIPE.replace('    retrySafe: false\n', '')],
    ['resource dependency', PHASE_THREE_RECIPE.replace('    needs: { database: ready }\n', '')],
    ['typed URL mismatch', PHASE_THREE_RECIPE.replace('type: postgres-url, resource: database', 'type: redis-url, resource: database')],
    ['seed ordering', PHASE_THREE_RECIPE.replace('    needs: { migrate: succeeded }\n', '')],
    ['scenario resource closure', PHASE_THREE_RECIPE.replace('resources: [cache, database]', 'resources: [cache]')],
    ['host mount escape hatch', PHASE_THREE_RECIPE.replace('    database: preview_app', '    database: preview_app\n    hostPath: /tmp/data')],
    ['unbounded memory', PHASE_THREE_RECIPE.replace('memoryMb: 512', 'memoryMb: 999999')]
  ])('rejects unsafe Phase 3 authority: %s', (_label, source) => {
    expect(() => parsePreviewRecipe(source)).toThrow();
  });

  it('rejects oversized input and executable YAML tags before conversion', () => {
    expect(() => parsePreviewRecipe(`${RECIPE}\n#${'x'.repeat(70_000)}`)).toThrow(
      'exceeds 65536 bytes'
    );
    expect(() =>
      parsePreviewRecipe(`version: 1\njobs: !!js/function function () {}\nservices: {}\nroutes: {}`)
    ).toThrow();
  });

  it('caps executable graph size at 32 nodes', () => {
    const jobs = Array.from({ length: 32 }, (_, index) => `  job-${index}: { command: [node, -e, process.exit(0)] }`).join('\n');
    expect(() => parsePreviewRecipe(`${RECIPE}\n`)).not.toThrow();
    expect(() => parsePreviewRecipe(`
version: 1
jobs:
${jobs}
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
`)).toThrow('exceeds 32');
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

const PHASE_THREE_RECIPE = `
version: 1
resources:
  cache:
    type: redis
  database:
    type: postgres
    database: preview_app
    limits: { cpus: 1, memoryMb: 512, diskMb: 2048, pids: 256 }
jobs:
  migrate:
    role: migration
    retrySafe: false
    command: [node, scripts/migrate.mjs]
    needs: { database: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
  seed:
    role: seed
    retrySafe: true
    command: [node, scripts/seed.mjs]
    needs: { migrate: succeeded }
services:
  web:
    command: [node, server.mjs]
    needs: { migrate: succeeded, database: ready, cache: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
scenarios:
  empty:
    jobs: [migrate]
    resources: [cache, database]
  review:
    jobs: [migrate, seed]
    resources: [cache, database]
defaultScenario: review
`;
