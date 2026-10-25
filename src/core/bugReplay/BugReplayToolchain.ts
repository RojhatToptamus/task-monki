import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BugReplayRunnerPaths } from './BugReplayRunner';

/**
 * The identity of what executes a clean run: the runner bundle, playwright-core and the browser
 * build. Verdicts compare only within one toolchain, so an update of any of them requalifies the
 * bug before a fix is judged.
 */
export function replayToolchainIdentity(paths: BugReplayRunnerPaths | undefined): string {
  if (!paths) return 'replay-toolchain/unavailable';
  const hash = createHash('sha256');
  const browserInfo = path.join(path.dirname(path.dirname(paths.browserExecutable)), 'Info.plist');
  for (const file of [paths.runnerScript, path.join(paths.playwrightPackage, 'package.json'), browserInfo]) {
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update(`missing:${path.basename(file)}`);
    }
  }
  return `replay-toolchain/${hash.digest('hex').slice(0, 16)}`;
}
