import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveReplaySpec, type ReplayDerivationInput } from './ReplayDerivation';

const RECIPE = [
  'name: checkout',
  'type: environment',
  'primary: web',
  'services:',
  '  web:',
  '    type: command',
  '    cwd: .',
  '    command: [node, server.js]',
  '    readyPath: /',
  ''
].join('\n');

function input(overrides: Partial<ReplayDerivationInput> = {}): ReplayDerivationInput {
  return {
    recipeText: RECIPE,
    exportRoot: '/exports/run-1/source',
    liveWorktree: '/work/shop',
    runName: 'br-0123456789ab',
    ceiling: '/exports/run-1:/exports/run-1/.tm-ceiling-run-1',
    tree: { files: ['preview.yaml', 'server.js'], readText: async () => undefined },
    envFiles: [],
    ...overrides
  };
}

/** The checkout recipe's web service with `lines` in place of its own settings. */
function webService(...lines: string[]): string {
  return ['name: checkout', 'type: environment', 'primary: web', 'services:', '  web:', '    type: command', ...lines.map((line) => `    ${line}`), ''].join('\n');
}

describe('What approving replays covers', () => {
  it('names the recipe with the env files replays get and the hosts they call, not where one run happens', async () => {
    const approved = (await deriveReplaySpec(input())).approvalDigest;
    // Another run of the same recipe, exported elsewhere under its own name, is the same approval.
    const elsewhere = input({ exportRoot: '/elsewhere/run-2/source', runName: 'br-ba9876543210', ceiling: '/elsewhere/run-2:/elsewhere/run-2/.tm-ceiling-run-2' });
    expect((await deriveReplaySpec(elsewhere)).approvalDigest).toBe(approved);

    // Anything else the person read asks again: another command, an env file, another outside host.
    const changed = await Promise.all([
      input({ recipeText: RECIPE.replace('[node, server.js]', '[node, worker.js]') }),
      input({ envFiles: [{ relativePath: '.env', text: 'FEATURE=1\n' }] }),
      input({ envFiles: [{ relativePath: '.env', text: 'FEATURE=1\nAPI_URL=https://api.example.com\n' }] })
    ].map(async (value) => (await deriveReplaySpec(value)).approvalDigest));
    expect(new Set([approved, ...changed]).size).toBe(4);
  });
});

