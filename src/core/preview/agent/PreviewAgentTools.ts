import { relative } from 'node:path';
import type { AttemptSummary, PreviewStatus } from 'previewhost';
import type { ApplicationPreviewSnapshot } from '../../../shared/applicationPreview';
import type { PreviewRecipeGenerationDraft, PreviewRecipeValidationIssue, Repository } from '../../../shared/contracts';
import { CLIENT_TOOL_MAX_TEXT_BYTES } from '../../agent/clientTools/ClientToolContract';

const MAX_RUNS = 5;
const MAX_LOG_BYTES = 64 * 1024;

export const PREVIEW_LOG_READ_BYTES = MAX_LOG_BYTES;

/** One line for the turn prompt: where the preview stands without a tool call. */
export function describePreviewState(snapshot: ApplicationPreviewSnapshot, proposal?: PreviewRecipeGenerationDraft): string {
  const status = snapshot.status;
  const latest = status?.candidate ?? status?.latest;
  const parts: string[] = [];
  if (proposal) parts.push(`a proposal for ${proposal.fileName} awaits the person's review`);
  parts.push(snapshot.hasConfigurationFile ? 'configuration file present' : 'no configuration file');
  if (snapshot.configurationError) parts.push(`configuration error: ${snapshot.configurationError}`);
  if (snapshot.approval) parts.push('a start awaits the person’s approval');
  else if (snapshot.restartReview) parts.push('a restart awaits the person’s approval');
  if (status?.active) parts.push(`serving${status.url ? ` at ${status.url}` : ''}`);
  if (status?.candidate && status.candidate.id !== status.active?.id) parts.push('a run is starting');
  else if (latest && latest.id !== status?.active?.id) parts.push(`last run ${latest.state}${latest.error ? `: ${latest.error.message}` : ''}`);
  if (!latest) parts.push('never run');
  const blockers = requirementSummary(snapshot);
  if (blockers) parts.push(blockers);
  return parts.join('; ');
}

/** What the agent reads with inspect_preview status: runtime facts, never file contents or secret values. */
export function previewStatusReport(input: {
  snapshot: ApplicationPreviewSnapshot;
  configurationFile?: string;
  proposal?: PreviewRecipeGenerationDraft;
  repositories: Repository[];
  /** The task's registered repository checkout, from which preview.yaml resolves folders outside the worktree. */
  projectRepositoryPath?: string;
}): string {
  const { snapshot } = input;
  const status = snapshot.status;
  const runs = attempts(status).slice(0, MAX_RUNS).map((attempt) => ({
    id: attempt.id,
    state: attempt.state,
    startedAt: attempt.startedAt,
    readyAt: attempt.readyAt,
    serving: attempt.id === status?.active?.id || undefined,
    error: attempt.error?.message,
    services: attempt.services
      ? Object.fromEntries(
          Object.entries(attempt.services).map(([id, service]) => [
            id,
            { type: service.type, state: service.state, url: service.url, waitingFor: service.waitingFor, error: service.error?.message }
          ])
        )
      : undefined
  }));
  const report = {
    repositories: input.repositories.slice(0, 50).map(({ name, path, branch, status }) => ({
      name,
      path,
      branch,
      status,
      // Portable: the path preview.yaml uses for this checkout, never one computed from the temporary worktree.
      ...(input.projectRepositoryPath ? { configurationPath: relative(input.projectRepositoryPath, path) || '.' } : {})
    })),
    repositoryAccess: 'These are registered checkouts, not read grants. Ask which checkout to use, then request read-only access before inspecting it. Do not switch branches or create worktrees. In preview.yaml, use a checkout\'s configurationPath as its cwd: folders outside the worktree resolve from the task\'s registered repository.',
    repositoriesTruncated: input.repositories.length > 50 || undefined,
    configurationFile: input.configurationFile
      ? { name: input.configurationFile, note: 'Read it with your file tools; its contents are not repeated here.' }
      : null,
    configurationError: snapshot.configurationError,
    proposalUnderReview: input.proposal ? { fileName: input.proposal.fileName, summary: input.proposal.report.summary } : null,
    serving: status?.active ? { attemptId: status.active.id, url: status.url } : null,
    approvalPending: snapshot.approval
      ? { attemptId: snapshot.approval.attemptId, foldersOutsideWorktree: snapshot.approval.affected?.map((item) => item.directory) }
      : snapshot.restartReview
        ? { restart: true, foldersOutsideWorktree: snapshot.restartReview.affected.map((item) => item.directory) }
        : null,
    requirements: snapshot.requirements
      ? {
          secrets: snapshot.requirements.secrets.map((secret) => ({ reference: secret.id, availability: secret.availability, bindings: secret.bindings })),
          connections: snapshot.requirements.connections,
          sources: snapshot.requirements.sources.map((source) => ({ service: source.service, directory: source.directory, connected: source.connected, missing: source.missing })),
          storage: snapshot.requirements.storage?.state,
          prerequisites: snapshot.requirements.description?.prerequisites?.map((item) => ({ requirement: item.requirement, status: item.status, service: item.service, message: item.message }))
        }
      : null,
    diagnosis: snapshot.diagnosis
      ? {
          attemptId: snapshot.diagnosis.attemptId,
          service: snapshot.diagnosis.service,
          title: snapshot.diagnosis.title,
          summary: snapshot.diagnosis.summary,
          observed: snapshot.diagnosis.observed,
          unknown: snapshot.diagnosis.unknown,
          recommendedAction: snapshot.diagnosis.action
        }
      : null,
    runs,
    retainedData: status?.data?.resources.map((resource) => ({ name: resource.name, type: resource.type })),
    restoredRun: snapshot.restoredRun || undefined
  };
  return bounded(JSON.stringify(report, (_key, value: unknown) => (value === undefined ? undefined : value), 2));
}

