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
  WorktreeRecord
} from '../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../shared/contracts';
import { buildDiffEvidence, inspectGitSnapshot } from '../core/git/GitSnapshotService';
import { git } from '../core/git/gitCli';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { FileRepositoryRegistry } from '../core/storage/FileRepositoryRegistry';
import { NodeRepositoryInspector } from '../core/repository/NodeRepositoryInspector';
import { createDomainEvent } from '../core/storage/domainEvent';
import { WorktreeService } from '../core/worktree/WorktreeService';
import { FileDiscourseStore } from '../core/storage/FileDiscourseStore';
import type {
  AgentAssignmentSnapshot,
  BuiltInAgentProfileId,
  ContextSnapshotRecord,
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseDefaultPolicy,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord
} from '../shared/discourse';

export const TASK_MONKI_DEV_SEED_VERSION = 'task-monki-dev-seed/v1';
export const TASK_MONKI_DEV_SEED_MARKER = '.task-monki-dev-seed';

export type DevSeedScenarioGroup =
  | 'board'
  | 'agent'
  | 'review'
  | 'delivery'
  | 'completion'
  | 'workflow'
  | 'discourse';

export type DevSeedScenarioSet = 'all' | DevSeedScenarioGroup;

export interface DevSeedScenarioDefinition {
  slug: string;
  group: DevSeedScenarioGroup;
  title: string;
  description: string;
  tags: string[];
}

export interface DevSeedManifestScenario extends DevSeedScenarioDefinition {
  taskId?: string;
  conversationId?: string;
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
  appSettingsPath: string;
  repositoryRegistryDir: string;
  discourseDir: string;
  agentRuntimeDir: string;
  manifestPath: string;
  envFilePath: string;
  env: {
    TASK_MANAGER_STORE_DIR: string;
    TASK_MANAGER_APP_SETTINGS_PATH: string;
    TASK_MANAGER_REPOSITORY_REGISTRY_DIR: string;
    TASK_MANAGER_DISCOURSE_DIR: string;
    TASK_MANAGER_AGENT_RUNTIME_DIR: string;
    TASK_MANAGER_REPO_PATH: string;
    TASK_MANAGER_WORKTREE_ROOT: string;
    TASK_MANAGER_DEV_SEED_MODE: '1';
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
  appSettingsPath?: string;
  repositoryRegistryDir?: string;
  discourseDir?: string;
  agentRuntimeDir?: string;
  scenarioSet?: DevSeedScenarioSet;
  reset?: boolean;
}

const DEFAULT_AGENT_SETTINGS: AgentExecutionSettings = {
  model: 'scenario-model',
  reasoningEffort: 'low',
  sandbox: 'WORKSPACE_WRITE',
  networkAccess: false,
  approvalPolicy: 'never',
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
  scenario('discourse-empty', 'discourse', 'Empty discourse', 'A new human conversation with no messages.', ['discourse:empty']),
  scenario('discourse-context-picker', 'discourse', 'Context picker draft', 'A durable draft with task and repository context.', ['discourse:draft', 'context:structured']),
  scenario('discourse-human-only', 'discourse', 'Human-only conversation', 'Human notes, reply ancestry, and a correction.', ['discourse:human-only']),
  scenario('discourse-team-running', 'discourse', 'Team response running', 'Reserved seeded surface for a running Team response.', ['discourse:team', 'status:RUNNING']),
  scenario('discourse-panel-partial', 'discourse', 'Partial panel', 'Reserved seeded surface for partial independent answers.', ['discourse:panel', 'status:PARTIAL']),
  scenario('discourse-review-silent', 'discourse', 'Review with no concerns', 'Reserved seeded surface for explicit no-concern review receipts.', ['discourse:review', 'outcome:NO_CONCERN_FOUND']),
  scenario('discourse-author-correction', 'discourse', 'Author correction', 'Reserved seeded surface for attributable correction provenance.', ['discourse:correction']),
  scenario('discourse-followup-queued', 'discourse', 'Follow-up queued', 'Reserved seeded surface for a durable queued response.', ['discourse:queue']),
  scenario('discourse-context-stale', 'discourse', 'Context changed', 'Conversation context changed after an earlier message.', ['discourse:context', 'freshness:STALE']),
  scenario('discourse-context-unavailable', 'discourse', 'Context unavailable', 'Historical context remains visible when its source is unavailable.', ['discourse:context', 'availability:UNAVAILABLE']),
  scenario('discourse-recovery-required', 'discourse', 'Recovery required', 'Reserved seeded surface for an ambiguous provider response.', ['discourse:recovery']),
  scenario('discourse-long-history', 'discourse', 'Long conversation', 'A paginated transcript with more than one message page.', ['discourse:pagination']),
  scenario('discourse-archived', 'discourse', 'Archived conversation', 'A completed conversation in the archive.', ['discourse:archived'])
];

interface SeedPaths {
  rootDir: string;
  storeDir: string;
  repositoryPath: string;
  worktreeRoot: string;
  appSettingsPath: string;
  repositoryRegistryDir: string;
  discourseDir: string;
  agentRuntimeDir: string;
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
  const repositoryRegistry = new FileRepositoryRegistry(
    paths.repositoryRegistryDir,
    new NodeRepositoryInspector()
  );
  const registry = await repositoryRegistry.reconcile([
    { path: paths.repositoryPath, source: 'DEFAULT', isDefault: true }
  ]);
  await appSettingsStore.update({
    firstLaunchSetupCompleted: true,
    defaultModel: DEFAULT_AGENT_SETTINGS.model ?? null,
    defaultReasoningEffort: DEFAULT_AGENT_SETTINGS.reasoningEffort ?? null,
    reviewModel: DEFAULT_AGENT_SETTINGS.model ?? null,
    reviewReasoningEffort: DEFAULT_AGENT_SETTINGS.reasoningEffort ?? null
  });
  await appSettingsStore.setSelectedRepositoryId(registry.defaultRepositoryId);

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