describe('Recipes a clean copy cannot run honestly', () => {
  const withDependencies = {
    files: ['preview.yaml', 'server.js', 'package.json'],
    readText: async (file: string) => (file === 'package.json' ? JSON.stringify({ dependencies: { express: '^4.21.0' } }) : undefined)
  };

  it.each<[string, Partial<ReplayDerivationInput>, string]>([
    [
      'a service run from outside the task folder',
      { recipeText: webService('cwd: /srv/shop', 'command: [node, server.js]') },
      "The web service runs from outside this task's folder. Clean copies need every source inside it."
    ],
    [
      'a readiness check run outside the task folder',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'ready:', '  type: command', '  command: [node, check.js]', '  cwd: /srv/shop') },
      "The web readiness check runs outside this task's folder."
    ],
    [
      'a liveness check run outside the task folder',
      {
        recipeText: webService(
          'cwd: .',
          'command: [node, server.js]',
          'liveness:',
          '  probe:',
          '    type: command',
          '    command: [node, check.js]',
          '    cwd: /srv/shop',
          '  intervalMs: 5000',
          '  failureThreshold: 3'
        )
      },
      "The web readiness check runs outside this task's folder."
    ],
    [
      'a command naming a file in the live worktree',
      { recipeText: webService('cwd: .', 'command: [node, /work/shop/server.js]') },
      'The web command names a file in the live worktree. Use a path relative to the project.'
    ],
    [
      'a value read from Task Monki’s own environment',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  API_TOKEN:', '    fromEnv: API_TOKEN') },
      "The web service reads API_TOKEN from Task Monki's own environment, which clean copies do not pass on."
    ],
    [
      'dependencies without a lockfile',
      { tree: withDependencies },
      'Clean copies install dependencies from a lockfile. Add one to the project.'
    ],
    [
      'a database outside Preview',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  DATABASE_URL: postgres://db.internal:5432/shop') },
      'This app uses a database outside Preview (DATABASE_URL in the web service). Clean copies would change it.'
    ],
    [
      'a database outside Preview named only in an env file the replays get',
      { envFiles: [{ relativePath: '.env', text: 'DATABASE_URL=postgres://db.internal:5432/shop\n' }] },
      'This app uses a database outside Preview (DATABASE_URL in .env). Clean copies would change it.'
    ],
    [
      'data kept in a folder outside the project',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  DATA_DIR: /var/lib/shop') },
      'This app keeps data outside its folder (DATA_DIR in the web service). Clean copies would change it.'
    ],
    [
      'a database file outside the project',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  SQLITE_URL: file:/var/lib/shop.db') },
      'This app keeps data outside its folder (SQLITE_URL in the web service). Clean copies would change it.'
    ],
    [
      'a path into the live worktree',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  UPLOADS: /work/shop/uploads') },
      'UPLOADS in the web service points into the live worktree. Use a path relative to the project.'
    ],
    [
      'a local service the recipe does not run',
      { recipeText: webService('cwd: .', 'command: [node, server.js]', 'env:', '  SMTP_URL: smtp://127.0.0.1:1025') },
      'This app calls a local service outside Preview (SMTP_URL in the web service). Add it to the recipe so clean copies run it too.'
    ],
    [
      'files served that the code does not hold',
      { recipeText: ['name: checkout', 'type: static', 'directory: dist', ''].join('\n') },
      'The app service serves dist that are not in the code. Ask the Preview agent to build them in a job.'
    ],
    [
      'a Compose recipe',
      {
        recipeText: [
          'name: checkout',
          'type: compose',
          'cwd: .',
          'files: [compose.yaml]',
          'rootServices: [web]',
          'services:',
          '  - id: web',
          '    ports:',
          '      http:',
          '        target: 3000',
          'primary:',
          '  service: web',
          '  port: http',
          ''
        ].join('\n')
      },
      'Clean copies do not run Compose recipes. Ask the Preview agent for an environment recipe.'
    ],
    [
      'an app Preview only attaches to',
      { recipeText: ['name: checkout', 'type: attach', 'url: http://127.0.0.1:3000', ''].join('\n') },
      'Clean copies cannot freeze an app that Preview only attaches to.'
    ]
  ])('refuses %s, saying why', async (_case, overrides, message) => {
    await expect(deriveReplaySpec(input(overrides))).rejects.toMatchObject({ name: 'ReplayEligibilityError', code: 'INELIGIBLE', message });
  });

  it('runs every service, check and job from the frozen copy, never the live worktree, with Git stopped at the copy', async () => {
    const recipe = [
      'name: checkout',
      'type: environment',
      'primary: web',
      'services:',
      '  web:',
      '    type: command',
      '    cwd: .',
      '    command: [node, server.js]',
      '    readyPath: /',
      '  api:',
      '    type: command',
      '    cwd: /work/shop/api',
      '    command: [node, api.js]',
      '    ready:',
      '      type: command',
      '      command: [node, check.js]',
      '      cwd: api',
      '  migrate:',
      '    type: job',
      '    cwd: api',
      '    command: [node, migrate.js]',
      '  assets:',
      '    type: static',
      '    directory: public',
      ''
    ].join('\n');
    const tree = {
      files: ['preview.yaml', 'server.js', 'package.json', 'package-lock.json', 'api/api.js', 'api/check.js', 'api/migrate.js', 'public/index.html'],
      readText: async (file: string) => (file === 'package.json' ? JSON.stringify({ dependencies: { express: '^4.21.0' } }) : undefined)
    };
    const run = input({ recipeText: recipe, tree });

    const derived = await deriveReplaySpec(run);

    const services = (derived.spec as unknown as { services: Record<string, Record<string, unknown>> }).services;
    // The lockfile's install is added, since a clean copy has no node_modules.
    expect(derived.addedInstallJobs).toEqual(['tm-install']);
    const directories = Object.values(services).flatMap((service) => {
      const ready = service.ready as { cwd?: unknown } | undefined;
      return [service.cwd, service.directory, ready?.cwd].filter((value): value is string => typeof value === 'string');
    });
    expect(directories.length).toBeGreaterThanOrEqual(6);
    for (const directory of directories) {
      expect(directory === run.exportRoot || directory.startsWith(`${run.exportRoot}${path.sep}`), directory).toBe(true);
      expect(directory.startsWith(run.liveWorktree), directory).toBe(false);
    }
    const jobs = Object.entries(services).filter(([, service]) => service.type === 'job');
    expect(jobs.map(([id]) => id).sort()).toEqual(['migrate', 'tm-install']);
    for (const [, job] of jobs) expect(job.env).toMatchObject({ GIT_CEILING_DIRECTORIES: run.ceiling });
  });
});
