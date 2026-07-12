import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentExecutionSettings,
  AgentProtocolMessageReference,
  AgentRunMode,
  BranchPublicationStatus,
  CiChecksStatus,
  CodexReviewResult,
  CompletionPolicy,
  DomainEvent,
  GitHubCheckDetailRecord,
  GitSnapshotRecord,
  GitStatus,
  InteractionRequestRecord,
  InteractionRequestType,
  MergeStatus,
  PullRequestStatus,
  ReviewStatus,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord,
  PreviewGenerationState
} from '../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../shared/contracts';
import { buildDiffEvidence, inspectGitSnapshot } from '../core/git/GitSnapshotService';
import { git } from '../core/git/gitCli';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { createDomainEvent } from '../core/storage/domainEvent';
import { WorktreeService } from '../core/worktree/WorktreeService';
import { DETERMINISTIC_DEV_SEED_ENV_VAR } from './devSeedEnvironment';

export const TASK_MONKI_DEV_SEED_VERSION = 'task-monki-dev-seed/v1';
export const TASK_MONKI_DEV_SEED_MARKER = '.task-monki-dev-seed';

export type DevSeedScenarioGroup =
  | 'board'
  | 'agent'
  | 'review'
  | 'delivery'
  | 'completion'
  | 'workflow'
  | 'preview';

export type DevSeedScenarioSet = 'all' | DevSeedScenarioGroup;

export interface DevSeedScenarioDefinition {
  slug: string;
  group: DevSeedScenarioGroup;
  title: string;
  description: string;
  tags: string[];
}

export interface DevSeedManifestScenario extends DevSeedScenarioDefinition {
  taskId: string;
  relatedTaskIds?: string[];
}

export interface DevSeedManifest {
  catalogVersion: typeof TASK_MONKI_DEV_SEED_VERSION;
  storeSchemaVersion: typeof TASK_STORE_SCHEMA_VERSION;
  generatedAt: string;
  deterministicContract: string;
  scenarioSet: DevSeedScenarioSet;
  rootDir: string;
  storeDir: string;
  repositoryPath: string;
  worktreeRoot: string;
  previewRoot: string;
  appSettingsPath: string;
  manifestPath: string;
  envFilePath: string;
  env: {
    TASK_MANAGER_STORE_DIR: string;
    TASK_MANAGER_APP_SETTINGS_PATH: string;
    TASK_MANAGER_REPO_PATH: string;
    TASK_MANAGER_WORKTREE_ROOT: string;
    TASK_MANAGER_PREVIEW_ROOT: string;
    TASK_MANAGER_PREVIEW_RECONCILE: '0';
    TASK_MANAGER_DETERMINISTIC_SEED: '1';
  };
  counts: {
    tasks: number;
    scenarios: number;
    runs: number;
    worktrees: number;
    events: number;
  };
  scenarios: DevSeedManifestScenario[];
}

export interface SeedTaskMonkiDevelopmentDataOptions {
  rootDir?: string;
  storeDir?: string;
  repositoryPath?: string;
  worktreeRoot?: string;
  previewRoot?: string;
  appSettingsPath?: string;
  scenarioSet?: DevSeedScenarioSet;
  reset?: boolean;
}

const DEFAULT_AGENT_SETTINGS: AgentExecutionSettings = {
  model: 'scenario-model',
  reasoningEffort: 'low',
  sandbox: 'WORKSPACE_WRITE',
  networkAccess: false,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user'
};