  const discourseStore = new FileDiscourseStore(paths.discourseDir);
  await discourseStore.init();

  for (const definition of scenariosForSet(scenarioSet)) {
    if (definition.group === 'discourse') {
      const conversationId = await seedDiscourseScenario({
        definition,
        discourseStore,
        taskStore: store,
        repositoryPath: paths.repositoryPath,
        repositoryId: registry.defaultRepositoryId ?? registry.repositories[0]?.id ?? ''
      });
      ctx.scenarios.push({ ...definition, conversationId });
      continue;
    }
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
      TASK_MANAGER_REPOSITORY_REGISTRY_DIR: paths.repositoryRegistryDir,
      TASK_MANAGER_DISCOURSE_DIR: paths.discourseDir,
      TASK_MANAGER_AGENT_RUNTIME_DIR: paths.agentRuntimeDir,
      TASK_MANAGER_REPO_PATH: paths.repositoryPath,
      TASK_MANAGER_WORKTREE_ROOT: paths.worktreeRoot,
      TASK_MANAGER_DEV_SEED_MODE: '1'
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
  return manifest;
}

async function seedDiscourseScenario(input: {
  definition: DevSeedScenarioDefinition;
  discourseStore: FileDiscourseStore;
  taskStore: FileTaskStore;
  repositoryPath: string;
  repositoryId: string;
}): Promise<string> {
  const { definition, discourseStore } = input;
  const conversationId = `seed-${definition.slug}`;
  const seededPolicy = discourseSeedPolicy(definition.slug);
  const bindings = discourseSeedBindings(conversationId, seededPolicy);
  const conversation = await discourseStore.createConversation({
    id: conversationId,
    title: `[seed:${definition.slug}] ${definition.title}`,
    defaultPolicy: seededPolicy,
    participants: bindings.map((binding) => binding.participant),
    participantRevisions: bindings.map((binding) => binding.revision),
    clientOperationId: `create-${definition.slug}`
  });
  if (definition.slug === 'discourse-empty') return conversation.id;

  const task =
    (await input.taskStore.snapshot()).tasks[0] ??
    await input.taskStore.createTask({
      title: '[seed:discourse-context] Context source',
      prompt: 'Provide durable task context for Discourse seed scenarios.',
      repositoryPath: input.repositoryPath
    });
  const append = (body: string, suffix: string, options: {
    replyToMessageId?: string;
    supersedesMessageId?: string;
    context?: Array<{
      entityKind: 'TASK' | 'REPOSITORY';
      entityId: string;
      labelSnapshot: string;
      availability: 'AVAILABLE' | 'UNAVAILABLE';
    }>;
  } = {}) => discourseStore.appendHumanMessage({
    conversationId,
    body,
    ...options,
    clientMessageId: `${definition.slug}-${suffix}`
  });

  if (definition.slug === 'discourse-context-picker') {
    await discourseStore.saveDraft({
      conversationId,
      body: 'Compare the implementation against @context source and @repository.',
      policy: 'NONE',
      recipientParticipantIds: [],
      tokens: [
        {
          kind: 'TASK',
          entityId: task.id,
          labelSnapshot: task.title
        },
        {
          kind: 'REPOSITORY',
          entityId: input.repositoryId,
          labelSnapshot: 'task-monki seed repository'
        }
      ]
    });
    return conversation.id;
  }

  if (definition.slug === 'discourse-human-only') {
    const root = await append(
      'The conversation store should stay independent from task workflow state.',
      'root',
      {
        context: [{
          entityKind: 'TASK',
          entityId: task.id,
          labelSnapshot: task.title,
          availability: 'AVAILABLE'
        }]
      }
    );
    const reply = await append(
      'Agreed. Repository context should also be explicit rather than inherited from the board filter.',
      'reply',
      { replyToMessageId: root.id }
    );
    await append(
      'Correction: repository context must be selected or pinned explicitly; the active board repository is never inherited.',
      'correction',
      { supersedesMessageId: reply.id }
    );
    return conversation.id;
  }

  if ([
    'discourse-team-running',
    'discourse-panel-partial',
    'discourse-review-silent',
    'discourse-author-correction',
    'discourse-followup-queued',
    'discourse-recovery-required'
  ].includes(definition.slug)) {
    const trigger = await append(definition.description, 'message');
    await seedDiscourseAgentWaveState({
      slug: definition.slug,
      store: discourseStore,
      conversationId,
      triggerMessageId: trigger.id,
      triggerOrdinal: trigger.ordinal,
      contextRevisionId: trigger.contextRevisionId!,
      bindings
    });
    return conversation.id;
  }

  if (definition.slug === 'discourse-context-stale') {
    await discourseStore.setPinnedContext({
      conversationId,
      context: [{
        entityKind: 'REPOSITORY',
        entityId: input.repositoryId,
        labelSnapshot: 'task-monki seed repository',
        availability: 'AVAILABLE'
      }],
      expectedRevision: conversation.recordRevision,
      clientOperationId: 'seed-context-stale-pin'
    });
    const trigger = await append('This note captured the repository context before it changed.', 'message');
    const aggregate = await discourseStore.getConversation(conversationId);
    await discourseStore.setPinnedContext({
      conversationId,
      context: [{
        entityKind: 'REPOSITORY',
        entityId: input.repositoryId,
        labelSnapshot: 'task-monki seed repository',
        availability: 'UNAVAILABLE'
      }],
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'seed-context-stale-change'
    });
    await seedDiscourseAgentWaveState({
      slug: definition.slug,
      store: discourseStore,
      conversationId,
      triggerMessageId: trigger.id,
      triggerOrdinal: trigger.ordinal,
      contextRevisionId: trigger.contextRevisionId!,
      bindings
    });
    return conversation.id;
  }

  if (definition.slug === 'discourse-context-unavailable') {
    await append('The referenced repository is retained as historical context.', 'message', {
      context: [{
        entityKind: 'REPOSITORY',
        entityId: input.repositoryId,
        labelSnapshot: 'Unavailable seed repository',
        availability: 'UNAVAILABLE'
      }]
    });
    return conversation.id;
  }

  if (definition.slug === 'discourse-long-history') {
    for (let index = 1; index <= 125; index += 1) {
      await append(
        `History entry ${index}. This transcript exercises backward pagination and stable reading position.`,
        `message-${index}`
      );
    }
    return conversation.id;
  }

  await append(definition.description, 'message');
  if (definition.slug === 'discourse-archived') {
    const aggregate = await discourseStore.getConversation(conversationId);
    await discourseStore.setConversationArchived({
      conversationId,
      archived: true,
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId: 'seed-archive-conversation'
    });
  }
  return conversation.id;
}

const DISCOURSE_SEED_TIME = '2026-07-13T09:00:00.000Z';

function discourseSeedPolicy(slug: string): DiscourseDefaultPolicy {
  if ([
    'discourse-team-running',
    'discourse-review-silent',
    'discourse-author-correction'
  ].includes(slug)) return 'TEAM';
  if (slug === 'discourse-panel-partial') return 'PANEL';
  if (['discourse-followup-queued', 'discourse-recovery-required', 'discourse-context-stale'].includes(slug)) {
    return 'DIRECT';
  }
  return 'NONE';
}

function discourseSeedBindings(
  conversationId: string,
  policy: DiscourseDefaultPolicy
): Array<{
  participant: DiscourseParticipantRecord;
  revision: DiscourseParticipantRevisionRecord;
}> {
  const profiles: BuiltInAgentProfileId[] = policy === 'TEAM'
    ? ['builtin.lead', 'builtin.skeptic', 'builtin.verifier']
    : policy === 'PANEL'
      ? ['builtin.lead', 'builtin.skeptic']
      : policy === 'DIRECT'
        ? ['builtin.lead']
        : [];
  return profiles.map((profileId) => {
    const suffix = profileId.split('.').at(-1)!;
    const participantId = `${conversationId}-${suffix}`;
    const revisionId = `${participantId}-revision`;
    const displayName = suffix.charAt(0).toUpperCase() + suffix.slice(1);
    const configuredRole = profileId === 'builtin.lead'
      ? 'LEAD' as const
      : profileId === 'builtin.skeptic'
        ? 'SKEPTIC' as const
        : 'VERIFIER' as const;
    return {
      participant: {
        id: participantId,
        conversationId,
        agentProfileId: profileId,
        currentRevisionId: revisionId,
        enabled: true,
        recordRevision: 1,
        createdAt: DISCOURSE_SEED_TIME
      },
      revision: {
        id: revisionId,
        conversationId,
        stableParticipantId: participantId,
        agentProfileId: profileId,
        profileRevision: 1,
        displayNameSnapshot: displayName,
        providerId: 'codex',
        model: 'scenario-model',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        configuredRole,
        roleContractVersion: 1,
        roleContractHash: 'a'.repeat(64),
        revision: 1,
        createdAt: DISCOURSE_SEED_TIME
      }
    };
  });
}

async function seedDiscourseAgentWaveState(input: {
  slug: string;
  store: FileDiscourseStore;
  conversationId: string;
  triggerMessageId: string;
  triggerOrdinal: number;
  contextRevisionId: string;
  bindings: ReturnType<typeof discourseSeedBindings>;
}): Promise<void> {
  const assignments = input.bindings.map((binding): AgentAssignmentSnapshot => ({
    stableParticipantId: binding.participant.id,
    participantRevisionId: binding.revision.id,
    agentProfileId: binding.revision.agentProfileId,
    profileRevision: binding.revision.profileRevision,
    displayNameSnapshot: binding.revision.displayNameSnapshot,
    providerId: binding.revision.providerId,
    model: binding.revision.model,
    modelProvider: binding.revision.modelProvider,
    reasoningEffort: binding.revision.reasoningEffort,
    configuredRole: binding.revision.configuredRole,
    roleContractVersion: binding.revision.roleContractVersion,
    roleContractHash: binding.revision.roleContractHash,
    assignmentRole: input.slug === 'discourse-panel-partial'
      ? 'PANELIST'
      : binding.revision.agentProfileId === 'builtin.lead'
        ? 'PRIMARY'
        : 'REVIEWER',
    required: true
  }));
  const policy = discourseSeedPolicy(input.slug);
  const first = await seedWavePlan({
    ...input,
    suffix: 'wave-1',
    policy: policy === 'NONE' ? 'DIRECT' : policy,
    assignments,
    answerAssignments: policy === 'TEAM' ? assignments.slice(0, 1) : assignments,
    ...(input.slug === 'discourse-context-stale'
      ? {
          dispatchGate: {
            status: 'RECONFIRMATION_REQUIRED' as const,
            previewFingerprint: 'seed-preview',
            currentFingerprint: 'seed-current',
            mismatchReason: 'Selected context changed after the preview.'
          }
        }
      : {})
  });

  if (input.slug === 'discourse-context-stale') return;

  if (input.slug === 'discourse-followup-queued') {
    await seedWaveRunning(input.store, input.conversationId, first.wave.id);
    await seedJobRunning(input.store, input.conversationId, first.jobs[0]!.id);
    await seedWavePlan({
      ...input,
      suffix: 'wave-2',
      policy: 'DIRECT',
      assignments,
      answerAssignments: assignments
    });
    return;
  }

  if (input.slug === 'discourse-recovery-required') {
    await seedWaveRunning(input.store, input.conversationId, first.wave.id);
    const starting = await seedJobStarting(
      input.store,
      input.conversationId,
      first.jobs[0]!.id
    );
    await input.store.updateJob({
      conversationId: input.conversationId,
      expectedRevision: starting.recordRevision,
      clientOperationId: `${input.slug}:job-recovery`,
      job: {
        ...starting,
        recordRevision: starting.recordRevision + 1,
        status: 'RECOVERY_REQUIRED',
        delivery: 'AMBIGUOUS',
        error: {
          code: 'DELIVERY_AMBIGUOUS',
          message: 'Provider delivery could not be confirmed after restart.',
          category: 'DELIVERY',
          retryable: false
        }
      }
    });
    const wave = requireSeedWave(await input.store.getConversation(input.conversationId), first.wave.id);
    await input.store.updateWave({
      conversationId: input.conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${input.slug}:wave-recovery`,
      wave: { ...wave, recordRevision: wave.recordRevision + 1, status: 'RECOVERY_REQUIRED' }
    });
    return;
  }

  await seedWaveRunning(input.store, input.conversationId, first.wave.id);
  if (input.slug === 'discourse-team-running') {
    await seedJobRunning(input.store, input.conversationId, first.jobs[0]!.id);
    return;
  }

  if (input.slug === 'discourse-panel-partial') {
    await seedCompleteContribution(
      input.store,
      input.conversationId,
      first.jobs[0]!.id,
      'Lead found that the event log remains reconstructible and bounded by segments.'
    );
    await seedFailJob(input.store, input.conversationId, first.jobs[1]!.id);
    await seedSettleWave(input.store, input.conversationId, first.wave.id, 'PARTIAL', 'FAILED');
    return;
  }

  const leadMessageId = await seedCompleteContribution(
    input.store,
    input.conversationId,
    first.jobs[0]!.id,
    'The durable owner-neutral runtime keeps discourse work isolated from task workflow.'
  );
  await seedWavePhase(input.store, input.conversationId, first.wave.id, 'REVIEW');
  const aggregate = await input.store.getConversation(input.conversationId);
  const snapshotId = first.wave.contextSnapshotId!;
  const reviewerJobs = assignments.slice(1).map((assignment, index) =>
    seedJobRecord({
      conversationId: input.conversationId,
      waveId: first.wave.id,
      snapshotId,
      assignment,
      id: `${input.conversationId}-review-${index + 1}`,
      role: 'CRITIQUE',
      phase: 2,
      targetMessageIds: [leadMessageId],
      visibleMessageIds: [input.triggerMessageId, leadMessageId]
    })
  );
  await input.store.addJobsToWave({
    conversationId: input.conversationId,
    waveId: first.wave.id,
    jobs: reviewerJobs,
    expectedConversationRevision: aggregate.conversation.recordRevision,
    clientOperationId: `${input.slug}:add-reviews`
  });
  await seedCompleteReview(
    input.store,
    input.conversationId,
    reviewerJobs[0]!.id,
    leadMessageId,
    []
  );
  const concern = input.slug === 'discourse-author-correction'
    ? [seedConcern(input.conversationId, first.wave.id, reviewerJobs[1]!, leadMessageId)]
    : [];
  await seedCompleteReview(
    input.store,
    input.conversationId,
    reviewerJobs[1]!.id,
    leadMessageId,
    concern
  );
  if (input.slug === 'discourse-review-silent') {
    await seedSettleWave(input.store, input.conversationId, first.wave.id, 'COMPLETE', 'COMPLETED');
    return;
  }

  await seedWavePhase(input.store, input.conversationId, first.wave.id, 'CORRECT');
  const correctionAssignment = assignments[0]!;
  const correctionJob = seedJobRecord({
    conversationId: input.conversationId,
    waveId: first.wave.id,
    snapshotId,
    assignment: correctionAssignment,
    id: `${input.conversationId}-correction`,
    role: 'CORRECT',
    phase: 3,
    targetMessageIds: [leadMessageId],
    visibleMessageIds: [input.triggerMessageId, leadMessageId]
  });
  const beforeCorrection = await input.store.getConversation(input.conversationId);
  await input.store.addJobsToWave({
    conversationId: input.conversationId,
    waveId: first.wave.id,
    jobs: [correctionJob],
    expectedConversationRevision: beforeCorrection.conversation.recordRevision,
    clientOperationId: `${input.slug}:add-correction`
  });
  const runningCorrection = await seedJobRunning(
    input.store,
    input.conversationId,
    correctionJob.id
  );
  const correctionMessage = await input.store.appendAgentMessage({
    conversationId: input.conversationId,
    body: 'Correction: discourse runs are isolated from task workflow, while shared scheduler capacity remains globally bounded.',
    stableParticipantId: correctionAssignment.stableParticipantId,
    participantRevisionId: correctionAssignment.participantRevisionId,
    displayNameSnapshot: correctionAssignment.displayNameSnapshot,
    waveId: first.wave.id,
    jobId: correctionJob.id,
    contextSnapshotId: snapshotId,
    replyToMessageId: leadMessageId,
    sourceMessageIds: correctionJob.visibleMessageIds,
    freshnessAtCompletion: 'FRESH',
    clientOperationId: `${input.slug}:correction-message`
  });
  await input.store.completeCorrectionJob({
    conversationId: input.conversationId,
    expectedRevision: runningCorrection.recordRevision,
    clientOperationId: `${input.slug}:correction-terminal`,
    concernIds: concern.map((candidate) => candidate.id),
    job: {
      ...runningCorrection,
      recordRevision: runningCorrection.recordRevision + 1,
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      freshnessAtCompletion: 'FRESH',
      result: {
        kind: 'CORRECTION',
        outcome: 'REVISED',
        limitations: [],
        outputMessageId: correctionMessage.id
      },
      finishedAt: DISCOURSE_SEED_TIME
    }
  });
  await seedSettleWave(input.store, input.conversationId, first.wave.id, 'COMPLETE', 'COMPLETED');
}

async function seedWavePlan(input: {
  slug: string;
  suffix: string;
  store: FileDiscourseStore;
  conversationId: string;
  triggerMessageId: string;
  triggerOrdinal: number;
  contextRevisionId: string;
  policy: 'DIRECT' | 'PANEL' | 'TEAM';
  assignments: AgentAssignmentSnapshot[];
  answerAssignments: AgentAssignmentSnapshot[];
  dispatchGate?: DiscourseResponseWaveRecord['dispatchGate'];
}) {
  const waveId = `${input.conversationId}-${input.suffix}`;
  const snapshotId = `${waveId}-snapshot`;
  const wave: DiscourseResponseWaveRecord = {
    id: waveId,
    conversationId: input.conversationId,
    triggerMessageId: input.triggerMessageId,
    policy: input.policy,
    policyVersion: 1,
    assignments: input.assignments,
    sourceMessageIds: [input.triggerMessageId],
    plannedContextRevisionId: input.contextRevisionId,
    contextSnapshotId: snapshotId,
    attempt: 1,
    recordRevision: 1,
    status: 'PLANNED',
    phase: 'ANSWER',
    clientOperationId: `${input.slug}:${input.suffix}`,
    requestFingerprint: 'b'.repeat(64),
    dispatchGate: input.dispatchGate ?? {
      status: 'READY',
      previewFingerprint: 'seed-preview',
      confirmedAtRevision: 1
    },
    createdAt: DISCOURSE_SEED_TIME
  };
  const jobs = input.answerAssignments.map((assignment, index) => seedJobRecord({
    conversationId: input.conversationId,
    waveId,
    snapshotId,
    assignment,
    id: `${waveId}-answer-${index + 1}`,
    role: 'ANSWER',
    phase: 1,
    targetMessageIds: [input.triggerMessageId],
    visibleMessageIds: [input.triggerMessageId]
  }));
  const snapshot: ContextSnapshotRecord = {
    id: snapshotId,
    conversationId: input.conversationId,
    waveId,
    contextRevisionId: input.contextRevisionId,
    recordRevision: 1,
    status: 'READY',
    sources: [],
    transcriptOrdinals: [input.triggerOrdinal],
    attachmentIds: [],
    permissionProfileHash: 'd'.repeat(64),
    budget: { inputBytes: 128, estimatedInputTokens: 32, reservedOutputTokens: 16_000, sourceCount: 0 },
    exclusions: [],
    contextSchemaVersion: 1,
    promptPolicyVersion: 1,
    createdAt: DISCOURSE_SEED_TIME,
    resolvedAt: DISCOURSE_SEED_TIME
  };
  const aggregate = await input.store.getConversation(input.conversationId);
  await input.store.createWave({
    conversationId: input.conversationId,
    expectedConversationRevision: aggregate.conversation.recordRevision,
    wave,
    jobs,
    contextSnapshot: snapshot,
    clientOperationId: wave.clientOperationId
  });
  return { wave, jobs };
}

function seedJobRecord(input: {
  conversationId: string;
  waveId: string;
  snapshotId: string;
  assignment: AgentAssignmentSnapshot;
  id: string;
  role: 'ANSWER' | 'CRITIQUE' | 'CORRECT';
  phase: number;
  targetMessageIds: string[];
  visibleMessageIds: string[];
}): DiscourseAgentJobRecord {
  return {
    id: input.id,
    conversationId: input.conversationId,
    waveId: input.waveId,
    assignment: input.assignment,
    role: input.role,
    phase: input.phase,
    targetMessageIds: input.targetMessageIds,
    visibleMessageIds: input.visibleMessageIds,
    contextSnapshotId: input.snapshotId,
    attemptId: `${input.id}-attempt`,
    generationKey: `${input.id}-generation`,
    recordRevision: 1,
    status: 'QUEUED',
    delivery: 'NOT_SENT',
    createdAt: DISCOURSE_SEED_TIME
  };
}

async function seedWaveRunning(store: FileDiscourseStore, conversationId: string, waveId: string) {
  for (const status of ['SNAPSHOTTING', 'QUEUED', 'RUNNING'] as const) {
    const wave = requireSeedWave(await store.getConversation(conversationId), waveId);
    await store.updateWave({
      conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${waveId}:status:${status}`,
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status,
        ...(status === 'RUNNING' ? { startedAt: DISCOURSE_SEED_TIME } : {})
      }
    });
  }
}

async function seedJobStarting(store: FileDiscourseStore, conversationId: string, jobId: string) {
  let job = requireSeedJob(await store.getConversation(conversationId), jobId);
  job = await store.updateJob({
    conversationId,
    expectedRevision: job.recordRevision,
    clientOperationId: `${jobId}:resolving`,
    job: { ...job, recordRevision: job.recordRevision + 1, status: 'RESOLVING_CONTEXT' }
  });
  return store.updateJob({
    conversationId,
    expectedRevision: job.recordRevision,
    clientOperationId: `${jobId}:starting`,
    job: {
      ...job,
      recordRevision: job.recordRevision + 1,
      status: 'STARTING',
      delivery: 'SENDING',
      startedAt: DISCOURSE_SEED_TIME
    }
  });
}

async function seedJobRunning(store: FileDiscourseStore, conversationId: string, jobId: string) {
  const starting = await seedJobStarting(store, conversationId, jobId);
  return store.updateJob({
    conversationId,
    expectedRevision: starting.recordRevision,
    clientOperationId: `${jobId}:running`,
    job: {
      ...starting,
      recordRevision: starting.recordRevision + 1,
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED'
    }
  });
}

async function seedCompleteContribution(
  store: FileDiscourseStore,
  conversationId: string,
  jobId: string,
  body: string
): Promise<string> {
  const job = await seedJobRunning(store, conversationId, jobId);
  const message = await store.appendAgentMessage({
    conversationId,
    body,
    stableParticipantId: job.assignment.stableParticipantId,
    participantRevisionId: job.assignment.participantRevisionId,
    displayNameSnapshot: job.assignment.displayNameSnapshot,
    waveId: job.waveId,
    jobId: job.id,
    contextSnapshotId: job.contextSnapshotId,
    sourceMessageIds: job.visibleMessageIds,
    freshnessAtCompletion: 'FRESH',
    clientOperationId: `${jobId}:message`
  });
  await store.updateJob({
    conversationId,
    expectedRevision: job.recordRevision,
    clientOperationId: `${jobId}:completed`,
    job: {
      ...job,
      recordRevision: job.recordRevision + 1,
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      freshnessAtCompletion: 'FRESH',
      result: { kind: 'CONTRIBUTION', outputMessageId: message.id },
      finishedAt: DISCOURSE_SEED_TIME
    }
  });
  return message.id;
}

async function seedFailJob(store: FileDiscourseStore, conversationId: string, jobId: string) {
  const job = await seedJobRunning(store, conversationId, jobId);
  await store.updateJob({
    conversationId,
    expectedRevision: job.recordRevision,
    clientOperationId: `${jobId}:failed`,
    job: {
      ...job,
      recordRevision: job.recordRevision + 1,
      status: 'FAILED',
      delivery: 'TERMINAL',
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The second panelist did not return a response.',
        category: 'PROVIDER',
        retryable: true
      },
      finishedAt: DISCOURSE_SEED_TIME
    }
  });
}

