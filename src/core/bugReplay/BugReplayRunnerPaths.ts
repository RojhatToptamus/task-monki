import fs from 'node:fs';
import path from 'node:path';
import type { BugReplayRunnerPaths } from './BugReplayRunner';

/**
 * Where the replay runner, playwright-core and the browser live in this build. Undefined when any
 * of them is missing, which makes Bug Replay unavailable instead of failing a run later.
 */
export function resolveBugReplayRunnerPaths(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  nodeExecutable: string;
  browserExecutable: string | undefined;
}): BugReplayRunnerPaths | undefined {
  if (!input.browserExecutable) return undefined;
  const paths: BugReplayRunnerPaths = input.isPackaged
    ? {
        nodeExecutable: input.nodeExecutable,
        runnerScript: path.join(input.resourcesPath, 'bug-replay-runner.cjs'),
        playwrightPackage: path.join(input.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright-core'),
        browserExecutable: input.browserExecutable
      }
    : {
        nodeExecutable: input.nodeExecutable,
        runnerScript: path.join(input.appPath, 'dist-electron', 'bug-replay-runner.cjs'),
        playwrightPackage: path.join(input.appPath, 'node_modules', 'playwright-core'),
        browserExecutable: input.browserExecutable
      };
  for (const required of [paths.runnerScript, path.join(paths.playwrightPackage, 'package.json'), paths.browserExecutable]) {
    if (!fs.existsSync(required)) return undefined;
  }
  return paths;
}