/** The final lines of one run's output, already secret-redacted by the runtime. */
/** What the agent reads when the runtime that captured a run's output has restarted since. */
export const EXPIRED_LOGS_REPORT =
  'The logs of this run expired when the Preview runtime restarted. Use inspect_preview status and the configuration file instead, or ask the person to start the preview again for fresh logs.';

export function previewLogsReport(input: { attempt: AttemptSummary; source?: string; text: string; truncated: boolean; lines: number }): string {
  const all = input.text.replace(/\r\n/g, '\n').split('\n');
  if (all.at(-1) === '') all.pop();
  const shown = all.slice(-input.lines);
  const header = [
    `Run ${input.attempt.id} (${input.attempt.state}, started ${input.attempt.startedAt})${input.source ? `, source ${input.source}` : ''}.`,
    all.length > shown.length ? `Showing the last ${shown.length} of ${all.length} lines.` : `${shown.length} lines.`,
    input.truncated ? 'Earlier output was dropped by the runtime.' : undefined
  ]
    .filter(Boolean)
    .join(' ');
  return bounded(`${header}\n\n${shown.join('\n')}`);
}

/** What the agent reads back from propose_preview_configuration. */
export function proposalReport(result: { status: 'READY'; draft: PreviewRecipeGenerationDraft } | { status: 'INVALID'; issues: PreviewRecipeValidationIssue[] }): string {
  if (result.status === 'READY') {
    return `Accepted. The proposal for ${result.draft.fileName} is open in the Configuration tab for the person to review${result.draft.replacesExistingFile ? ' as changes to the existing file' : ''}. Nothing runs until they save and start it. Do not submit it again unless they ask for changes; explain it briefly instead.`;
  }
  return `Rejected. Correct these problems and submit the complete file again:\n${result.issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')}`;
}

function attempts(status: PreviewStatus | undefined): AttemptSummary[] {
  if (!status) return [];
  const seen = new Set<string>();
  return [status.candidate, status.active, status.latest, ...(status.history ?? [])]
    .filter((attempt): attempt is AttemptSummary => !!attempt && !seen.has(attempt.id) && (seen.add(attempt.id), true))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function requirementSummary(snapshot: ApplicationPreviewSnapshot): string | undefined {
  const requirements = snapshot.requirements;
  if (!requirements) return undefined;
  const items = [
    ...requirements.sources.filter((source) => !source.connected).map((source) => `folder ${source.directory} for ${source.service} not connected`),
    ...requirements.secrets.filter((secret) => secret.availability !== 'available').map((secret) => `secret ${secret.id} ${secret.availability}`),
    ...requirements.connections.map((connection) => `connection ${connection} unset`),
    ...(requirements.storage && requirements.storage.state !== 'unlocked' ? [`secret storage ${requirements.storage.state}`] : [])
  ];
  return items.length ? `blocked by: ${items.join(', ')}` : undefined;
}

function bounded(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= CLIENT_TOOL_MAX_TEXT_BYTES) return text;
  const suffix = '\n…[truncated]';
  return `${Buffer.from(text, 'utf8').subarray(0, CLIENT_TOOL_MAX_TEXT_BYTES - Buffer.byteLength(suffix)).toString('utf8')}${suffix}`;
}