export const DEV_SEED_SCENARIOS: DevSeedScenarioDefinition[] = [
  scenario('board-backlog', 'board', 'Backlog task', 'Task waiting before work is accepted.', [
    'phase:BACKLOG'
  ]),
  scenario('board-ready', 'board', 'Ready task', 'Task ready for worktree preparation.', [
    'phase:READY'
  ]),
  scenario('worktree-clean', 'board', 'Clean worktree', 'Prepared worktree with clean Git evidence.', [
    'worktree:PRESENT',
    'git:CLEAN'
  ]),
  scenario('worktree-missing', 'board', 'Missing worktree', 'Known task worktree is missing locally.', [
    'worktree:MISSING'
  ]),
  scenario('worktree-error', 'board', 'Worktree error', 'Worktree setup failed with stored evidence.', [
    'worktree:ERROR'
  ]),
  scenario('agent-running', 'agent', 'Agent running', 'Implementation turn is actively running.', [
    'agent:RUNNING'
  ]),
  scenario(
    'agent-awaiting-approval',
    'agent',
    'Awaiting approval',
    'Agent turn is blocked on a command approval request.',
    ['agent:AWAITING_APPROVAL', 'interaction:COMMAND_APPROVAL']
  ),
  scenario(
    'agent-awaiting-user-input',
    'agent',
    'Awaiting user input',
    'Agent turn is blocked on a user input request.',
    ['agent:AWAITING_USER_INPUT', 'interaction:USER_INPUT']
  ),
  scenario('agent-interrupted', 'agent', 'Interrupted run', 'Agent turn was interrupted.', [
    'agent:INTERRUPTED'
  ]),
  scenario('agent-runtime-lost', 'agent', 'Runtime lost', 'Agent runtime was lost and needs recovery.', [
    'agent:RECOVERY_REQUIRED',
    'recovery:runtime-lost'
  ]),
  scenario(
    'agent-ambiguous-mutation',
    'agent',
    'Ambiguous mutation',
    'Provider mutation delivery is ambiguous and requires user action.',
    ['agent:RECOVERY_REQUIRED', 'recovery:ambiguous']
  ),
  scenario('interaction-stale', 'agent', 'Stale interaction', 'An approval request became stale.', [
    'interaction:STALE'
  ]),
  scenario('review-not-run', 'review', 'Review not run', 'Implementation completed without Codex review.', [
    'codex-review:NOT_RUN'
  ]),
  scenario('review-running', 'review', 'Review running', 'Codex review run is active.', [
    'codex-review:RUNNING'
  ]),
  scenario('review-passed', 'review', 'Review passed', 'Codex review passed with structured result.', [
    'codex-review:PASSED'
  ]),
  scenario(
    'review-needs-changes',
    'review',
    'Review needs changes',
    'Codex review found actionable issues.',
    ['codex-review:NEEDS_CHANGES']
  ),
  scenario(
    'review-inconclusive',
    'review',
    'Review inconclusive',
    'Codex review completed without a definitive verdict.',
    ['codex-review:INCONCLUSIVE']
  ),
  scenario('review-failed', 'review', 'Review failed', 'Codex review failed before completion.', [
    'codex-review:FAILED'
  ]),
  scenario('review-canceled', 'review', 'Review canceled', 'Codex review was canceled.', [
    'codex-review:CANCELED'
  ]),
  scenario(
    'review-stale-after-follow-up',
    'review',
    'Stale review after follow-up',
    'A completed follow-up made the previous review stale.',
    ['codex-review:STALE', 'mode:FOLLOW_UP']
  ),
  scenario(
    'review-follow-up-active',
    'review',
    'Follow-up active',
    'Follow-up implementation is running after review findings.',
    ['codex-review:STALE', 'agent:RUNNING']
  ),
  scenario(
    'no-pr-git-not-inspected',
    'delivery',
    'No PR, Git not inspected',
    'PR creation is blocked until Git evidence is refreshed.',
    ['pr:NO_PR', 'git:NOT_INSPECTED']
  ),
  scenario('no-pr-clean', 'delivery', 'No PR, clean branch', 'No task diff exists to publish.', [
    'pr:NO_PR',
    'git:CLEAN'
  ]),
  scenario('no-pr-dirty', 'delivery', 'No PR, dirty worktree', 'Uncommitted work can be published.', [
    'pr:NO_PR',
    'git:DIRTY'
  ]),
  scenario('no-pr-conflicted', 'delivery', 'No PR, conflicted branch', 'Git conflicts block PR creation.', [
    'pr:NO_PR',
    'git:CONFLICTED'
  ]),
  scenario(
    'no-pr-unavailable',
    'delivery',
    'No PR, Git unavailable',
    'Git status could not be collected.',
    ['pr:NO_PR', 'git:UNAVAILABLE']
  ),
  scenario('no-pr-unknown', 'delivery', 'No PR, Git unknown', 'Git status is unknown.', [
    'pr:NO_PR',
    'git:UNKNOWN'
  ]),
  scenario(
    'no-pr-publish-in-progress',
    'delivery',
    'No PR, publish in progress',
    'Branch publication is already running.',
    ['pr:NO_PR', 'branch:PUSHING']
  ),
  scenario(
    'no-pr-publish-failed-retryable',
    'delivery',
    'No PR, retryable publish failure',
    'Last branch publication failed but can be retried.',
    ['pr:NO_PR', 'branch:FAILED']
  ),
  scenario(
    'no-pr-publish-failed-remote-newer',
    'delivery',
    'No PR, remote newer',
    'Remote branch has newer commits and must be reconciled.',
    ['pr:NO_PR', 'branch:FAILED', 'freshness:DIVERGED']
  ),
  scenario(
    'delivery-branch-pushed-no-pr',
    'delivery',
    'Branch pushed, no PR',
    'Branch is published but no pull request is linked.',
    ['pr:NO_PR', 'branch:PUSHED']
  ),
  scenario('delivery-draft-pr', 'delivery', 'Draft PR', 'Draft pull request exists.', [
    'pr:DRAFT'
  ]),
  scenario('delivery-open-pr', 'delivery', 'Open PR', 'Ready pull request exists without blockers.', [
    'pr:OPEN'
  ]),
  scenario('delivery-checks-pending', 'delivery', 'Checks pending', 'GitHub checks are pending.', [
    'pr:CHECKS_PENDING'
  ]),
  scenario('delivery-checks-failed', 'delivery', 'Checks failed', 'GitHub checks failed with details.', [
    'pr:CHECKS_FAILED'
  ]),
  scenario(
    'delivery-checks-canceled',
    'delivery',
    'Checks canceled',
    'GitHub checks were canceled.',
    ['pr:CHECKS_CANCELED']
  ),
  scenario(
    'delivery-no-required-checks',
    'delivery',
    'No required checks',
    'Checks ran, but no required checks reported.',
    ['pr:NO_REQUIRED_CHECKS']
  ),
  scenario(
    'delivery-review-waiting',
    'delivery',
    'GitHub review waiting',
    'GitHub review is requested and pending.',
    ['pr:GITHUB_REVIEW_WAITING']
  ),
  scenario(
    'delivery-changes-requested',
    'delivery',
    'GitHub changes requested',
    'GitHub review requested changes.',
    ['pr:GITHUB_CHANGES_REQUESTED']
  ),
  scenario('delivery-ready-to-merge', 'delivery', 'Ready to merge', 'PR is mergeable and checks passed.', [
    'pr:READY_TO_MERGE'
  ]),
  scenario('delivery-merged', 'delivery', 'Merged PR', 'PR is merged and completion policy is satisfied.', [
    'pr:MERGED',
    'phase:DONE'
  ]),
  scenario(
    'delivery-closed-unmerged',
    'delivery',
    'Closed without merge',
    'PR was closed without being merged.',
    ['pr:CLOSED_UNMERGED']
  ),
  scenario(
    'delivery-stale-evidence',
    'delivery',
    'Stale PR evidence',
    'CI evidence is for an older PR head.',
    ['pr:STALE']
  ),
  scenario(
    'delivery-local-not-pushed',
    'delivery',
    'Local changes not pushed',
    'Local branch has changes newer than PR evidence.',
    ['pr:LOCAL_NOT_PUSHED']
  ),
  scenario(
    'delivery-pr-newer-commits',
    'delivery',
    'PR has newer commits',
    'Remote PR head is newer than this worktree.',
    ['pr:PR_NEWER_COMMITS']
  ),
  scenario(
    'delivery-branch-diverged',
    'delivery',
    'Branch diverged',
    'Local branch and PR branch both changed.',
    ['pr:BRANCH_DIVERGED']
  ),
  scenario(
    'completion-merged-and-verified-failing',
    'completion',
    'Merged and verified, failing checks',
    'Merged PR is not enough because checks failed.',
    ['completion:MERGED_AND_VERIFIED', 'ci:FAILING']
  ),
  scenario(
    'completion-merged-and-verified-stale',
    'completion',
    'Merged and verified, stale checks',
    'Merged PR has stale verification evidence.',
    ['completion:MERGED_AND_VERIFIED', 'ci:STALE']
  ),
  scenario(
    'completion-merged-and-verified-passing',
    'completion',
    'Merged and verified, passing checks',
    'Merged PR plus passing checks completes the task.',
    ['completion:MERGED_AND_VERIFIED', 'ci:PASSING', 'phase:DONE']
  ),
  scenario(
    'completion-manual-merged',
    'completion',
    'Manual completion with merged PR',
    'Manual policy is not auto-completed by a merged PR.',
    ['completion:MANUAL', 'pr:MERGED']
  ),
  scenario('workflow-fork-alternative', 'workflow', 'Fork alternative', 'Task has a forked alternative.', [
    'workflow:fork'
  ]),
  scenario('task-canceled', 'workflow', 'Canceled task', 'Task is canceled as a terminal workflow state.', [
    'phase:CANCELED'
  ]),
  scenario('task-archived', 'workflow', 'Archived task', 'Task is archived as a terminal workflow state.', [
    'phase:ARCHIVED'
  ]),
  scenario('preview-missing-recipe', 'preview', 'Preview recipe missing', 'The task has a worktree but no explicit preview recipe.', ['preview:UNAVAILABLE']),
  scenario('preview-approval-required', 'preview', 'Preview approval required', 'A resolved native plan awaits explicit approval.', ['preview:APPROVAL_REQUIRED']),
  scenario('preview-active-approval-required', 'preview', 'Active preview needs new approval', 'The current preview remains actionable while a changed plan awaits approval.', ['preview:READY', 'replacement:APPROVAL_REQUIRED']),
  scenario('preview-preparing', 'preview', 'Preview preparing', 'Captured source preparation is in progress.', ['preview:PREPARING_SOURCE']),
  scenario('preview-ready', 'preview', 'Preview ready', 'Readiness passed and the stable route is attached.', ['preview:READY']),
  scenario('preview-oci-ready', 'preview', 'OCI preview ready', 'PostgreSQL and Redis are ready after the selected migration and seed scenario.', ['preview:READY', 'resources:POSTGRES_REDIS']),
  scenario('preview-replacing', 'preview', 'Preview replacing', 'The active preview stays routed while a candidate waits for readiness.', ['preview:REPLACING']),
  scenario('preview-replacement-failed', 'preview', 'Preview replacement failed', 'A failed candidate leaves the active preview available.', ['preview:READY', 'replacement:FAILED']),
  scenario('preview-failed', 'preview', 'Preview failed', 'A preview job failed with retained bounded logs.', ['preview:FAILED']),
  scenario('preview-stale', 'preview', 'Preview stale', 'A ready preview serves captured source older than current Git evidence.', ['preview:READY', 'freshness:STALE']),
  scenario('preview-stopped', 'preview', 'Preview stopped', 'Owned runtime state was removed while compact evidence remains.', ['preview:STOPPED']),
  scenario('preview-recovery-required', 'preview', 'Preview recovery required', 'Restart recovery has not yet verified the recorded process.', ['preview:RECOVERY_REQUIRED']),
  scenario('preview-cleanup-incomplete', 'preview', 'Preview cleanup incomplete', 'Task Monki refused cleanup because ownership could not be verified.', ['preview:CLEANUP_INCOMPLETE'])
];

interface SeedPaths {
  rootDir: string;
  storeDir: string;
  repositoryPath: string;
  worktreeRoot: string;
  previewRoot: string;
  appSettingsPath: string;
  manifestPath: string;
  envFilePath: string;
}

interface SeedContext extends SeedPaths {
  scenarioSet: DevSeedScenarioSet;
  store: FileTaskStore;
  worktrees: WorktreeService;
  serverInstanceId: string;
  baseSha: string;
  scenarios: DevSeedManifestScenario[];
  turnCounter: number;
  protocolCounter: number;
  prCounter: number;
}

interface SeededTaskState {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  run?: RunRecord;
}

interface SeededScenarioResult {
  task: Task;
  relatedTaskIds?: string[];
}

export function defaultDevSeedRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, '.local/task-monki-dev-seed');
}

