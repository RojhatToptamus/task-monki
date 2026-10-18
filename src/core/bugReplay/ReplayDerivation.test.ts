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
