import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { changedProtectedInputs, planProtectedInputs, type ProtectedTree } from './ProtectedInputs';
import { deriveReplaySpec } from './ReplayDerivation';

/** A tree as git reads it: each file's text, and its blob id the way `git ls-tree` reports it. */
function tree(files: Record<string, string>): ProtectedTree {
  const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  return {
    files: Object.keys(files),
    readText: async (relativePath) => files[relativePath],
    blobs: async (paths) => new Map(paths.filter((file) => file in files).map((file) => [file, blob(files[file])]))
  };
}

const SEEDED_APP = {
  'package.json': JSON.stringify({ scripts: { seed: 'node seed/seed.js' } }),
  'seed/seed.js': "require('fs').writeFileSync('data.json', '[]');\n",
  'server.js': 'listen();\n',
  '.env': 'PORT=3000\n',
  '.env.example': 'PORT=\n'
};
const JOBS = [
  { id: 'seed', type: 'job', directory: '.', command: ['npm', 'run', 'seed'] },
  { id: 'web', type: 'command', directory: '.', command: ['node', 'server.js'] }
];

describe('Setup a bug keeps fixed', () => {
  it('stops verification when a seed or an env file the app reads changes, not when the app code does', async () => {
    const { pins } = await planProtectedInputs(JOBS, tree(SEEDED_APP));

    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, 'server.js': 'listen(fixed);\n' }))).toEqual([]);
    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, 'seed/seed.js': 'seedLess();\n' }))).toEqual(['seed/seed.js']);
    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, '.env': 'PORT=4000\n' }))).toEqual(['.env']);
    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, '.env.local': 'DEBUG=1\n' }))).toEqual(['.env.local']);
  });

  it('treats example, sample and template env files as documentation', async () => {
    const { pins } = await planProtectedInputs(JOBS, tree(SEEDED_APP));

    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, '.env.example': 'PORT=\nDEBUG=\n' }))).toEqual([]);
    expect(await changedProtectedInputs(pins, tree({ ...SEEDED_APP, '.env.sample': 'PORT=\n', '.env.template': 'PORT=\n' }))).toEqual([]);
  });

  it.each<{ setup: string; command: string[]; files: Record<string, string>; pinned: string[]; shared: string[] }>([
    {
      setup: 'a Prisma seed',
      command: ['npx', 'prisma', 'db', 'seed'],
      files: {
        'package.json': JSON.stringify({ prisma: { seed: 'tsx prisma/seed.ts' } }),
        'prisma/schema.prisma': 'model User { id Int @id }\n',
        'prisma/seed.ts': "import { users } from './users';\nimport { money } from '../src/money';\n",
        'prisma/users.ts': 'export const users = [];\n',
        'src/money.ts': 'export const money = (cents: number) => cents / 100;\n'
      },
      pinned: ['prisma/seed.ts', 'prisma/users.ts', 'package.json#/prisma/seed'],
      shared: ['src/money.ts']
    },
    {
      setup: 'a script of a workspace package',
      command: ['npm', 'run', 'seed', '--workspace', '@shop/db'],
      files: {
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/db/package.json': JSON.stringify({ name: '@shop/db', scripts: { seed: 'node seed.js' } }),
        'packages/db/seed.js': "require('./client');\n",
        'packages/db/client.js': 'module.exports = {};\n'
      },
      pinned: ['packages/db/seed.js', 'packages/db/package.json#/scripts/seed'],
      // The package's other files are its code: shared with the app, not kept fixed.
      shared: ['packages/db/client.js']
    },
    {
      setup: 'a Turborepo task run through npx',
      command: ['npx', 'turbo', 'run', 'seed'],
      files: {
        'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
        'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { seed: 'node scripts/seed.js' } }),
        'apps/web/scripts/seed.js': 'seed();\n',
        'apps/api/package.json': JSON.stringify({ name: 'api', scripts: { build: 'tsc' } })
      },
      pinned: ['apps/web/scripts/seed.js', 'apps/api/package.json#/scripts/seed', 'apps/web/package.json#/scripts/seed', 'package.json#/scripts/seed'],
      shared: []
    },
    {
      setup: 'Knex seeds',
      command: ['npx', 'knex', 'seed:run'],
      files: { 'knexfile.js': 'module.exports = {};\n', 'seeds/01_users.js': 'exports.seed = () => {};\n', 'migrations/001_users.js': 'exports.up = () => {};\n' },
      pinned: ['knexfile.js', 'seeds/01_users.js'],
      shared: []
    },
    {
      setup: 'Rails seeds',
      command: ['bin/rails', 'db:seed'],
      files: { 'db/seeds.rb': 'User.create!\n', 'db/seeds/products.rb': 'Product.create!\n', 'db/schema.rb': 'create_table :users\n' },
      pinned: ['db/seeds.rb', 'db/seeds/products.rb'],
      shared: []
    },
    {
      setup: 'Django fixtures',
      command: ['python', 'manage.py', 'loaddata', 'products'],
      files: { 'manage.py': 'main()\n', 'shop/fixtures/products.json': '[]\n', 'shop/models.py': 'class Product: pass\n' },
      pinned: ['manage.py', 'shop/fixtures/products.json'],
      shared: []
    }
  ])('keeps the seed data of $setup fixed', async ({ command, files, pinned, shared }) => {
    const plan = await planProtectedInputs([{ id: 'seed', type: 'job', directory: '.', command }], tree(files));

    expect(plan.pins.flatMap((pin) => (pin.kind === 'file' ? [pin.path] : pin.kind === 'jsonMember' ? [`${pin.path}#${pin.pointer}`] : []))).toEqual(pinned);
    expect(plan.sharedSetup).toEqual(shared);
  });

  it('keeps the scripts of the install a clean copy adds fixed, as it does for a recipe’s own install', async () => {
    // A recipe for live folders runs no install; the clean copy adds one from the lockfile.
    const recipeText = [
      'name: shop',
      'type: environment',
      'primary: web',
      'services:',
      '  seed: { type: job, cwd: ., command: [npm, run, seed] }',
      '  web: { type: command, cwd: ., command: [node, server.js], readyPath: /, dependsOn: [seed] }'
    ].join('\n');
    const app = { ...SEEDED_APP, 'package-lock.json': '{"lockfileVersion":3}\n' };
    const derived = await deriveReplaySpec({ recipeText, exportRoot: '/<export>', liveWorktree: '/work/shop', runName: 'br-0123456789ab', ceiling: '/work', tree: tree(app), envFiles: [] });
    expect(derived.jobs.map((job) => [job.id, job.directory, job.command?.join(' ')])).toEqual([
      ['seed', '.', 'npm run seed'],
      ['web', '.', 'node server.js'],
      ['tm-install', '.', 'npm ci --no-audit --no-fund']
    ]);
    const { pins } = await planProtectedInputs(derived.jobs, tree(app));

    // npm runs these around the install, before the app starts.
    const manifest = (scripts: Record<string, string>) => JSON.stringify({ scripts: { seed: 'node seed/seed.js', ...scripts } });
    expect(await changedProtectedInputs(pins, tree({ ...app, 'package.json': manifest({ postinstall: 'node patch.js' }) }))).toEqual(['package.json (scripts.postinstall)']);
    expect(await changedProtectedInputs(pins, tree({ ...app, 'package.json': manifest({ prepare: 'node patch.js' }) }))).toEqual(['package.json (scripts.prepare)']);
  });
});