export async function seedTaskMonkiDevelopmentData(
  options: SeedTaskMonkiDevelopmentDataOptions = {}
): Promise<DevSeedManifest> {
  const scenarioSet = options.scenarioSet ?? 'all';
  assertValidScenarioSet(scenarioSet);
  const paths = resolveSeedPaths(options);

  if (options.reset) {
    await resetSeedRoot(paths.rootDir);
  } else {
    const existing = await readExistingManifest(paths.manifestPath);
    if (existing) {
      return existing;
    }
    await assertEmptyOrMissing(paths.rootDir);
  }

  await fs.mkdir(paths.rootDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.rootDir, TASK_MONKI_DEV_SEED_MARKER),
    `${TASK_MONKI_DEV_SEED_VERSION}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  await initSeedRepository(paths.rootDir, paths.repositoryPath);

  const store = new FileTaskStore(paths.storeDir);
  await store.init();
  const appSettingsStore = new AppSettingsStore(paths.appSettingsPath);
  await appSettingsStore.update({
    firstLaunchSetupCompleted: true,
    defaultModel: DEFAULT_AGENT_SETTINGS.model ?? null,
    defaultReasoningEffort: DEFAULT_AGENT_SETTINGS.reasoningEffort ?? null,
    reviewModel: DEFAULT_AGENT_SETTINGS.model ?? null,
    reviewReasoningEffort: DEFAULT_AGENT_SETTINGS.reasoningEffort ?? null,
    repositories: {
      knownPaths: [paths.repositoryPath],
      selectedPath: paths.repositoryPath
    }
  });

  const server = await store.createAgentServer({
    provider: 'codex',
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    executable: 'codex-seed-runtime',
    argv: ['codex-seed-runtime', '--deterministic-scenarios'],
    runtimeVersion: TASK_MONKI_DEV_SEED_VERSION,
    schemaVersion: 'seed'
  });
  await store.updateAgentServer(server.id, {
    status: 'READY',
    initializedAt: new Date().toISOString(),
    lastHealthAt: new Date().toISOString()
  });

  const ctx: SeedContext = {
    ...paths,
    scenarioSet,
    store,
    worktrees: new WorktreeService(paths.worktreeRoot),
    serverInstanceId: server.id,
    baseSha: (await git(paths.repositoryPath, ['rev-parse', 'HEAD'])).trim(),
    scenarios: [],
    turnCounter: 0,
    protocolCounter: 0,
    prCounter: 100
  };

  for (const definition of scenariosForSet(scenarioSet)) {
    const result = await seedScenario(ctx, definition);
    ctx.scenarios.push({
      ...definition,
      taskId: result.task.id,
      relatedTaskIds: result.relatedTaskIds
    });
  }
  await store.updateAgentServer(server.id, {
    status: 'EXITED',
    exitedAt: new Date().toISOString(),
    exitReason: 'Seeded App Server record; no live provider process is attached.'
  });

  const snapshot = await store.snapshot();
  const manifest: DevSeedManifest = {
    catalogVersion: TASK_MONKI_DEV_SEED_VERSION,
    storeSchemaVersion: TASK_STORE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    deterministicContract:
      'Scenario slugs, titles, and manifest entries are stable. Store IDs and timestamps are generated by FileTaskStore and must be read from this manifest.',
    scenarioSet,
    ...paths,
    env: {
      TASK_MANAGER_STORE_DIR: paths.storeDir,
      TASK_MANAGER_APP_SETTINGS_PATH: paths.appSettingsPath,
      TASK_MANAGER_REPO_PATH: paths.repositoryPath,
      TASK_MANAGER_WORKTREE_ROOT: paths.worktreeRoot,
      TASK_MANAGER_PREVIEW_ROOT: paths.previewRoot,
      TASK_MANAGER_PREVIEW_RECONCILE: '0',
      [DETERMINISTIC_DEV_SEED_ENV_VAR]: '1'
    },
    counts: {
      tasks: snapshot.tasks.length,
      scenarios: ctx.scenarios.length,
      runs: snapshot.runs.length,
      worktrees: snapshot.worktrees.length,
      events: snapshot.events.length
    },
    scenarios: ctx.scenarios
  };

  await fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.writeFile(paths.envFilePath, formatEnvFile(manifest.env), {
    encoding: 'utf8',
    mode: 0o600
  });
  await Promise.all([
    fs.chmod(paths.manifestPath, 0o600),
    fs.chmod(paths.envFilePath, 0o600)
  ]);
  return manifest;
}

function scenario(
  slug: string,
  group: DevSeedScenarioGroup,
  title: string,
  description: string,
  tags: string[]
): DevSeedScenarioDefinition {
  return { slug, group, title, description, tags };
}

function scenariosForSet(set: DevSeedScenarioSet): DevSeedScenarioDefinition[] {
  return set === 'all'
    ? DEV_SEED_SCENARIOS
    : DEV_SEED_SCENARIOS.filter((scenarioDefinition) => scenarioDefinition.group === set);
}

function assertValidScenarioSet(value: string): asserts value is DevSeedScenarioSet {
  if (!['all', 'board', 'agent', 'review', 'delivery', 'completion', 'workflow', 'preview'].includes(value)) {
    throw new Error(`Unknown seed scenario set: ${value}`);
  }
}

function resolveSeedPaths(options: SeedTaskMonkiDevelopmentDataOptions): SeedPaths {
  const rootDir = path.resolve(options.rootDir ?? defaultDevSeedRoot());
  return {
    rootDir,
    storeDir: path.resolve(options.storeDir ?? path.join(rootDir, 'store')),
    repositoryPath: path.resolve(options.repositoryPath ?? path.join(rootDir, 'repo')),
    worktreeRoot: path.resolve(options.worktreeRoot ?? path.join(rootDir, 'worktrees')),
    previewRoot: path.resolve(options.previewRoot ?? path.join(rootDir, 'preview-runtime')),
    appSettingsPath: path.resolve(options.appSettingsPath ?? path.join(rootDir, 'app-settings.json')),
    manifestPath: path.join(rootDir, 'manifest.json'),
    envFilePath: path.join(rootDir, 'dev-api.env')
  };
}

async function resetSeedRoot(rootDir: string): Promise<void> {
  if (!(await pathExists(rootDir))) {
    return;
  }
  const entries = await fs.readdir(rootDir);
  if (entries.length === 0) {
    await fs.rm(rootDir, { recursive: true, force: true });
    return;
  }
  const marker = path.join(rootDir, TASK_MONKI_DEV_SEED_MARKER);
  const manifest = path.join(rootDir, 'manifest.json');
  if (!(await pathExists(marker)) && !(await readExistingManifest(manifest))) {
    throw new Error(
      `Refusing to reset ${rootDir}; it is not marked as Task Monki seed-owned data.`
    );
  }
  await fs.rm(rootDir, { recursive: true, force: true });
}

async function assertEmptyOrMissing(rootDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(
      `${rootDir} already contains files. Re-run with --reset if it is seed-owned data.`
    );
  }
}

async function readExistingManifest(manifestPath: string): Promise<DevSeedManifest | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as DevSeedManifest;
    return parsed.catalogVersion === TASK_MONKI_DEV_SEED_VERSION ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

async function seedScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededScenarioResult> {
  switch (definition.slug) {
    case 'board-backlog': {
      const task = await createSeedTask(ctx, definition);
      return { task: await ctx.store.transitionTask(task.id, 'BACKLOG', 'Seed backlog state') };
    }
    case 'board-ready':
      return { task: await createSeedTask(ctx, definition) };
    case 'worktree-clean': {
      const state = await createWorktreeState(ctx, definition, 'clean');
      return { task: state.task };
    }
    case 'worktree-missing':
      return { task: (await createWorktreeState(ctx, definition, 'missing')).task };
    case 'worktree-error':
      return { task: (await createWorktreeState(ctx, definition, 'error')).task };
    case 'agent-running':
      return { task: (await createAgentScenario(ctx, definition, 'running')).task };
    case 'agent-awaiting-approval':
      return { task: (await createAgentScenario(ctx, definition, 'approval')).task };
    case 'agent-awaiting-user-input':
      return { task: (await createAgentScenario(ctx, definition, 'user-input')).task };
    case 'agent-interrupted':
      return { task: (await createAgentScenario(ctx, definition, 'interrupted')).task };
    case 'agent-runtime-lost':
      return { task: (await createAgentScenario(ctx, definition, 'runtime-lost')).task };
    case 'agent-ambiguous-mutation':
      return { task: (await createAgentScenario(ctx, definition, 'ambiguous')).task };
    case 'interaction-stale':
      return { task: (await createAgentScenario(ctx, definition, 'interaction-stale')).task };
    case 'review-not-run':
    case 'review-running':
    case 'review-passed':
    case 'review-needs-changes':
    case 'review-inconclusive':
    case 'review-failed':
    case 'review-canceled':
    case 'review-stale-after-follow-up':
    case 'review-follow-up-active':
      return { task: (await createReviewScenario(ctx, definition)).task };
    case 'no-pr-git-not-inspected':
    case 'no-pr-clean':
    case 'no-pr-dirty':
    case 'no-pr-conflicted':
    case 'no-pr-unavailable':
    case 'no-pr-unknown':
    case 'no-pr-publish-in-progress':
    case 'no-pr-publish-failed-retryable':
    case 'no-pr-publish-failed-remote-newer':
    case 'delivery-branch-pushed-no-pr':
      return { task: (await createNoPrScenario(ctx, definition)).task };
    case 'delivery-draft-pr':
    case 'delivery-open-pr':
    case 'delivery-checks-pending':
    case 'delivery-checks-failed':
    case 'delivery-checks-canceled':
    case 'delivery-no-required-checks':
    case 'delivery-review-waiting':
    case 'delivery-changes-requested':
    case 'delivery-ready-to-merge':
    case 'delivery-merged':
    case 'delivery-closed-unmerged':
    case 'delivery-stale-evidence':
    case 'delivery-local-not-pushed':
    case 'delivery-pr-newer-commits':
    case 'delivery-branch-diverged':
      return { task: (await createDeliveryScenario(ctx, definition)).task };
    case 'completion-merged-and-verified-failing':
    case 'completion-merged-and-verified-stale':
    case 'completion-merged-and-verified-passing':
    case 'completion-manual-merged':
      return { task: (await createCompletionScenario(ctx, definition)).task };
    case 'workflow-fork-alternative':
      return createForkScenario(ctx, definition);
    case 'task-canceled': {
      const state = await createImplementedTask(ctx, definition);
      return { task: await ctx.store.transitionTask(state.task.id, 'CANCELED', 'Seed canceled state') };
    }
    case 'task-archived': {
      const state = await createImplementedTask(ctx, definition);
      return { task: await ctx.store.transitionTask(state.task.id, 'ARCHIVED', 'Seed archived state') };
    }
    case 'preview-missing-recipe':
    case 'preview-approval-required':
    case 'preview-active-approval-required':
    case 'preview-preparing':
    case 'preview-ready':
    case 'preview-oci-ready':
    case 'preview-replacing':
    case 'preview-replacement-failed':
    case 'preview-failed':
    case 'preview-stale':
    case 'preview-stopped':
    case 'preview-recovery-required':
    case 'preview-cleanup-incomplete':
      return { task: (await createPreviewScenario(ctx, definition)).task };
    default:
      throw new Error(`No seed builder registered for ${definition.slug}`);
  }
}

async function createSeedTask(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition,
  completionPolicy: CompletionPolicy = 'LOCAL_ACCEPTANCE'
): Promise<Task> {
  return ctx.store.createTask({
    title: `[seed:${definition.slug}] ${definition.title}`,
    prompt: [
      `Seed scenario: ${definition.slug}`,
      definition.description,
      '',
      'This task exists so agents can verify UI and workflow states without inventing local state.'
    ].join('\n'),
    repositoryPath: ctx.repositoryPath,
    completionPolicy,
    agentSettings: DEFAULT_AGENT_SETTINGS
  });
}

async function createWorktreeState(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition,
  gitState: 'none' | 'clean' | 'dirty' | 'committed' | 'missing' | 'error',
  completionPolicy: CompletionPolicy = 'LOCAL_ACCEPTANCE'
): Promise<SeededTaskState> {
  let task = await createSeedTask(ctx, definition, completionPolicy);
  const branchName = `codex/seed-${definition.slug}`;
  const { iteration, worktree } = await ctx.store.createIterationAndWorktree({
    task,
    branchName,
    worktreePath: path.join(ctx.worktreeRoot, definition.slug),
    baseRef: 'main',
    baseSha: ctx.baseSha
  });

  if (gitState === 'error') {
    const failed = await ctx.store.updateWorktree(
      {
        ...worktree,
        status: 'ERROR',
        error: 'Seeded worktree setup failure.'
      },
      'WORKTREE_FAILED'
    );
    return { task: await requireTask(ctx, task.id), iteration, worktree: failed };
  }

  const created = await ctx.worktrees.create(worktree);
  let storedWorktree = await ctx.store.updateWorktree(created, 'WORKTREE_CREATED');

  if (gitState === 'missing') {
    storedWorktree = await ctx.store.updateWorktree(
      {
        ...storedWorktree,
        status: 'MISSING',
        error: 'Seeded worktree missing from disk.'
      },
      'WORKTREE_VERIFIED'
    );
    return { task: await requireTask(ctx, task.id), iteration, worktree: storedWorktree };
  }

  let gitSnapshot: GitSnapshotRecord | undefined;
  if (gitState === 'dirty') {
    await writeWorktreeFile(storedWorktree, `scenarios/${definition.slug}.txt`, 'Uncommitted seed change.\n');
    gitSnapshot = await captureGitSnapshot(ctx, storedWorktree);
  } else if (gitState === 'committed') {
    await commitWorktreeFile(storedWorktree, `scenarios/${definition.slug}.txt`, 'Committed seed change.\n');
    storedWorktree = await refreshStoredWorktree(ctx, storedWorktree);
    gitSnapshot = await captureGitSnapshot(ctx, storedWorktree);
  } else if (gitState === 'clean') {
    gitSnapshot = await captureGitSnapshot(ctx, storedWorktree);
  }

  task = await requireTask(ctx, task.id);
  return { task, iteration, worktree: storedWorktree, gitSnapshot };
}

async function createPreviewScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededTaskState> {
  const state = await createWorktreeState(ctx, definition, 'clean');
  if (definition.slug === 'preview-missing-recipe') return state;
  const ociReady = definition.slug === 'preview-oci-ready';
  const now = new Date().toISOString();
  const plan = await ctx.store.savePreviewPlan({
    id: `seed-plan-${definition.slug}`,
    taskId: state.task.id,
    iterationId: state.iteration.id,
    worktreeId: state.worktree.id,
    recipePath: '.taskmonki/preview.yaml',
    recipeVersion: 1,
    recipeDigest: `seed-recipe-${definition.slug}`,
    executionDigest:
      definition.slug === 'preview-active-approval-required'
        ? 'seed-preview-execution-v2'
        : 'seed-preview-execution-v1',
    executionPlan: {
      version: 1,
      jobs: [
        {
          id: 'prepare',
          label: 'Prepare application',
          cwd: '.',
          command: ['node', 'scripts/prepare-preview.mjs'],
          needs: {},
          env: {},
          role: 'generic',
          retrySafe: false
        },
        ...(ociReady ? [
          {
            id: 'migrate', label: 'Migrate database', cwd: '.',
            command: ['node', 'scripts/migrate.mjs'],
            needs: { database: 'ready' as const },
            env: { DATABASE_URL: { type: 'postgres-url' as const, resource: 'database' } },
            role: 'migration' as const, retrySafe: false
          },
          {
            id: 'seed', label: 'Seed development data', cwd: '.',
            command: ['node', 'scripts/seed.mjs'],
            needs: { migrate: 'succeeded' as const, database: 'ready' as const, cache: 'ready' as const },
            env: {
              DATABASE_URL: { type: 'postgres-url' as const, resource: 'database' },
              REDIS_URL: { type: 'redis-url' as const, resource: 'cache' }
            },
            role: 'seed' as const, retrySafe: true
          }
        ] : [])
      ],
      resources: ociReady ? [
        {
          id: 'database', label: 'PostgreSQL', type: 'postgres' as const,
          image: 'postgres:17-alpine', database: 'app',
          limits: { cpus: 1, memoryMb: 256, diskMb: 1024, pids: 128 }
        },
        {
          id: 'cache', label: 'Redis', type: 'redis' as const,
          image: 'redis:7-alpine',
          limits: { cpus: 0.5, memoryMb: 128, diskMb: 256, pids: 64 }
        }
      ] : [],
      services: [
        {
          id: 'web',
          label: 'Start web application',
          cwd: '.',
          command: ['node', 'server.mjs'],
          needs: ociReady
            ? { prepare: 'succeeded' as const, seed: 'succeeded' as const, database: 'ready' as const, cache: 'ready' as const }
            : { prepare: 'succeeded' as const },
          env: ociReady ? {
            NODE_ENV: 'development',
            DATABASE_URL: { type: 'postgres-url' as const, resource: 'database' },
            REDIS_URL: { type: 'redis-url' as const, resource: 'cache' }
          } : { NODE_ENV: 'development' },
          ports: { http: { env: 'PORT' } },
          ready: { type: 'http', port: 'http', path: '/health/ready', timeoutSeconds: 30 },
          critical: true,
          restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
        }
      ],
      workers: [],
      routes: [{ id: 'app', service: 'web', port: 'http', primary: true }],
      scenarios: ociReady
        ? [{ id: 'full', label: 'Full sample data', jobs: ['migrate', 'seed'], resources: ['database', 'cache'] }]
        : [{ id: 'default', jobs: [], resources: [] }],
      selectedScenarioId: ociReady ? 'full' : 'default'
    },
    warnings: [
      'Native preview commands run as your local user and are not sandboxed.',
      'Commands may access the network; Task Monki does not enforce a no-network mode.'
    ],
    createdAt: now
  });
  if (definition.slug === 'preview-approval-required') return state;
  const generationPlan =
    definition.slug === 'preview-active-approval-required'
      ? await ctx.store.savePreviewPlan({
          ...plan,
          id: `seed-plan-${definition.slug}-active`,
          recipeDigest: `seed-recipe-${definition.slug}-active`,
          executionDigest: 'seed-preview-execution-v1',
          createdAt: new Date(Date.parse(now) - 1).toISOString()
        })
      : plan;
  const approval = await ctx.store.savePreviewApproval({
    id: `seed-approval-${definition.slug}`,
    taskId: state.task.id,
    planId: generationPlan.id,
    executionDigest: generationPlan.executionDigest,
    scope: 'TASK',
    approvedAt: now
  });
  const generationState = previewStateForSeed(definition.slug);
  const generationId = `seed-generation-${definition.slug}`;
  const manifest = await ctx.store.writeTextArtifact(
    state.task.id,
    'preview-source-manifest',
    `${JSON.stringify({ version: 1, headSha: state.gitSnapshot?.headSha, entries: [], digest: 'seed-manifest' })}\n`
  );
  const routeAttached = generationState === 'READY';
  const generation = await ctx.store.savePreviewGeneration({
    id: generationId,
    previewKey: `task-${state.task.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16)}`,
    taskId: state.task.id,
    iterationId: state.iteration.id,
    worktreeId: state.worktree.id,
    planId: generationPlan.id,
    approvalId: approval.id,
    executionDigest: generationPlan.executionDigest,
    sourceGitSnapshotId: state.gitSnapshot?.id ?? 'seed-git',
    sourceHeadSha: state.gitSnapshot?.headSha ?? ctx.baseSha,
    sourceDirtyFingerprint: state.gitSnapshot?.dirtyFingerprint ?? 'seed-dirty',
    sourceManifestArtifactId: manifest.id,
    sourceManifestDigest: 'seed-manifest',
    workspacePath: path.join(ctx.previewRoot, state.task.id, generationId),
    state: generationState,
    routingState: generationState === 'READY' ? 'ACTIVE' : 'CANDIDATE',
    freshness: definition.slug === 'preview-stale' ? 'STALE' : 'CURRENT',
    routes: routeAttached
      ? [
          {
            id: 'app',
            hostname: `app.seed-${definition.slug}.preview.localhost`,
            url: `http://app.seed-${definition.slug}.preview.localhost:31337/`,
            gatewayPort: 31337,
            targetHost: '127.0.0.1',
            targetPort: 41000 + ctx.scenarios.length,
            state: 'ATTACHED'
          }
        ]
      : [],
    failureReason:
      generationState === 'FAILED' ? 'Preview job prepare failed with exit code 7.' : undefined,
    cleanupReason:
      generationState === 'CLEANUP_INCOMPLETE'
        ? 'Recorded native process identity could not be verified; cleanup was refused.'
        : undefined,
    createdAt: now,
    updatedAt: now,
    readyAt: routeAttached ? now : undefined,
    stoppedAt: generationState === 'STOPPED' ? now : undefined
  });
  if (generationState === 'PREPARING_SOURCE') return state;
  const stdout = await ctx.store.createPreviewArtifact(state.task.id, 'preview-stdout');
  const stderr = await ctx.store.createPreviewArtifact(state.task.id, 'preview-stderr');
  if (generationState === 'FAILED') {
    await ctx.store.appendBoundedArtifact(stderr.id, 'intentional seeded preview failure\n');
  }
  const attemptState =
    generationState === 'READY' ? 'READY'
    : generationState === 'STOPPED' ? 'STOPPED'
    : generationState === 'FAILED' ? 'FAILED'
    : 'RECOVERY_REQUIRED';
  await ctx.store.savePreviewNodeAttempt({
    id: `seed-attempt-${definition.slug}`,
    taskId: state.task.id,
    generationId: generation.id,
    nodeId: generationState === 'FAILED' ? 'prepare' : 'web',
    kind: generationState === 'FAILED' ? 'JOB' : 'SERVICE',
    attempt: 1,
    commandDigest: 'seed-command',
    state: attemptState,
    stdoutArtifactId: stdout.id,
    stderrArtifactId: stderr.id,
    startedAt: now,
    endedAt: ['FAILED', 'STOPPED'].includes(generationState) ? now : undefined,
    exitCode: generationState === 'FAILED' ? 7 : undefined,
    readiness: generationState === 'READY'
      ? { status: 'PASSED', lastStatusCode: 204, observedAt: now }
      : undefined
  });
  await ctx.store.savePreviewResource({
    id: `seed-resource-${definition.slug}`,
    taskId: state.task.id,
    generationId: generation.id,
    logicalNodeId: generationState === 'FAILED' ? 'prepare' : 'web',
    adapterKind: 'NATIVE_PROCESS',
    state:
      generationState === 'READY' ? 'RUNNING'
      : generationState === 'STOPPED' ? 'STOPPED'
      : generationState === 'FAILED' ? 'FAILED'
      : generationState === 'CLEANUP_INCOMPLETE' ? 'CLEANUP_INCOMPLETE'
      : 'PREPARED',
    ownershipMarkerDigest: 'seed-marker',
    receiptPath: path.join(ctx.previewRoot, state.task.id, generation.id, 'runtime', 'seed.json'),
    targetHost: '127.0.0.1',
    targetPort: 41000 + ctx.scenarios.length,
    updatedAt: now,
    cleanupError:
      generationState === 'CLEANUP_INCOMPLETE' ? 'Seeded unverified ownership identity.' : undefined
  });
  if (['preview-replacing', 'preview-replacement-failed'].includes(definition.slug)) {
    const failed = definition.slug === 'preview-replacement-failed';
    const candidateAt = new Date(Date.parse(now) + 1).toISOString();
    const candidateId = `${generationId}-candidate`;
    await ctx.store.savePreviewGeneration({
      ...generation,
      id: candidateId,
      workspacePath: path.join(ctx.previewRoot, state.task.id, candidateId),
      state: failed ? 'FAILED' : 'WAITING_READY',
      routingState: 'CANDIDATE',
      replacesGenerationId: generation.id,
      routes: [],
      failureReason: failed ? 'Candidate web service exited before readiness.' : undefined,
      createdAt: candidateAt,
      updatedAt: candidateAt,
      readyAt: undefined
    });
    const candidateStdout = await ctx.store.createPreviewArtifact(state.task.id, 'preview-stdout');
    const candidateStderr = await ctx.store.createPreviewArtifact(state.task.id, 'preview-stderr');
    if (failed) await ctx.store.appendBoundedArtifact(candidateStderr.id, 'candidate readiness failed\n');
    await ctx.store.savePreviewNodeAttempt({
      id: `seed-attempt-${definition.slug}-candidate`, taskId: state.task.id,
      generationId: candidateId, nodeId: 'web', kind: 'SERVICE', attempt: 1,
      commandDigest: 'seed-candidate-command', state: failed ? 'FAILED' : 'WAITING_READY',
      stdoutArtifactId: candidateStdout.id, stderrArtifactId: candidateStderr.id,
      startedAt: candidateAt, endedAt: failed ? candidateAt : undefined,
      readiness: { status: failed ? 'FAILED' : 'PENDING', lastError: failed ? 'Service exited.' : undefined }
    });
    await ctx.store.savePreviewResource({
      id: `seed-resource-${definition.slug}-candidate`, taskId: state.task.id,
      generationId: candidateId, logicalNodeId: 'web', adapterKind: 'NATIVE_PROCESS',
      state: failed ? 'FAILED' : 'RUNNING', ownershipMarkerDigest: 'seed-marker',
      receiptPath: path.join(ctx.previewRoot, state.task.id, candidateId, 'runtime', 'seed.json'),
      targetHost: '127.0.0.1', targetPort: 42000 + ctx.scenarios.length, updatedAt: candidateAt
    });
  }
  return state;
}

