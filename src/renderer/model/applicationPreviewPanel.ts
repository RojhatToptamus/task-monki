import type { ApplicationPreviewSnapshot } from '../../shared/applicationPreview';
import type { Tone } from './viewTypes';
import { applicationPreviewStatus } from './applicationPreviewStatus';

/** The one thing the primary button does in a given state. */
export type PreviewPrimaryAction =
  | 'restore-worktree'
  | 'reconnect-checkout'
  | 'prepare-worktree'
  | 'draft'
  | 'write'
  | 'start-retained'
  | 'save-and-review'
  | 'approve'
  | 'open'
  | 'start';

export type PreviewSecondaryAction = 'cancel' | 'stop' | 'discard' | 'revert' | 'save' | 'draft' | 'write';

export interface PreviewStatusRowView {
  chip: { label: string; tone: Tone };
  url?: string;
  /** Shown beside a primary that requirements disable; it leads to the requirements in Activity. */
  reason?: string;
  primary?: {
    action: PreviewPrimaryAction;
    label: string;
    disabled?: boolean;
    /** Why the primary cannot run yet; its tooltip. */
    disabledReason?: string;
  };
  secondary: Array<{ action: PreviewSecondaryAction; label: string }>;
}

export type PreviewWorktreeAvailability =
  | { state: 'available' }
  | { state: 'missing' | 'failed'; external: boolean; pending: boolean }
  | { state: 'absent'; pending: boolean };

export interface PreviewStatusRowInput {
  snapshot?: ApplicationPreviewSnapshot;
  unavailable: boolean;
  worktree: PreviewWorktreeAvailability;
  /** Why the Preview agent cannot be asked; the setup actions fall back to the editor. */
  agentDisabledReason?: string;
  agentWorking?: boolean;
  /** Unsaved edits or an unsaved proposal in the Configuration tab. */
  dirty: boolean;
  /** The edits under review came from the Preview agent. */
  proposal: boolean;
  blockers: number;
  busy: boolean;
}

/** Derives the status row from the runtime snapshot and the editing state: one primary per state. */
export function previewStatusRow(input: PreviewStatusRowInput): PreviewStatusRowView {
  const { snapshot, worktree, busy } = input;
  if (input.unavailable) return { chip: { label: 'Unavailable', tone: 'error' }, secondary: [] };
  if (worktree.state !== 'available') return worktreeRow(worktree);
  if (!snapshot)
    return {
      chip: { label: 'Checking preview', tone: 'neutral' },
      primary: { action: 'start', label: 'Start preview', disabled: true, disabledReason: 'Reading the preview state.' },
      secondary: []
    };
  const status = snapshot.status;
  const serving = status?.active;
  const latest = status?.candidate ?? status?.latest;
  const review = snapshot.approval ?? snapshot.restartReview;
  const presentation = applicationPreviewStatus(status, !!review);
  const chip = { label: presentation.label, tone: presentation.tone };
  const url = serving ? status?.url : undefined;
  const cancel = { action: 'cancel' as const, label: 'Cancel' };
  if (input.dirty)
    return {
      chip: { label: input.proposal ? 'Proposal ready' : 'Unsaved changes', tone: 'action' },
      url,
      primary: { action: 'save-and-review', label: 'Save and review startup', disabled: busy },
      // A proposal is the agent's and is discarded; your own edits are reverted to the file.
      secondary: [input.proposal ? { action: 'discard', label: 'Discard' } : { action: 'revert', label: 'Revert changes' }, { action: 'save', label: 'Save' }]
    };
  if (review) {
    const restart = !!snapshot.restartReview;
    const blocked = input.blockers > 0;
    return {
      chip: { label: restart ? 'Restart review' : 'Approval needed', tone: 'action' },
      url,
      reason: blocked ? resolveFirst(input.blockers) : undefined,
      primary: {
        action: 'approve',
        label: restart ? 'Approve restart' : 'Approve and start',
        disabled: busy || blocked,
        disabledReason: blocked ? resolveTitle(input.blockers) : undefined
      },
      secondary: [cancel]
    };
  }
  if (status?.candidate) return { chip, url, secondary: [cancel] };
  if (serving)
    return {
      chip,
      url,
      // A saved file is not what serves until a restart applies it; the reason leads to that decision in Activity.
      reason: snapshot.configurationChanged ? 'Changes not applied' : undefined,
      primary: { action: 'open', label: 'Open app', disabled: busy },
      secondary: [{ action: 'stop', label: 'Stop' }]
    };
  if (!snapshot.hasConfigurationFile) {
    // The runtime keeps the last run's configuration; it can run again without the file.
    const retained = !!latest;
    const draft = { action: 'draft' as const, label: input.agentWorking ? 'Agent working…' : 'Draft with Preview agent' };
    const write = { action: 'write' as const, label: retained || input.agentDisabledReason ? 'Write preview.yaml' : 'Write it myself' };
    const author = input.agentDisabledReason ? write : draft;
    return {
      chip: latest ? chip : { label: 'Not configured', tone: 'neutral' },
      primary: { ...(retained ? { action: 'start-retained', label: 'Start from last run' } : author), disabled: busy || (!retained && author.action === 'draft' && !!input.agentWorking) },
      secondary: retained ? [author] : input.agentDisabledReason ? [] : [write]
    };
  }
  const blocked = input.blockers > 0 || !!snapshot.configurationError;
  return {
    chip: latest ? chip : { label: blocked ? 'Not running' : 'Not started', tone: 'neutral' },
    reason: input.blockers > 0 ? resolveFirst(input.blockers) : undefined,
    primary: {
      action: 'start',
      label: latest && !snapshot.restoredRun ? 'Start again' : 'Start preview',
      disabled: busy || blocked,
      disabledReason: input.blockers > 0 ? resolveTitle(input.blockers) : snapshot.configurationError
    },
    secondary: []
  };
}

