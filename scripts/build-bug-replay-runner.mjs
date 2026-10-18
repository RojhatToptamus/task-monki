import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const RUNNER_ENTRY = path.resolve('src/core/bugReplay/runner/runnerMain.ts');
export const RUNNER_OUTPUT = path.resolve('dist-electron/bug-replay-runner.cjs');

/**
 * Bundles Task Monki's own replay runner into one CommonJS file. playwright-core is never
 * bundled: it reads its own files at load time, so the runner loads the unmodified package by
 * the path core passes on its command line.
 */
export async function buildBugReplayRunner(outfile = RUNNER_OUTPUT) {
  await build({
    entryPoints: [RUNNER_ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['playwright-core'],
    logLevel: 'warning',
    legalComments: 'none'
  });
  return outfile;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildBugReplayRunner(process.argv[2] ? path.resolve(process.argv[2]) : RUNNER_OUTPUT);
  console.log('Built the Bug Replay runner.');
}