function previewStateForSeed(slug: string): PreviewGenerationState {
  if (slug === 'preview-preparing') return 'PREPARING_SOURCE';
  if (['preview-ready', 'preview-oci-ready', 'preview-stale', 'preview-replacing', 'preview-replacement-failed', 'preview-active-approval-required'].includes(slug)) return 'READY';
  if (slug === 'preview-failed') return 'FAILED';
  if (slug === 'preview-stopped') return 'STOPPED';
  if (slug === 'preview-recovery-required') return 'RECOVERY_REQUIRED';
  if (slug === 'preview-cleanup-incomplete') return 'CLEANUP_INCOMPLETE';
  throw new Error(`No seeded preview state for ${slug}.`);
}

async function createImplementedTask(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition,
  completionPolicy: CompletionPolicy = 'LOCAL_ACCEPTANCE'
): Promise<SeededTaskState> {
  const state = await createWorktreeState(ctx, definition, 'committed', completionPolicy);
  const started = await createRun(ctx, state, 'IMPLEMENTATION', `Implement ${definition.slug}.`);
  await seedActiveRunProgress(ctx, started, {
    steps: [
      { step: 'Read task context', status: 'COMPLETED' },
      { step: 'Implement seeded change', status: 'COMPLETED' },
      { step: 'Verify local state', status: 'COMPLETED' }
    ],
    message: 'Progress: Summarizing completed seed implementation.',
    explanation: 'Implementation completed.',
    verificationStatus: 'COMPLETED'
  });
  await completeRun(ctx, started, 'Seed implementation completed.', state.gitSnapshot?.id);
  return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, started.id) };
}