function worktreeRow(worktree: Exclude<PreviewWorktreeAvailability, { state: 'available' }>): PreviewStatusRowView {
  const external = worktree.state !== 'absent' && worktree.external;
  const absent = worktree.state === 'absent';
  return {
    chip: worktree.pending
      ? { label: absent ? 'Preparing' : 'Restoring', tone: 'info' }
      : { label: absent ? 'Worktree not prepared' : worktree.state === 'failed' ? 'Worktree setup failed' : 'Worktree missing', tone: 'error' },
    primary: {
      action: external ? 'reconnect-checkout' : absent ? 'prepare-worktree' : 'restore-worktree',
      label: external
        ? 'Reconnect checkout'
        : absent
          ? 'Prepare worktree'
          : worktree.state === 'failed'
            ? 'Retry worktree setup'
            : 'Restore worktree',
      disabled: worktree.pending
    },
    secondary: []
  };
}

const resolveFirst = (count: number) => `${count} to resolve`;
const resolveTitle = (count: number) =>
  `Resolve ${count === 1 ? 'this requirement' : `${count} requirements`} before starting.`;

/** Requirements that block a start, counted the way the block lists them: one row per folder, one storage row, one row per missing value. */
export function previewBlockerCount(requirements: ApplicationPreviewSnapshot['requirements']): number {
  if (!requirements) return 0;
  const folders = new Set(
    requirements.sources.filter((source) => !source.connected).map((source) => `${source.declaration}\0${source.directory}`)
  );
  const unavailable = requirements.secrets.filter((secret) => secret.availability !== 'available');
  const storageNeeded =
    (!!requirements.storage && requirements.storage.state !== 'unlocked') ||
    unavailable.some((secret) => secret.availability !== 'missing');
  const missingSecrets = unavailable.filter((secret) => secret.availability === 'missing').length;
  const prerequisites = requirements.description?.prerequisites?.filter((item) => item.status === 'missing').length ?? 0;
  return folders.size + (storageNeeded ? 1 : 0) + missingSecrets + requirements.connections.length + prerequisites;
}

/**
 * Who uses a folder, in one line: runnable services by name, setup steps counted once there are
 * more than two. The full list belongs in the row's title.
 */
export function previewFolderUsage(services: string[], typeOf: (service: string) => string | undefined): string {
  const steps = services.filter((service) => typeOf(service) === 'job');
  const runnable = services.filter((service) => typeOf(service) !== 'job');
  const stepWords = steps.length === 1 ? steps[0]! : `${steps.length} steps`;
  if (!steps.length) return `Used by ${runnable.join(', ')}`;
  if (!runnable.length) return `Used by ${steps.length <= 2 ? steps.join(' and ') : stepWords}`;
  return `Used by ${runnable.join(', ')} and ${stepWords}`;
}
