import type { BugReplayLeaseFact, BugReplayLeaseRequest } from '../../shared/bugReplay';
import { BUG_APPROVAL_WORD } from '../../shared/bugReplayClaims';
import { REPLAY_LEASE_STARTS } from './ReplayAuthorization';
import type { DerivedReplaySpec } from './ReplayDerivation';

/**
 * The facts the person reads before approving replays, one label and value per row: the
 * execution boundary first, then the code, when replays happen and how long the approval lasts,
 * then the data, secrets, files and network they use.
 */
export function leaseRequestFor(
  derived: DerivedReplaySpec,
  envFiles: string[],
  sameAsRunningPreview: boolean
): BugReplayLeaseRequest {
  const facts: BugReplayLeaseFact[] = [
    { label: 'Runs as', value: 'Your user, without a sandbox' },
    { label: 'Code', value: "A copy of this task's files, with the agent's changes" },
    { label: 'When', value: 'After each agent turn' },
    { label: 'Approval', value: `${REPLAY_LEASE_STARTS} replays, until Task Monki quits` }
  ];
  if (derived.managedDatabases.length > 0) facts.push({ label: 'Data', value: 'Fresh databases, deleted after each replay' });
  if (derived.secretIds.length > 0) facts.push({ label: 'Secrets', value: derived.secretIds.join(', ') });
  if (envFiles.length > 0) facts.push({ label: 'Env files', value: envFiles.join(', ') });
  facts.push({ label: 'Network', value: 'Not restricted' });
  if (derived.outsideHosts.length > 0) facts.push({ label: 'Calls', value: derived.outsideHosts.slice(0, 5).join(', ') });
  return {
    approvalDigest: derived.approvalDigest,
    title: BUG_APPROVAL_WORD,
    facts,
    // An install step Task Monki adds is named for what it does, not by its internal id.
    commands: derived.commands.map((command) => ({ service: command.added ? 'install' : command.service, command: command.command, directory: command.directory })),
    sameAsRunningPreview
  };
}