async function createAgentScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition,
  variant:
    | 'running'
    | 'approval'
    | 'user-input'
    | 'interrupted'
    | 'runtime-lost'
    | 'ambiguous'
    | 'interaction-stale'
): Promise<SeededTaskState> {
  const state = await createWorktreeState(ctx, definition, 'dirty');
  const run = await createRun(ctx, state, 'IMPLEMENTATION', `Exercise ${definition.slug}.`);
  if (variant === 'running') {
    await seedActiveRunProgress(ctx, run);
    return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, run.id) };
  }
  if (variant === 'approval' || variant === 'user-input' || variant === 'interaction-stale') {
    const request = await createInteraction(ctx, run, variant === 'user-input' ? 'USER_INPUT' : 'COMMAND_APPROVAL');
    if (variant === 'approval' || variant === 'user-input') {
      await seedActiveRunProgress(ctx, await requireRun(ctx, run.id), {
        steps: [
          { step: 'Prepare interaction request', status: 'COMPLETED' },
          { step: 'Wait for user response', status: 'IN_PROGRESS' },
          { step: 'Continue implementation', status: 'PENDING' }
        ],
        message: 'Progress: Waiting for the interaction response before continuing implementation.',
        verificationStatus: 'COMPLETED'
      });
    }
    if (variant === 'interaction-stale') {
      await ctx.store.transitionInteractionRequest(request.id, 'PENDING', {
        status: 'STALE',
        resolvedAt: new Date().toISOString()
      });
    }
    return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, run.id) };
  }
  if (variant === 'interrupted') {
    await appendRunEvent(ctx, run, 'CANCEL_REQUESTED', { reason: 'Seeded interruption request.' }, 'ui');
    await appendRunEvent(ctx, run, 'AGENT_RUN_INTERRUPTED', { terminalReason: 'Seeded interruption.' });
  } else if (variant === 'runtime-lost') {
    await appendRunEvent(ctx, run, 'AGENT_RUNTIME_LOST', { reason: 'Seeded runtime loss.' });
  } else {
    await appendRunEvent(ctx, run, 'AGENT_MUTATION_AMBIGUOUS', {
      reason: 'Seeded provider mutation could not be confirmed.'
    });
  }
  return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, run.id) };
}

