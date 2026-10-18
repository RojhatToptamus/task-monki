import type { BugReplayLeaseRequest } from '../../shared/bugReplay';
import { REPLAY_LEASE_STARTS } from './ReplayAuthorization';
import type { DerivedReplaySpec } from './ReplayDerivation';

/**
 * The facts the person reads before approving clean runs, one per line: the execution boundary
 * first, then when runs happen and how long the approval lasts, then the code, data, secrets,
 * files and network they use.
 */
export function leaseRequestFor(
  derived: DerivedReplaySpec,
  envFiles: string[],
  sameAsRunningPreview: boolean
): BugReplayLeaseRequest {
  const facts: string[] = [
    "Runs this task's code, including agent changes, as your user, without a sandbox",
    'Runs again after each agent turn',
    `The approval covers ${REPLAY_LEASE_STARTS} runs, until Task Monki quits`,
    "Uses a copy of this task's files as they are now"
  ];
  if (derived.managedDatabases.length > 0) facts.push('Preview-managed databases start fresh and are deleted after each run');
  if (derived.secretIds.length > 0) facts.push(`Secrets: ${derived.secretIds.join(', ')}`);
  if (envFiles.length > 0) facts.push(`Env files: ${envFiles.join(', ')}`);
  for (const host of derived.outsideHosts.slice(0, 5)) facts.push(`Calls ${host}`);
  facts.push("The server's network is not restricted");
  return {
    templateDigest: derived.templateDigest,
    title: 'Clean runs need your approval',
    facts,
    // An install step Task Monki adds is named for what it does, not by its internal id.
    commands: derived.commands.map((command) => ({ service: command.added ? 'install' : command.service, command: command.command, directory: command.directory })),
    sameAsRunningPreview
  };
}