async function seedCompleteReview(
  store: FileDiscourseStore,
  conversationId: string,
  jobId: string,
  targetMessageId: string,
  concerns: DiscourseConcernRecord[]
) {
  const job = await seedJobRunning(store, conversationId, jobId);
  await store.completeReviewJob({
    conversationId,
    expectedRevision: job.recordRevision,
    clientOperationId: `${jobId}:completed`,
    concerns,
    job: {
      ...job,
      recordRevision: job.recordRevision + 1,
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      freshnessAtCompletion: 'FRESH',
      result: {
        kind: 'REVIEW',
        outcome: concerns.length > 0 ? 'CONCERNS' : 'NO_CONCERN_FOUND',
        reviewedScope: targetMessageId,
        limitations: [],
        requiredAccessAvailable: true,
        concernIds: concerns.map((concern) => concern.id)
      },
      finishedAt: DISCOURSE_SEED_TIME
    }
  });
}

function seedConcern(
  conversationId: string,
  waveId: string,
  reviewJob: DiscourseAgentJobRecord,
  targetMessageId: string
): DiscourseConcernRecord {
  return {
    id: `${reviewJob.id}-concern`,
    conversationId,
    waveId,
    reviewJobId: reviewJob.id,
    reviewerParticipantRevisionId: reviewJob.assignment.participantRevisionId,
    targetMessageId,
    targetClaim: 'Discourse work is completely separate from shared runtime capacity.',
    category: 'runtime isolation',
    severity: 'MATERIAL',
    confidence: 'HIGH',
    evidenceStatus: 'LOGICAL_CONTRADICTION',
    reason: 'The answer omits that task and discourse jobs share a globally bounded scheduler.',
    evidence: 'Both owners lease work through AgentTurnScheduler.',
    suggestedResolution: 'Clarify owner isolation while acknowledging shared scheduler capacity.',
    requiredAccessAvailable: true,
    recordRevision: 1,
    createdAt: DISCOURSE_SEED_TIME
  };
}