async function seedActiveRunProgress(
  ctx: SeedContext,
  run: RunRecord,
  input: {
    steps?: Array<{ step: string; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' }>;
    message?: string;
    explanation?: string;
    verificationStatus?: 'IN_PROGRESS' | 'COMPLETED';
  } = {}
): Promise<void> {
  const steps = input.steps ?? [
    { step: 'Read task context', status: 'COMPLETED' },
    { step: 'Update overview progress panel', status: 'IN_PROGRESS' },
    { step: 'Verify seeded UI state', status: 'PENDING' }
  ];
  const message =
    input.message ??
    'Progress: Updated the overview panel and will verify the seeded UI next.';
  await ctx.store.recordAgentPlanRevision({
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    provider: 'codex',
    explanation: input.explanation ?? 'Implementation is in progress.',
    steps,
    rawMessage: await rawMessage(ctx, 'INBOUND', {
      type: 'turn/plan/updated',
      runId: run.id
    })
  });
  await seedCommandExecution(ctx, run, {
    suffix: 'read',
    status: 'COMPLETED',
    command: "sed -n '1,80p' src/renderer/ui/TaskDetail.tsx",
    commandActions: [
      {
        type: 'read',
        command: "sed -n '1,80p' src/renderer/ui/TaskDetail.tsx",
        name: 'TaskDetail.tsx',
        path: `${ctx.repositoryPath}/src/renderer/ui/TaskDetail.tsx`
      }
    ],
    aggregatedOutput: Array.from({ length: 12 }, (_, index) => `seed overview line ${index + 1}`).join('\n'),
    durationMs: 180
  });
  await seedFileChange(ctx, run);
  await seedCommandExecution(ctx, run, {
    suffix: 'verify',
    status: input.verificationStatus ?? 'IN_PROGRESS',
    command: 'npm run typecheck',
    commandActions: [{ type: 'unknown', command: 'npm run typecheck' }],
    durationMs: input.verificationStatus === 'COMPLETED' ? 320 : null
  });
  await seedAgentMessage(ctx, run, message);
}

async function seedCommandExecution(
  ctx: SeedContext,
  run: RunRecord,
  input: {
    suffix: string;
    status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    command: string;
    commandActions: Array<Record<string, unknown>>;
    aggregatedOutput?: string;
    durationMs?: number | null;
  }
): Promise<void> {
  await ctx.store.upsertAgentItem({
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    providerItemId: `seed-command-${input.suffix}-${run.id}`,
    type: 'COMMAND_EXECUTION',
    status: input.status,
    payload: {
      type: 'commandExecution',
      id: `seed-command-${input.suffix}-${run.id}`,
      command: input.command,
      cwd: ctx.repositoryPath,
      commandActions: input.commandActions,
      aggregatedOutput: input.aggregatedOutput ?? null,
      exitCode: input.status === 'FAILED' ? 1 : input.status === 'COMPLETED' ? 0 : null,
      durationMs: input.durationMs ?? null
    },
    rawMessage: await rawMessage(ctx, 'INBOUND', {
      type: 'item/commandExecution',
      runId: run.id
    }),
    providerStartedAt: new Date().toISOString(),
    providerCompletedAt: input.status === 'IN_PROGRESS' ? undefined : new Date().toISOString()
  });
}

async function seedFileChange(ctx: SeedContext, run: RunRecord): Promise<void> {
  await ctx.store.upsertAgentItem({
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    providerItemId: `seed-file-change-${run.id}`,
    type: 'FILE_CHANGE',
    status: 'COMPLETED',
    payload: {
      type: 'fileChange',
      id: `seed-file-change-${run.id}`,
      changes: [
        {
          path: 'src/renderer/model/runProgress.ts',
          kind: { type: 'update', move_path: null },
          diff: [
            '--- a/src/renderer/model/runProgress.ts',
            '+++ b/src/renderer/model/runProgress.ts',
            '-export const oldActivity = true;',
            '+export const activityTail = true;',
            '+export const activityMetrics = true;'
          ].join('\n')
        }
      ]
    },
    rawMessage: await rawMessage(ctx, 'INBOUND', {
      type: 'item/fileChange',
      runId: run.id
    }),
    providerStartedAt: new Date().toISOString(),
    providerCompletedAt: new Date().toISOString()
  });
}

async function seedAgentMessage(
  ctx: SeedContext,
  run: RunRecord,
  message: string,
  suffix = 'progress'
): Promise<void> {
  await ctx.store.upsertAgentItem({
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    providerItemId: `seed-${suffix}-${run.id}`,
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: {
      type: 'agentMessage',
      id: `seed-${suffix}-${run.id}`,
      text: message
    },
    rawMessage: await rawMessage(ctx, 'INBOUND', {
      type: 'item/agentMessage',
      runId: run.id
    }),
    providerCompletedAt: new Date().toISOString()
  });
}

async function createReviewScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededTaskState> {
  const state = await createImplementedTask(ctx, definition);
  if (definition.slug === 'review-not-run') {
    return { ...state, task: await requireTask(ctx, state.task.id) };
  }

  const review = await createRun(ctx, state, 'REVIEW', `Review ${definition.slug}.`, {
    role: 'REVIEW',
    continuedFromRunId: state.run?.id,
    beforeGitSnapshotId: state.gitSnapshot?.id
  });
  if (definition.slug === 'review-running') {
    await seedCommandExecution(ctx, review, {
      suffix: 'review-search',
      status: 'COMPLETED',
      command: 'rg review src/renderer',
      commandActions: [
        { type: 'search', query: 'review', path: 'src/renderer' }
      ],
      durationMs: 90
    });
    return { ...state, task: await requireTask(ctx, state.task.id), run: review };
  }

  if (definition.slug === 'review-failed') {
    const artifact = await ctx.store.writeFinalArtifact(state.task.id, review.id, 'Seed review failed.');
    await appendRunEvent(ctx, review, 'AGENT_RUN_FAILED', {
      error: 'Seeded review failure.',
      finalArtifactId: artifact.id
    });
    return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, review.id) };
  }

  if (definition.slug === 'review-canceled') {
    await appendRunEvent(ctx, review, 'CANCEL_REQUESTED', { reason: 'Seeded review cancellation.' }, 'ui');
    await appendRunEvent(ctx, review, 'AGENT_RUN_INTERRUPTED', {
      terminalReason: 'Seeded review cancellation.'
    });
    return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, review.id) };
  }

  const result = reviewResultFor(definition.slug);
  await completeRun(ctx, review, result.summary, state.gitSnapshot?.id, {
    codexReviewResult: result
  });

  if (
    definition.slug === 'review-stale-after-follow-up' ||
    definition.slug === 'review-follow-up-active'
  ) {
    const followUp = await createRun(ctx, { ...state, task: await requireTask(ctx, state.task.id) }, 'FOLLOW_UP', 'Apply review feedback.');
    if (definition.slug === 'review-stale-after-follow-up') {
      await completeRun(ctx, followUp, 'Seed follow-up completed.', state.gitSnapshot?.id);
    }
  }

  return { ...state, task: await requireTask(ctx, state.task.id), run: await requireRun(ctx, review.id) };
}

async function createNoPrScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededTaskState> {
  const gitState =
    definition.slug === 'no-pr-git-not-inspected' ? 'none'
    : definition.slug === 'no-pr-clean' ? 'clean'
    : definition.slug === 'no-pr-dirty' ? 'dirty'
    : 'committed';
  const state = await createWorktreeState(ctx, definition, gitState);
  if (definition.slug === 'no-pr-conflicted') {
    await recordSyntheticGitSnapshot(ctx, state, { status: 'CONFLICTED', conflictedCount: 2 });
  } else if (definition.slug === 'no-pr-unavailable') {
    await recordSyntheticGitSnapshot(ctx, state, { status: 'UNAVAILABLE' });
  } else if (definition.slug === 'no-pr-unknown') {
    await recordSyntheticGitSnapshot(ctx, state, { status: 'UNKNOWN' });
  } else if (definition.slug === 'no-pr-publish-failed-retryable') {
    await recordBranchPublication(ctx, state, 'FAILED', 'GitHub authentication required.');
  } else if (definition.slug === 'no-pr-publish-failed-remote-newer') {
    await recordBranchPublication(
      ctx,
      state,
      'FAILED',
      'Remote branch has newer commits. Sync the branch before pushing again.'
    );
  } else if (definition.slug === 'no-pr-publish-in-progress') {
    await recordBranchPublication(ctx, state, 'PUSHING');
  } else if (definition.slug === 'delivery-branch-pushed-no-pr') {
    await recordBranchPublication(ctx, state, 'PUSHED');
  }
  return { ...state, task: await requireTask(ctx, state.task.id) };
}

async function createDeliveryScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededTaskState> {
  const state =
    definition.slug === 'delivery-pr-newer-commits'
      ? await createWorktreeState(ctx, definition, 'clean')
      : await createImplementedTask(ctx, definition);
  const task = await requireTask(ctx, state.task.id);
  const headSha = state.gitSnapshot?.headSha ?? ctx.baseSha;
  await recordBranchPublication(ctx, state, 'PUSHED', undefined, headSha);

  if (definition.slug === 'delivery-local-not-pushed') {
    await recordPr(ctx, state, { pullRequestStatus: 'OPEN_READY', headSha });
    await writeWorktreeFile(state.worktree, `scenarios/${definition.slug}-local.txt`, 'Local change after PR.\n');
    await captureGitSnapshot(ctx, state.worktree);
    return { ...state, task: await requireTask(ctx, task.id) };
  }

  if (definition.slug === 'delivery-pr-newer-commits') {
    await recordPr(ctx, state, {
      pullRequestStatus: 'OPEN_READY',
      headSha: 'seed-remote-pr-head'
    });
    return { ...state, task: await requireTask(ctx, task.id) };
  }

  if (definition.slug === 'delivery-branch-diverged') {
    await recordSyntheticGitSnapshot(ctx, state, {
      status: 'DIVERGED',
      aheadCount: 1,
      behindCount: 1
    });
    await recordPr(ctx, state, { pullRequestStatus: 'OPEN_READY', headSha });
    return { ...state, task: await requireTask(ctx, task.id) };
  }

  const prOptions = deliveryPrOptions(definition.slug, headSha);
  await recordPr(ctx, state, prOptions);
  return { ...state, task: await requireTask(ctx, task.id) };
}

