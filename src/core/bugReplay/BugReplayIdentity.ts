import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BugCaseVersionRecord } from './BugReplayRecords';

/** The digest a case version is known by: its document and everything that decides a run's setup. */
export function versionDigest(version: Omit<BugCaseVersionRecord, 'digest'> & { digest?: string }): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        document: version.document,
        recipe: version.recipe.sha256,
        templateDigest: version.templateDigest,
        protectedInputs: version.protectedInputs,
        envFiles: version.envFiles,
        baselineTreeId: version.baselineTreeId
      })
    )
    .digest('hex');
}

/** GIT_CEILING_DIRECTORIES for a clean copy's jobs: hook installers never reach an enclosing repository. */
export function ceilingFor(exportRoot: string): string {
  const parent = path.dirname(exportRoot);
  return `${parent}:${parent}/.tm-ceiling-${path.basename(parent)}`;
}
