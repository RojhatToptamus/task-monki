import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { changedProtectedInputs, planProtectedInputs, type ProtectedTree } from './ProtectedInputs';

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
});