async function createCompletionScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededTaskState> {
  const completionPolicy: CompletionPolicy =
    definition.slug === 'completion-manual-merged' ? 'MANUAL' : 'MERGED_AND_VERIFIED';
  const state = await createImplementedTask(ctx, definition, completionPolicy);
  const headSha = state.gitSnapshot?.headSha ?? ctx.baseSha;
  await recordBranchPublication(ctx, state, 'PUSHED', undefined, headSha);
  const ciStatus: CiChecksStatus =
    definition.slug === 'completion-merged-and-verified-passing'
      ? 'PASSING'
      : definition.slug === 'completion-merged-and-verified-stale'
        ? 'STALE'
        : 'FAILING';
  await recordPr(ctx, state, {
    pullRequestStatus: 'MERGED',
    state: 'MERGED',
    headSha,
    ciStatus,
    reviewStatus: 'APPROVED',
    mergeStatus: 'MERGED',
    mergedAt: new Date().toISOString(),
    checkDetails:
      ciStatus === 'FAILING'
        ? [{ name: 'seed-verification', status: 'failed', workflow: 'CI' }]
        : []
  });
  return { ...state, task: await requireTask(ctx, state.task.id) };
}

async function createForkScenario(
  ctx: SeedContext,
  definition: DevSeedScenarioDefinition
): Promise<SeededScenarioResult> {
  const source = await createImplementedTask(ctx, definition);
  if (!source.run) {
    throw new Error('Fork seed source run was not created.');
  }
  const alternative = await ctx.store.createForkedAlternativeTask({
    title: `[seed:${definition.slug}:alternative] Alternative approach`,
    prompt: 'Seeded fork alternative for UI coverage.',
    repositoryPath: ctx.repositoryPath,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    sourceTaskId: source.task.id,
    sourceRunId: source.run.id
  });
  return { task: await requireTask(ctx, source.task.id), relatedTaskIds: [alternative.id] };
}

function deliveryPrOptions(slug: string, headSha: string): RecordPrOptions {
  switch (slug) {
    case 'delivery-draft-pr':
      return { pullRequestStatus: 'OPEN_DRAFT', isDraft: true, headSha };
    case 'delivery-checks-pending':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha,
        ciStatus: 'PENDING',
        passingCount: 1,
        pendingCount: 2
      };
    case 'delivery-checks-failed':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha,
        ciStatus: 'FAILING',
        passingCount: 2,
        failingCount: 1,
        checkDetails: [
          {
            name: 'lint-and-test',
            status: 'failed',
            workflow: 'CI',
            link: 'https://github.com/example/task-monki/actions/runs/seed-failed',
            event: 'pull_request'
          },
          { name: 'typecheck', status: 'passed', workflow: 'CI' }
        ]
      };
    case 'delivery-checks-canceled':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha,
        ciStatus: 'CANCELED',
        canceledCount: 1,
        checkDetails: [{ name: 'e2e', status: 'canceled', workflow: 'CI' }]
      };
    case 'delivery-no-required-checks':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha,
        ciStatus: 'NO_CHECKS',
        totalCount: 2,
        skippedCount: 2,
        checkDetails: [
          { name: 'docs-only', status: 'skipped', workflow: 'CI' },
          { name: 'optional-preview', status: 'skipped', workflow: 'Preview' }
        ]
      };
    case 'delivery-review-waiting':
      return { pullRequestStatus: 'OPEN_READY', headSha, reviewStatus: 'REQUESTED' };
    case 'delivery-changes-requested':
      return { pullRequestStatus: 'OPEN_READY', headSha, reviewStatus: 'CHANGES_REQUESTED' };
    case 'delivery-ready-to-merge':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha,
        ciStatus: 'PASSING',
        passingCount: 3,
        reviewStatus: 'APPROVED',
        mergeStatus: 'MERGEABLE'
      };
    case 'delivery-merged':
      return {
        pullRequestStatus: 'MERGED',
        state: 'MERGED',
        headSha,
        ciStatus: 'PASSING',
        passingCount: 3,
        reviewStatus: 'APPROVED',
        mergeStatus: 'MERGED',
        mergedAt: new Date().toISOString()
      };
    case 'delivery-closed-unmerged':
      return {
        pullRequestStatus: 'CLOSED_UNMERGED',
        state: 'CLOSED',
        headSha,
        mergeStatus: 'CLOSED_UNMERGED'
      };
    case 'delivery-stale-evidence':
      return {
        pullRequestStatus: 'OPEN_READY',
        headSha: 'seed-new-pr-head',
        ciHeadSha: 'seed-old-ci-head',
        ciStatus: 'PASSING',
        passingCount: 2
      };
    default:
      return { pullRequestStatus: 'OPEN_READY', headSha };
  }
}

async function createRun(
  ctx: SeedContext,
  state: SeededTaskState,
  mode: AgentRunMode,
  prompt: string,
  options: {
    role?: 'PRIMARY' | 'REVIEW';
    continuedFromRunId?: string;
    beforeGitSnapshotId?: string;
  } = {}
): Promise<RunRecord> {
  const task = await requireTask(ctx, state.task.id);
  const session = await ctx.store.createAgentSession({
    task,
    iteration: state.iteration,
    worktree: state.worktree,
    provider: 'codex',
    role: options.role ?? (mode === 'REVIEW' ? 'REVIEW' : 'PRIMARY'),
    requestedSettings: DEFAULT_AGENT_SETTINGS
  });
  await ctx.store.updateAgentSession(session.id, {
    providerSessionId: `seed-thread-${state.task.id.slice(0, 8)}-${ctx.turnCounter + 1}`,
    providerSessionTreeId: `seed-tree-${state.task.id.slice(0, 8)}`,
    status: 'ACTIVE',
    materialized: true,
    lastAttachedAt: new Date().toISOString()
  });
  const run = await ctx.store.createRun({
    task,
    session,
    mode,
    prompt,
    serverInstanceId: ctx.serverInstanceId,
    continuedFromRunId: options.continuedFromRunId,
    beforeGitSnapshotId: options.beforeGitSnapshotId,
    requestedSettings: DEFAULT_AGENT_SETTINGS
  });
  ctx.turnCounter += 1;
  await ctx.store.updateRun(run.id, {
    providerTurnId: `seed-turn-${ctx.turnCounter}`,
    status: 'RUNNING',
    lastEventAt: new Date().toISOString()
  });
  await appendRunEvent(ctx, run, 'PROCESS_STARTED', { pid: 40_000 + ctx.turnCounter }, 'process');
  return requireRun(ctx, run.id);
}

async function completeRun(
  ctx: SeedContext,
  run: RunRecord,
  finalMessage: string,
  afterGitSnapshotId?: string,
  extraPayload: Record<string, unknown> = {}
): Promise<void> {
  const finalArtifact = await ctx.store.writeFinalArtifact(run.taskId, run.id, finalMessage);
  await ctx.store.updateRun(run.id, {
    afterGitSnapshotId,
    finalArtifactId: finalArtifact.id,
    finalMessage
  });
  await appendRunEvent(ctx, run, 'AGENT_RUN_COMPLETED', {
    terminalStatus: 'completed',
    finalArtifactId: finalArtifact.id,
    ...extraPayload
  });
}

async function createInteraction(
  ctx: SeedContext,
  run: RunRecord,
  type: InteractionRequestType
): Promise<InteractionRequestRecord> {
  const requestRawMessage = await rawMessage(ctx, 'INBOUND', { type, runId: run.id });
  return ctx.store.createInteractionRequest({
    serverInstanceId: ctx.serverInstanceId,
    providerRequestId: `seed-request-${++ctx.protocolCounter}`,
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    providerTurnId: run.providerTurnId,
    type,
    request:
      type === 'USER_INPUT'
        ? {
            questions: [
              {
                id: 'seed_choice',
                header: 'Choice',
                question: 'Choose how the seeded task should proceed.',
                isOther: false,
                isSecret: false,
                options: [
                  { label: 'Proceed', description: 'Continue the seeded flow.' },
                  { label: 'Pause', description: 'Leave the seeded flow paused.' }
                ]
              }
            ],
            autoResolutionMs: 120_000
          }
        : {
            startedAtMs: Date.now(),
            approvalId: `seed-approval-${ctx.protocolCounter}`,
            reason: 'Seeded command approval.',
            command: 'npm test',
            cwd: ctx.repositoryPath,
            commandActions: [{ type: 'unknown', command: 'npm test' }]
          },
    allowedActions:
      type === 'USER_INPUT'
        ? ['ANSWER', 'CANCEL']
        : ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL'],
    policyWarnings: type === 'USER_INPUT' ? [] : ['Seeded approval warning.'],
    requestRawMessage
  });
}

async function appendRunEvent(
  ctx: SeedContext,
  run: RunRecord,
  type: Extract<
    DomainEvent['type'],
    | 'PROCESS_STARTED'
    | 'AGENT_RUN_COMPLETED'
    | 'AGENT_RUN_FAILED'
    | 'AGENT_RUN_INTERRUPTED'
    | 'AGENT_MUTATION_AMBIGUOUS'
    | 'AGENT_RUNTIME_LOST'
    | 'CANCEL_REQUESTED'
  >,
  payload: Record<string, unknown>,
  source: DomainEvent['source'] = 'provider'
): Promise<void> {
  await ctx.store.appendEvent(
    createDomainEvent({
      type,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      serverInstanceId: ctx.serverInstanceId,
      source,
      payload
    })
  );
}

async function captureGitSnapshot(
  ctx: SeedContext,
  worktree: WorktreeRecord
): Promise<GitSnapshotRecord> {
  return ctx.store.recordGitSnapshot(
    await inspectGitSnapshot(worktree),
    await buildDiffEvidence(worktree)
  );
}