async function seedWavePhase(
  store: FileDiscourseStore,
  conversationId: string,
  waveId: string,
  phase: 'REVIEW' | 'CORRECT'
) {
  const wave = requireSeedWave(await store.getConversation(conversationId), waveId);
  await store.updateWave({
    conversationId,
    expectedRevision: wave.recordRevision,
    clientOperationId: `${waveId}:phase:${phase}`,
    wave: { ...wave, recordRevision: wave.recordRevision + 1, phase }
  });
}

async function seedSettleWave(
  store: FileDiscourseStore,
  conversationId: string,
  waveId: string,
  outcome: 'COMPLETE' | 'PARTIAL',
  settlementReason: 'COMPLETED' | 'FAILED'
) {
  const wave = requireSeedWave(await store.getConversation(conversationId), waveId);
  await store.updateWave({
    conversationId,
    expectedRevision: wave.recordRevision,
    clientOperationId: `${waveId}:settled`,
    wave: {
      ...wave,
      recordRevision: wave.recordRevision + 1,
      status: 'SETTLED',
      phase: 'COMPLETE',
      outcome,
      settlementReason,
      settledAt: DISCOURSE_SEED_TIME
    }
  });
}

function requireSeedWave(
  aggregate: Awaited<ReturnType<FileDiscourseStore['getConversation']>>,
  waveId: string
) {
  const wave = aggregate.waves.find((candidate) => candidate.id === waveId);
  if (!wave) throw new Error(`Seed discourse wave is missing: ${waveId}`);
  return wave;
}

function requireSeedJob(
  aggregate: Awaited<ReturnType<FileDiscourseStore['getConversation']>>,
  jobId: string
) {
  const job = aggregate.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Seed discourse job is missing: ${jobId}`);
  return job;
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
  if (
    ![
      'all',
      'board',
      'agent',
      'review',
      'delivery',
      'completion',
      'workflow',
      'discourse'
    ].includes(value)
  ) {
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
    appSettingsPath: path.resolve(options.appSettingsPath ?? path.join(rootDir, 'app-settings.json')),
    repositoryRegistryDir: path.resolve(
      options.repositoryRegistryDir ?? path.join(rootDir, 'repository-registry')
    ),
    discourseDir: path.resolve(options.discourseDir ?? path.join(rootDir, 'discourse')),
    agentRuntimeDir: path.resolve(options.agentRuntimeDir ?? path.join(rootDir, 'agent-runtime')),
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