async function recordSyntheticGitSnapshot(
  ctx: SeedContext,
  state: SeededTaskState,
  overrides: Partial<Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'>>
): Promise<GitSnapshotRecord> {
  const base = state.gitSnapshot
    ? stripGeneratedGitFields(state.gitSnapshot)
    : await inspectGitSnapshot(state.worktree);
  return ctx.store.recordGitSnapshot(
    {
      ...base,
      ...overrides,
      taskId: state.task.id,
      iterationId: state.iteration.id,
      worktreeId: state.worktree.id,
      worktreePath: state.worktree.worktreePath
    },
    [
      '# Synthetic seed Git evidence',
      '',
      `Scenario task: ${state.task.title}`,
      `Status: ${overrides.status ?? base.status}`,
      ''
    ].join('\n')
  );
}

function stripGeneratedGitFields(
  snapshot: GitSnapshotRecord
): Omit<GitSnapshotRecord, 'id' | 'capturedAt' | 'diffArtifactId'> {
  const { id: _id, capturedAt: _capturedAt, diffArtifactId: _diffArtifactId, ...record } = snapshot;
  return record;
}

async function recordBranchPublication(
  ctx: SeedContext,
  state: SeededTaskState,
  status: BranchPublicationStatus,
  error?: string,
  headSha = state.gitSnapshot?.headSha
): Promise<void> {
  await ctx.store.recordBranchPublication({
    taskId: state.task.id,
    iterationId: state.iteration.id,
    worktreeId: state.worktree.id,
    remoteName: 'origin',
    branchName: state.worktree.branchName,
    remoteRef: `origin/${state.worktree.branchName}`,
    headSha,
    status,
    error
  });
}

interface RecordPrOptions {
  pullRequestStatus: PullRequestStatus;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft?: boolean;
  headSha?: string;
  ciHeadSha?: string;
  ciStatus?: CiChecksStatus;
  requiredStatus?: CiChecksStatus;
  totalCount?: number;
  pendingCount?: number;
  passingCount?: number;
  failingCount?: number;
  skippedCount?: number;
  canceledCount?: number;
  checkDetails?: GitHubCheckDetailRecord[];
  reviewStatus?: ReviewStatus;
  mergeStatus?: MergeStatus;
  mergedAt?: string | null;
}

async function recordPr(
  ctx: SeedContext,
  state: SeededTaskState,
  options: RecordPrOptions
): Promise<void> {
  const number = ++ctx.prCounter;
  const headSha = options.headSha ?? state.gitSnapshot?.headSha ?? ctx.baseSha;
  const ciHeadSha = options.ciHeadSha ?? headSha;
  const ciStatus = options.ciStatus ?? 'NOT_APPLICABLE';
  const totalCount = totalCheckCount(options);
  await ctx.store.recordGitHubPreflight({
    taskId: state.task.id,
    iterationId: state.iteration.id,
    worktreeId: state.worktree.id,
    remoteName: 'origin',
    remoteUrl: path.join(ctx.rootDir, 'remote.git'),
    host: 'github.com',
    owner: 'example',
    repo: 'task-monki-seed',
    ghVersion: 'seed-gh',
    authStatus: 'AUTHENTICATED',
    status: 'READY'
  });
  await ctx.store.recordPullRequestSync({
    pullRequest: {
      taskId: state.task.id,
      iterationId: state.iteration.id,
      worktreeId: state.worktree.id,
      number,
      url: `https://github.com/example/task-monki-seed/pull/${number}`,
      status: options.pullRequestStatus,
      state:
        options.state ??
        (options.pullRequestStatus === 'MERGED'
          ? 'MERGED'
          : options.pullRequestStatus === 'CLOSED_UNMERGED'
            ? 'CLOSED'
            : 'OPEN'),
      isDraft: options.isDraft ?? options.pullRequestStatus === 'OPEN_DRAFT',
      headRefName: state.worktree.branchName,
      headRefOid: headSha,
      baseRefName: 'main',
      mergedAt: options.mergedAt,
      title: state.task.title.replace(/^\[seed:[^\]]+\]\s*/, '')
    },
    ci: {
      taskId: state.task.id,
      iterationId: state.iteration.id,
      worktreeId: state.worktree.id,
      pullRequestNumber: number,
      headSha: ciHeadSha,
      status: ciStatus,
      requiredStatus: options.requiredStatus ?? ciStatus,
      totalCount,
      pendingCount: options.pendingCount ?? 0,
      passingCount: options.passingCount ?? (ciStatus === 'PASSING' ? totalCount || 1 : 0),
      failingCount: options.failingCount ?? (ciStatus === 'FAILING' ? totalCount || 1 : 0),
      skippedCount: options.skippedCount ?? 0,
      canceledCount: options.canceledCount ?? (ciStatus === 'CANCELED' ? totalCount || 1 : 0),
      checkDetails: options.checkDetails ?? []
    },
    reviews: {
      taskId: state.task.id,
      iterationId: state.iteration.id,
      worktreeId: state.worktree.id,
      pullRequestNumber: number,
      headSha,
      status: options.reviewStatus ?? 'NOT_REQUESTED',
      reviewDecision:
        options.reviewStatus === 'APPROVED'
          ? 'APPROVED'
          : options.reviewStatus === 'CHANGES_REQUESTED'
            ? 'CHANGES_REQUESTED'
            : undefined
    },
    merge: {
      taskId: state.task.id,
      iterationId: state.iteration.id,
      worktreeId: state.worktree.id,
      pullRequestNumber: number,
      headSha,
      status: options.mergeStatus ?? 'NOT_MERGED',
      mergedAt: options.mergedAt
    }
  });
}

function reviewResultFor(slug: string): CodexReviewResult {
  if (slug === 'review-needs-changes' || slug === 'review-stale-after-follow-up' || slug === 'review-follow-up-active') {
    return {
      schemaVersion: 'codex-review/v1',
      verdict: 'NEEDS_CHANGES',
      summary: 'Seed review found changes that should be addressed.',
      findings: [
        {
          id: 'seed-review-major',
          severity: 'MAJOR',
          title: 'Seeded review finding',
          explanation: 'This finding exists to exercise request-changes UI.',
          path: 'src/seeded/example.ts',
          line: 12,
          recommendation: 'Address the seeded finding before accepting the work.'
        }
      ]
    };
  }
  if (slug === 'review-inconclusive') {
    return {
      schemaVersion: 'codex-review/v1',
      verdict: 'INCONCLUSIVE',
      summary: 'Seed review could not reach a confident verdict.',
      findings: []
    };
  }
  return {
    schemaVersion: 'codex-review/v1',
    verdict: 'PASSED',
    summary: 'Seed review passed.',
    findings: []
  };
}

function totalCheckCount(options: RecordPrOptions): number {
  if (options.totalCount !== undefined) {
    return options.totalCount;
  }
  const explicitCount =
    (options.pendingCount ?? 0) +
    (options.passingCount ?? 0) +
    (options.failingCount ?? 0) +
    (options.skippedCount ?? 0) +
    (options.canceledCount ?? 0);
  return explicitCount || options.checkDetails?.length || 0;
}

async function initSeedRepository(rootDir: string, repositoryPath: string): Promise<void> {
  const remotePath = path.join(rootDir, 'remote.git');
  await fs.mkdir(repositoryPath, { recursive: true });
  await fs.mkdir(remotePath, { recursive: true });
  await git(remotePath, ['init', '--bare']);
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki-seed@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki Seed']);
  await fs.writeFile(
    path.join(repositoryPath, 'README.md'),
    '# Task Monki seed repository\n\nThis repository is generated by `npm run dev:seed`.\n',
    'utf8'
  );
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial seed commit']);
  await git(repositoryPath, ['branch', '-M', 'main']);
  await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
  await git(repositoryPath, ['push', '-u', 'origin', 'main']);
}

async function writeWorktreeFile(
  worktree: WorktreeRecord,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(worktree.worktreePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function commitWorktreeFile(
  worktree: WorktreeRecord,
  relativePath: string,
  content: string
): Promise<string> {
  await writeWorktreeFile(worktree, relativePath, content);
  await git(worktree.worktreePath, ['add', relativePath]);
  await git(worktree.worktreePath, ['commit', '-m', `Seed ${path.basename(relativePath)}`]);
  return (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
}

async function refreshStoredWorktree(
  ctx: SeedContext,
  worktree: WorktreeRecord
): Promise<WorktreeRecord> {
  return ctx.store.updateWorktree(await ctx.worktrees.verify(worktree), 'WORKTREE_VERIFIED');
}

async function rawMessage(
  ctx: SeedContext,
  direction: AgentProtocolMessageReference['direction'],
  payload: unknown
): Promise<AgentProtocolMessageReference> {
  return ctx.store.appendProtocolMessage(
    ctx.serverInstanceId,
    direction,
    JSON.stringify({ seed: true, payload }),
    { seed: true }
  );
}

async function requireTask(ctx: SeedContext, taskId: string): Promise<Task> {
  const task = await ctx.store.getTask(taskId);
  if (!task) {
    throw new Error(`Seed task not found: ${taskId}`);
  }
  return task;
}

async function requireRun(ctx: SeedContext, runId: string): Promise<RunRecord> {
  const run = await ctx.store.getRun(runId);
  if (!run) {
    throw new Error(`Seed run not found: ${runId}`);
  }
  return run;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatEnvFile(env: DevSeedManifest['env']): string {
  return `${Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
}
