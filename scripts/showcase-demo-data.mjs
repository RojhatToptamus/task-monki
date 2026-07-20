import { readFile } from "node:fs/promises";
import path from "node:path";

export const SHOWCASE_TASKS = {
  backlog: "Add empty-state illustrations to the docs portal",
  ready: "Improve repository switcher keyboard flow",
  done: "Refine notification motion and timing",
  atlas: "Build Atlas launch operations dashboard",
};

export const ROUGH_PROMPT =
  "Build an operations dashboard for the Atlas launch team. Show release readiness, service health, current blockers, and the critical path. Add a preview recipe so we can inspect the branch before accepting it.";

export const REFINED_TITLE = SHOWCASE_TASKS.atlas;

export const REFINED_PROMPT = `Build the Atlas launch operations dashboard in the isolated task branch.

Requirements:
1. Show launch readiness, active workstreams, blockers, and the deployment window.
2. Show service health and a readable critical-path checklist.
3. Compute status freshness from runtime data instead of hard-coded display text.
4. Add a valid .taskmonki/preview.yaml recipe with a primary HTTP route.
5. Add focused tests for the status-freshness behavior.

Verification:
- node --test dashboard.test.mjs
- git diff main...HEAD --check
- git diff --check`;

export const SHOWCASE_TASK_ID = "showcase-atlas-launch-dashboard";
export const SHOWCASE_BRANCH = "task-monki/launch-dashboard-preview";

const visibleSlugs = ["board-backlog", "board-ready", "delivery-merged"];
const templateSlugs = [
  "board-backlog",
  "board-ready",
  "agent-running",
  "review-needs-changes",
  "review-follow-up-active",
  "delivery-merged",
  "preview-ready",
];

const showcaseTaskCopy = {
  "board-backlog": {
    title: SHOWCASE_TASKS.backlog,
    prompt:
      "Add concise empty-state illustrations to the docs portal without changing the existing information hierarchy.",
  },
  "board-ready": {
    title: SHOWCASE_TASKS.ready,
    prompt:
      "Make repository switching fully keyboard accessible and retain the selected repository as the new-task default.",
  },
  "agent-running": {
    title: SHOWCASE_TASKS.atlas,
    prompt:
      "Build the Atlas launch operations dashboard and expose it through the repository preview recipe.",
  },
  "review-needs-changes": {
    title: SHOWCASE_TASKS.atlas,
    prompt:
      "Build the Atlas launch operations dashboard and expose it through the repository preview recipe.",
  },
  "review-follow-up-active": {
    title: SHOWCASE_TASKS.atlas,
    prompt:
      "Address the Atlas dashboard review finding, rerun the focused test, and leave the prior review visible as stale context.",
  },
  "delivery-merged": {
    title: SHOWCASE_TASKS.done,
    prompt:
      "Refine notification motion and timing, verify the final branch, and complete delivery after merge.",
  },
  "preview-ready": {
    title: SHOWCASE_TASKS.atlas,
    prompt:
      "Build the Atlas launch dashboard in an isolated branch and expose it through the repository preview recipe.",
  },
};

export async function loadShowcaseData(rootDir) {
  const manifestPath = path.join(
    rootDir,
    ".local",
    "task-monki-dev-seed",
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const storePath = path.join(manifest.storeDir, "store.json");
  const snapshot = JSON.parse(await readFile(storePath, "utf8"));
  const scenarios = new Map(
    manifest.scenarios.map((scenario) => [scenario.slug, scenario]),
  );
  const taskIdBySlug = Object.fromEntries(
    templateSlugs.map((slug) => [
      slug,
      requireScenario(scenarios, slug).taskId,
    ]),
  );
  const visibleTaskIds = new Set(
    visibleSlugs.map((slug) => taskIdBySlug[slug]),
  );
  const stageTemplates = Object.fromEntries(
    [
      ["prepared", "preview-ready"],
      ["running", "agent-running"],
      ["review", "review-needs-changes"],
      ["followup", "review-follow-up-active"],
      ["preview", "preview-ready"],
    ].map(([stage, slug]) => [
      stage,
      extractTaskBundle(snapshot, taskIdBySlug[slug]),
    ]),
  );
  const artifactTexts = new Map();

  await Promise.all(
    snapshot.artifacts.map(async (artifact) => {
      try {
        artifactTexts.set(artifact.id, await readFile(artifact.path, "utf8"));
      } catch {
        artifactTexts.set(artifact.id, "Artifact output is unavailable.");
      }
    }),
  );

  snapshot.tasks = snapshot.tasks
    .filter((task) => visibleTaskIds.has(task.id))
    .map((task) => {
      const slug = visibleSlugs.find(
        (candidate) => taskIdBySlug[candidate] === task.id,
      );
      const copy = showcaseTaskCopy[slug];
      return {
        ...task,
        title: copy.title,
        prompt: copy.prompt,
        runtimeId: runtimeForSlug(slug),
        agentSettings: {
          ...task.agentSettings,
          runtimeId: runtimeForSlug(slug),
          model: modelForSlug(slug),
          modelProvider: modelProviderForSlug(slug),
          reasoningEffort: "medium",
        },
      };
    });
  removeHiddenTaskRecords(snapshot, visibleTaskIds);

  const primaryRepository = snapshot.repositories[0];
  const secondaryRepository = snapshot.repositories[1];
  if (!primaryRepository || !secondaryRepository) {
    throw new Error("The showcase seed requires two repositories.");
  }

  Object.assign(primaryRepository, {
    name: "Task Monki",
    path: "/Users/demo/Code/task-monki",
    branch: "main",
  });
  Object.assign(secondaryRepository, {
    name: "Atlas Web",
    path: "/Users/demo/Code/atlas-web",
    branch: "main",
  });

  for (const remote of primaryRepository.remotes ?? []) {
    remote.url = "git@github.com:taskmonki/task-monki.git";
  }
  for (const remote of secondaryRepository.remotes ?? []) {
    remote.url = "git@github.com:acme/atlas-web.git";
  }

  for (const slug of ["board-backlog"]) {
    const task = snapshot.tasks.find(
      (candidate) => candidate.id === taskIdBySlug[slug],
    );
    if (task) task.repositoryId = secondaryRepository.id;
  }

  snapshot.boards = [
    board("showcase-board-launch", "Launch workspace", "BLUE", [], []),
    board(
      "showcase-board-atlas",
      "Atlas frontend",
      "VIOLET",
      [secondaryRepository.id],
      [],
    ),
    board(
      "showcase-board-ship",
      "Ready to ship",
      "GREEN",
      [],
      ["REVIEW", "IN_REVIEW", "DONE"],
    ),
  ];

  sanitizeSnapshotPaths(
    snapshot,
    taskIdBySlug,
    primaryRepository,
    secondaryRepository,
  );

  const appSettings = {
    schemaVersion: 9,
    theme: "dark",
    sidebarCollapsed: false,
    showMascot: false,
    firstLaunchSetupCompleted: true,
    disabledRuntimeIds: [],
    defaultRuntimeId: "codex",
    defaultModel: "gpt-5.3-codex",
    defaultModelProvider: "openai",
    defaultReasoningEffort: "medium",
    promptRefinementModel: "gpt-5.3-codex",
    promptRefinementRuntimeId: "codex",
    promptRefinementModelProvider: "openai",
    reviewModel: "gpt-5.3-codex",
    reviewRuntimeId: "codex",
    reviewModelProvider: "openai",
    reviewReasoningEffort: "high",
    codexExternalTools: {
      webSearchMode: "disabled",
      mcpServers: "disabled",
      apps: "disabled",
    },
    externalExecutables: {
      gitExecutablePath: null,
      codexExecutablePath: null,
      ghExecutablePath: null,
    },
    runtimeExecutablePaths: {},
    selectedRepositoryId: primaryRepository.id,
    previewGateway: { port: 43130 },
  };

  return {
    snapshot,
    appSettings,
    runtimeCatalog: createRuntimeCatalog(),
    artifactTexts,
    taskIdBySlug,
    stageTemplates,
    showcaseStage: "BOARD",
    showcaseTaskId: undefined,
    previewEvidence: undefined,
    repositories: {
      primary: primaryRepository,
      secondary: secondaryRepository,
    },
  };
}

export function createShowcaseTask({ data, input }) {
  const template = data.snapshot.tasks.find(
    (task) => task.title === SHOWCASE_TASKS.ready,
  );
  if (!template) throw new Error("Ready task template is unavailable.");
  const now = new Date("2026-07-20T09:42:00.000Z").toISOString();
  const task = {
    ...structuredClone(template),
    id: SHOWCASE_TASK_ID,
    runtimeId: input.runtimeId || "cursor-agent-acp",
    title: REFINED_TITLE,
    prompt: input.prompt || REFINED_PROMPT,
    repositoryId: input.repositoryId,
    creationToken: input.creationToken,
    completionPolicy: input.completionPolicy ?? template.completionPolicy,
    workflowPhase: "READY",
    resolution: undefined,
    phaseVersion: 1,
    currentRunId: undefined,
    currentAgentSessionId: undefined,
    currentIterationId: undefined,
    currentWorktreeId: undefined,
    currentGitSnapshotId: undefined,
    agentSettings: {
      ...(input.agentSettings ?? {}),
      runtimeId: input.runtimeId || "cursor-agent-acp",
    },
    createdAt: now,
    updatedAt: now,
    projection: {
      requestedAction: "NONE",
      agentRun: "IDLE",
      osProcess: "UNKNOWN",
      repositoryPreflight: "UNKNOWN",
      worktree: "NOT_CREATED",
      git: "NOT_INSPECTED",
      githubRepository: "NOT_CHECKED",
      branchPublication: "NOT_PUSHED",
      githubPullRequest: "UNLINKED",
      ciChecks: "NOT_APPLICABLE",
      reviews: "NOT_APPLICABLE",
      agentReview: { status: "NOT_RUN" },
      merge: "NOT_APPLICABLE",
      artifact: "NONE",
      health: "INFO",
      summary: "Ready for isolated implementation.",
      findings: [],
      updatedAt: now,
    },
  };
  data.showcaseTaskId = task.id;
  data.showcaseStage = "READY";
  return task;
}

export function prepareShowcaseWorktree(data, taskId) {
  const task = installShowcaseStage(data, taskId, "prepared", {
    recordKeys: ["iterations", "worktrees", "gitSnapshots", "events"],
  });
  data.showcaseStage = "PREPARED";
  return requireTaskRecord(data.snapshot.worktrees, task.currentWorktreeId);
}

export function startShowcaseImplementation(data, taskId) {
  const task = installShowcaseStage(data, taskId, "running");
  data.showcaseStage = "IMPLEMENTATION_RUNNING";
  return requireTaskRecord(data.snapshot.runs, task.currentRunId);
}

export function completeShowcaseImplementation(data, taskId) {
  const task = installShowcaseStage(data, taskId, "review");
  removeReviewRecords(data.snapshot, task);
  const now = "2026-07-20T09:46:00.000Z";
  task.workflowPhase = "REVIEW";
  task.projection.agentReview = { status: "NOT_RUN" };
  task.projection.summary =
    "Implementation completed. Ready for detached review.";
  task.projection.updatedAt = now;
  task.updatedAt = now;
  data.showcaseStage = "REVIEW_READY";
  return task;
}

export function startShowcaseReview(data, taskId) {
  const passed = data.showcaseStage === "FOLLOWUP_REVIEW_READY";
  const task = installShowcaseStage(data, taskId, "review");
  bindReviewEvidence(
    data,
    task,
    passed
      ? (data.previewEvidence ?? fallbackPreviewEvidence()).finalSha
      : (data.previewEvidence ?? fallbackPreviewEvidence()).implementationSha,
  );
  if (passed) {
    markReviewPassed(data, task);
    attachPreviewRecords(data, task);
    data.showcaseStage = "REVIEW_PASSED";
  } else {
    markReviewNeedsChanges(data, task);
    data.showcaseStage = "REVIEW_NEEDS_CHANGES";
  }
  return requireTaskRecord(
    data.snapshot.runs,
    task.projection.agentReview.runId,
  );
}

export function startShowcaseReviewFollowup(data, taskId) {
  const task = installShowcaseStage(data, taskId, "followup");
  bindReviewEvidence(
    data,
    task,
    (data.previewEvidence ?? fallbackPreviewEvidence()).implementationSha,
  );
  markReviewNeedsChanges(data, task);
  markReviewStale(task, true);
  data.showcaseStage = "FOLLOWUP_RUNNING";
  return requireTaskRecord(data.snapshot.runs, task.currentRunId);
}

export function completeShowcaseFollowup(data, taskId) {
  const task = requireShowcaseTask(data, taskId);
  const run = requireTaskRecord(data.snapshot.runs, task.currentRunId);
  const now = "2026-07-20T09:49:00.000Z";
  run.status = "COMPLETED";
  run.endedAt = now;
  run.lastEventAt = now;
  run.finalMessage =
    "Fixed status freshness, reran the focused test, and preserved the preview recipe.";
  task.workflowPhase = "REVIEW";
  task.projection.requestedAction = "SUCCEEDED";
  task.projection.agentRun = "COMPLETED";
  task.projection.osProcess = "EXITED";
  task.projection.git = "COMMITTED_UNPUSHED";
  task.projection.summary = "Follow-up completed. Run review again.";
  task.projection.updatedAt = now;
  task.updatedAt = now;
  data.showcaseStage = "FOLLOWUP_REVIEW_READY";
  return task;
}

export function markShowcaseDone(data, taskId) {
  const task = requireShowcaseTask(data, taskId);
  const now = "2026-07-20T09:52:00.000Z";
  task.workflowPhase = "DONE";
  task.resolution = "ACCEPTED";
  task.phaseVersion += 1;
  task.updatedAt = now;
  task.projection.summary =
    "Accepted after implementation, review, local evidence, and branch preview.";
  task.projection.updatedAt = now;
  data.showcaseStage = "DONE";
  return task;
}

function installShowcaseStage(data, taskId, stage, options = {}) {
  const current = requireShowcaseTask(data, taskId);
  const template = data.stageTemplates[stage];
  if (!template) throw new Error(`Missing showcase stage template: ${stage}`);

  removeTaskRecords(data.snapshot, taskId);
  const bundle = replaceStrings(structuredClone(template), {
    [template.task.id]: taskId,
  });
  const next = bundle.task;
  Object.assign(next, {
    id: current.id,
    title: REFINED_TITLE,
    prompt: REFINED_PROMPT,
    repositoryId: current.repositoryId,
    runtimeId: current.runtimeId,
    completionPolicy: current.completionPolicy,
    creationToken: current.creationToken,
    agentSettings: current.agentSettings,
    createdAt: current.createdAt,
    phaseVersion: current.phaseVersion + 1,
  });
  delete next.resolution;

  const recordKeys = options.recordKeys ?? Object.keys(bundle.records);
  for (const key of recordKeys) {
    const target = data.snapshot[key];
    const records = bundle.records[key];
    if (Array.isArray(target) && Array.isArray(records))
      target.push(...records);
  }

  const taskIndex = data.snapshot.tasks.findIndex(
    (candidate) => candidate.id === taskId,
  );
  data.snapshot.tasks[taskIndex] = next;
  polishAtlasStage(data, next, stage);
  return next;
}

function polishAtlasStage(data, task, stage) {
  const evidence = data.previewEvidence ?? fallbackPreviewEvidence();
  const finalEvidence =
    stage === "followup" ||
    ["FOLLOWUP_RUNNING", "FOLLOWUP_REVIEW_READY"].includes(data.showcaseStage);
  const prepared = stage === "prepared";
  const running = stage === "running";
  const headSha = prepared
    ? evidence.baseSha
    : finalEvidence
      ? evidence.finalSha
      : evidence.implementationSha;
  const diffText = finalEvidence
    ? evidence.finalDiff
    : evidence.implementationDiff;

  for (const worktree of data.snapshot.worktrees.filter(
    (record) => record.taskId === task.id,
  )) {
    worktree.path = evidence.repositoryPath;
    worktree.repositoryPath = evidence.repositoryPath;
    worktree.branchName = SHOWCASE_BRANCH;
  }
  for (const gitSnapshot of data.snapshot.gitSnapshots.filter(
    (record) => record.taskId === task.id,
  )) {
    gitSnapshot.worktreePath = evidence.repositoryPath;
    gitSnapshot.repoRoot = evidence.repositoryPath;
    gitSnapshot.gitCommonDir = path.join(evidence.repositoryPath, ".git");
    gitSnapshot.branch = SHOWCASE_BRANCH;
    gitSnapshot.baseRef = "main";
    gitSnapshot.baseSha = evidence.baseSha;
    gitSnapshot.headSha = headSha;
    gitSnapshot.status = prepared
      ? "CLEAN"
      : running
        ? "DIRTY"
        : "COMMITTED_UNPUSHED";
    gitSnapshot.aheadCount = prepared ? 0 : finalEvidence ? 2 : 1;
    gitSnapshot.behindCount = 0;
    gitSnapshot.stagedCount = 0;
    gitSnapshot.unstagedCount = 0;
    gitSnapshot.untrackedCount = running ? 5 : 0;
    gitSnapshot.commitsAheadOfBase = prepared ? 0 : finalEvidence ? 2 : 1;
    gitSnapshot.committedDiffFileCount = prepared || running ? 0 : 5;
    gitSnapshot.workingDiffFileCount = running ? 5 : 0;
    gitSnapshot.diffStat = prepared ? "" : evidence.diffStat;
    gitSnapshot.dirtyFingerprint = finalEvidence
      ? evidence.finalSha
      : evidence.implementationSha;
    task.currentGitSnapshotId = gitSnapshot.id;
    if (gitSnapshot.diffArtifactId) {
      data.artifactTexts.set(
        gitSnapshot.diffArtifactId,
        formatDiffEvidence(evidence, headSha, diffText),
      );
    }
  }
  task.projection.git = prepared
    ? "CLEAN"
    : running
      ? "DIRTY"
      : "COMMITTED_UNPUSHED";

  const reviewSessionIds = new Set(
    data.snapshot.runs
      .filter((run) => run.taskId === task.id && run.mode === "REVIEW")
      .map((run) => run.sessionId)
      .filter(Boolean),
  );
  for (const run of data.snapshot.runs.filter(
    (record) => record.taskId === task.id,
  )) {
    run.runtimeId = run.mode === "REVIEW" ? "codex" : "cursor-agent-acp";
    run.requestedSettings =
      run.mode === "REVIEW"
        ? {
            runtimeId: "codex",
            model: "gpt-5.3-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
          }
        : task.agentSettings;
    run.providerTurnId =
      run.mode === "REVIEW"
        ? data.showcaseStage === "FOLLOWUP_REVIEW_READY"
          ? "codex-review-final"
          : "codex-review-initial"
        : finalEvidence
          ? "cursor-followup-status-freshness"
          : "cursor-implementation-atlas";
  }
  for (const session of data.snapshot.agentSessions.filter(
    (record) => record.taskId === task.id,
  )) {
    session.worktreePath = evidence.repositoryPath;
    session.runtimeId = reviewSessionIds.has(session.id)
      ? "codex"
      : "cursor-agent-acp";
    session.requestedSettings = reviewSessionIds.has(session.id)
      ? {
          runtimeId: "codex",
          model: "gpt-5.3-codex",
          modelProvider: "openai",
          reasoningEffort: "high",
        }
      : task.agentSettings;
  }
  for (const plan of data.snapshot.agentPlanRevisions.filter(
    (record) => record.taskId === task.id,
  )) {
    plan.explanation = "Implement the Atlas launch operations dashboard.";
    plan.steps = [
      { step: "Build launch operations dashboard", status: "COMPLETED" },
      { step: "Add branch preview recipe", status: "COMPLETED" },
      {
        step: "Verify status freshness and readiness",
        status: finalEvidence ? "COMPLETED" : "IN_PROGRESS",
      },
    ];
  }
  for (const artifact of data.snapshot.artifacts.filter(
    (record) => record.taskId === task.id,
  )) {
    artifact.path = `/Users/demo/.task-monki/artifacts/${artifact.id}.log`;
  }

  rewriteAtlasAgentTelemetry(data, task, evidence);

  task.title = REFINED_TITLE;
  task.prompt = REFINED_PROMPT;
  task.repositoryId = data.repositories.secondary.id;
  task.runtimeId = "cursor-agent-acp";
  task.agentSettings = {
    ...task.agentSettings,
    runtimeId: "cursor-agent-acp",
    model: "composer-1",
    modelProvider: "cursor",
  };
}

function removeReviewRecords(snapshot, task) {
  const reviewRuns = snapshot.runs.filter(
    (run) => run.taskId === task.id && run.mode === "REVIEW",
  );
  const reviewRunIds = new Set(reviewRuns.map((run) => run.id));
  const reviewSessionIds = new Set(
    reviewRuns.map((run) => run.sessionId).filter(Boolean),
  );
  for (const [key, records] of Object.entries(snapshot)) {
    if (!Array.isArray(records) || key === "tasks") continue;
    snapshot[key] = records.filter((record) => {
      if (!record || typeof record !== "object") return true;
      if (key === "runs" && reviewRunIds.has(record.id)) return false;
      if (key === "agentSessions" && reviewSessionIds.has(record.id))
        return false;
      if (reviewRunIds.has(record.runId)) return false;
      if (reviewSessionIds.has(record.sessionId)) return false;
      return true;
    });
  }
  task.currentRunId = task.projection.agentReview.sourceRunId;
}

function markReviewNeedsChanges(data, task) {
  const now = "2026-07-20T09:47:00.000Z";
  const summary =
    "Review found one status-freshness path that becomes stale after launch.";
  const finding = atlasReviewFinding();
  task.workflowPhase = "REVIEW";
  task.projection.agentReview = {
    ...task.projection.agentReview,
    status: "NEEDS_CHANGES",
    summary,
    updatedAt: now,
    result: {
      schemaVersion: "agent-review/v1",
      verdict: "NEEDS_CHANGES",
      summary,
      findings: [finding],
    },
  };
  task.projection.summary = summary;
  task.projection.updatedAt = now;
  task.updatedAt = now;
  const reviewRun = data.snapshot.runs.find(
    (run) => run.id === task.projection.agentReview.runId,
  );
  if (reviewRun) reviewRun.finalMessage = formatReviewMessage(summary, finding);
  if (task.projection.agentReview.finalArtifactId) {
    data.artifactTexts.set(
      task.projection.agentReview.finalArtifactId,
      formatReviewMessage(summary, finding),
    );
  }
}

function markReviewStale(task, running) {
  const now = "2026-07-20T09:48:00.000Z";
  const summary = running
    ? "Follow-up implementation is fixing status freshness."
    : "Follow-up completed. Run review again.";
  task.workflowPhase = running ? "IN_PROGRESS" : "REVIEW";
  task.projection.agentReview = {
    ...task.projection.agentReview,
    status: "STALE",
    summary:
      "The previous finding is stale because the implementation changed.",
    updatedAt: now,
  };
  task.projection.summary = summary;
  task.projection.updatedAt = now;
  task.updatedAt = now;
}

function markReviewPassed(data, task) {
  const now = "2026-07-20T09:50:00.000Z";
  const summary =
    "Detached review passed. Status freshness now derives from runtime data.";
  task.workflowPhase = "REVIEW";
  task.projection.requestedAction = "SUCCEEDED";
  task.projection.agentRun = "COMPLETED";
  task.projection.osProcess = "EXITED";
  task.projection.git = "COMMITTED_UNPUSHED";
  task.projection.agentReview = {
    ...task.projection.agentReview,
    status: "PASSED",
    summary,
    updatedAt: now,
    result: {
      schemaVersion: "agent-review/v1",
      verdict: "PASSED",
      summary,
      findings: [],
    },
  };
  task.projection.health = "HEALTHY";
  task.projection.summary = summary;
  task.projection.updatedAt = now;
  task.updatedAt = now;
  const sourceRun = data.snapshot.runs.find(
    (run) => run.id === task.currentRunId,
  );
  if (sourceRun) {
    sourceRun.mode = "FOLLOW_UP";
    sourceRun.status = "COMPLETED";
    sourceRun.endedAt = "2026-07-20T09:49:00.000Z";
    sourceRun.finalMessage =
      "Fixed status freshness and preserved the branch preview recipe.";
  }
  const reviewRun = data.snapshot.runs.find(
    (run) => run.id === task.projection.agentReview.runId,
  );
  if (reviewRun) reviewRun.finalMessage = summary;
  if (task.projection.agentReview.finalArtifactId) {
    data.artifactTexts.set(
      task.projection.agentReview.finalArtifactId,
      summary,
    );
  }
}

function bindReviewEvidence(data, task, reviewedHeadSha) {
  const gitSnapshot = data.snapshot.gitSnapshots.find(
    (record) => record.id === task.currentGitSnapshotId,
  );
  const sourceRun = data.snapshot.runs.find(
    (run) => run.taskId === task.id && run.mode !== "REVIEW",
  );
  task.projection.agentReview = {
    ...task.projection.agentReview,
    sourceRunId: sourceRun?.id ?? task.projection.agentReview.sourceRunId,
    reviewedGitSnapshotId:
      gitSnapshot?.id ?? task.projection.agentReview.reviewedGitSnapshotId,
    reviewedHeadSha,
    reviewedDirtyFingerprint: reviewedHeadSha,
  };
}

function rewriteAtlasAgentTelemetry(data, task, evidence) {
  const runIds = new Set(
    data.snapshot.runs
      .filter((run) => run.taskId === task.id)
      .map((run) => run.id),
  );
  const replacements = [
    [data.repositories.primary.path, evidence.repositoryPath],
    ["src/renderer/ui/TaskDetail.tsx", "dashboard.mjs"],
    ["src/renderer/model/runProgress.ts", "dashboard.mjs"],
    ["TaskDetail.tsx", "dashboard.mjs"],
    ["runProgress.ts", "dashboard.mjs"],
    ["npm run typecheck", "node --test dashboard.test.mjs"],
    [
      "Updated the overview panel and will verify the seeded UI next.",
      "Built the Atlas dashboard and will verify status freshness next.",
    ],
  ];
  for (const item of data.snapshot.agentItems.filter((record) =>
    runIds.has(record.runId),
  )) {
    replaceStringFields(item, replacements);
  }
}

function replaceStringFields(value, replacements) {
  if (!value || typeof value !== "object") return;
  for (const [key, current] of Object.entries(value)) {
    if (typeof current === "string") {
      value[key] = replacements.reduce(
        (result, [from, to]) => result.replaceAll(from, to),
        current,
      );
    } else {
      replaceStringFields(current, replacements);
    }
  }
}

function attachPreviewRecords(data, task) {
  const template = data.stageTemplates.preview;
  const replacements = {
    [template.task.id]: task.id,
    [template.task.currentIterationId]: task.currentIterationId,
    [template.task.currentWorktreeId]: task.currentWorktreeId,
  };
  const previewKeys = [
    "previewPlans",
    "previewApprovals",
    "previewComposeProjects",
    "previewGenerations",
    "previewManagedEnvironments",
    "previewManagedResources",
    "previewGenerationAttachments",
    "previewLocalBindings",
    "previewNodeAttempts",
    "previewResources",
  ];
  for (const key of previewKeys) {
    const records = replaceStrings(
      structuredClone(template.records[key] ?? []),
      replacements,
    );
    data.snapshot[key].push(...records);
  }
  const artifacts = replaceStrings(
    structuredClone(template.records.artifacts ?? []),
    replacements,
  ).filter((artifact) => artifact.kind?.startsWith("preview-"));
  data.snapshot.artifacts.push(...artifacts);
  for (const plan of data.snapshot.previewPlans.filter(
    (record) => record.taskId === task.id,
  )) {
    plan.stableRoute = "/";
  }
  for (const resource of data.snapshot.previewResources.filter(
    (record) => record.taskId === task.id,
  )) {
    if (resource.routeName) resource.routeName = "app";
  }
}

function atlasReviewFinding() {
  return {
    id: "atlas-status-freshness",
    severity: "MAJOR",
    title: "Status freshness is hard-coded",
    explanation:
      "The launch status says it was checked 14 seconds ago even after the underlying timestamp changes, so operators can mistake stale data for a current health signal.",
    path: "dashboard.mjs",
    line: 18,
    endLine: 27,
    recommendation:
      "Derive the relative age from the latest status timestamp and cover the boundary behavior in dashboard.test.mjs.",
  };
}

function formatReviewMessage(summary, finding) {
  return `${summary}\n\n- [P1] ${finding.title} — ${finding.path}:${finding.line}\n  ${finding.explanation}\n\n  ${finding.recommendation}`;
}

function formatDiffEvidence(evidence, headSha, diff) {
  return `# Git diff evidence

Worktree: ${evidence.repositoryPath}
Branch: ${SHOWCASE_BRANCH}
Base: ${evidence.baseSha}
Head: ${headSha}

## Verification

${evidence.testOutput.trim()}

## Diff stat

${evidence.diffStat.trim()}

## Committed diff

${diff.trim()}

## Staged diff

No staged diff.

## Unstaged diff

No unstaged diff.
`;
}

function fallbackPreviewEvidence() {
  return {
    repositoryPath: "/private/tmp/task-monki-showcase-preview-repo",
    baseSha: "1111111111111111111111111111111111111111",
    implementationSha: "2222222222222222222222222222222222222222",
    finalSha: "3333333333333333333333333333333333333333",
    diffStat:
      "index.html | 120 +\nstyles.css | 286 +\ndashboard.mjs | 34 +\ndashboard.test.mjs | 28 +\n.taskmonki/preview.yaml | 18 +",
    implementationDiff: "Implementation diff unavailable before capture.",
    finalDiff: "Final diff unavailable before capture.",
    testOutput: "tests 2\npass 2\nfail 0",
  };
}

function requireShowcaseTask(data, taskId) {
  if (taskId !== data.showcaseTaskId) {
    throw new Error(`Unexpected showcase task ${taskId}.`);
  }
  const task = data.snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("Showcase task not found.");
  return task;
}

function requireTaskRecord(records, id) {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Showcase record ${id} not found.`);
  return record;
}

function createRuntimeCatalog() {
  const refreshedAt = "2026-07-20T09:40:00.000Z";
  const models = [
    model(
      "codex:gpt-5.3-codex",
      "codex",
      "openai",
      "gpt-5.3-codex",
      "GPT-5.3 Codex",
      true,
    ),
    model(
      "codex:gpt-5.2-codex",
      "codex",
      "openai",
      "gpt-5.2-codex",
      "GPT-5.2 Codex",
      false,
    ),
    model(
      "opencode:claude-sonnet-4.5",
      "opencode",
      "anthropic",
      "claude-sonnet-4.5",
      "Claude Sonnet 4.5",
      true,
    ),
    model(
      "opencode:gemini-2.5-pro",
      "opencode",
      "google",
      "gemini-2.5-pro",
      "Gemini 2.5 Pro",
      false,
    ),
    model(
      "cursor-agent-acp:composer-1",
      "cursor-agent-acp",
      "cursor",
      "composer-1",
      "Composer 1",
      true,
    ),
  ];
  const runtimes = [
    runtimeState(
      "codex",
      "Codex",
      "APP_SERVER",
      "STDIO",
      "APPLICATION",
      models,
      refreshedAt,
    ),
    runtimeState(
      "opencode",
      "OpenCode",
      "HTTP_AGENT",
      "HTTP_SSE",
      "SESSION",
      models,
      refreshedAt,
    ),
    runtimeState(
      "cursor-agent-acp",
      "Cursor Agent",
      "ACP_AGENT",
      "STDIO",
      "SESSION",
      models,
      refreshedAt,
    ),
  ];
  return { runtimes, models, defaultRuntimeId: "codex", refreshedAt };
}

function runtimeState(
  id,
  displayName,
  kind,
  transport,
  lifecycleScope,
  models,
  refreshedAt,
) {
  const policy =
    id === "codex"
      ? {
          defaultPresetId: "ask-for-approval",
          detail:
            "Managed worktree access with explicit approval and network controls.",
          presets: [
            preset(
              "restricted",
              "Restricted",
              "Worktree only; network disabled.",
              "WORKSPACE_WRITE",
              "never",
              "DISABLED",
            ),
            preset(
              "ask-for-approval",
              "Ask for approval",
              "Review eligible exceptions before they run.",
              "WORKSPACE_WRITE",
              "on-request",
              "OPTIONAL",
            ),
            preset(
              "approve-for-me",
              "Approve for me",
              "Automatic review of eligible exceptions.",
              "WORKSPACE_WRITE",
              "on-request",
              "OPTIONAL",
              "auto_review",
            ),
            preset(
              "full-access",
              "Full access",
              "Unrestricted local execution.",
              "DANGER_FULL_ACCESS",
              "never",
              "REQUIRED",
            ),
          ],
        }
      : {
          defaultPresetId: "ask-for-approval",
          detail:
            "Runtime-native permissions with Task Monki approval tracking.",
          presets: [
            preset(
              "ask-for-approval",
              "Ask for approval",
              "Review commands and edits before they run.",
              "DANGER_FULL_ACCESS",
              "on-request",
              "REQUIRED",
            ),
            preset(
              "full-access",
              "Full access",
              "Allow runtime-native tools without approval.",
              "DANGER_FULL_ACCESS",
              "never",
              "REQUIRED",
            ),
          ],
        };
  const stable = { maturity: "stable" };
  const unsupported = { maturity: "unsupported" };
  const capabilities = {
    runtimeId: id,
    executionPolicy: policy,
    promptRefinement: id === "codex" ? stable : unsupported,
    modelCatalog: stable,
    reasoningEffort: stable,
    persistentSessions: stable,
    sessionResume: stable,
    sessionFork: stable,
    activeTurnSteering: id === "codex" ? stable : unsupported,
    turnInterruption: stable,
    truePause: unsupported,
    interactiveApprovals: stable,
    userInputRequests: stable,
    goals: id === "codex" ? stable : unsupported,
    plans: stable,
    detachedReview: id === "codex" ? stable : unsupported,
    review: id === "codex" ? stable : unsupported,
    subagents: unsupported,
    backgroundTerminals: stable,
    dynamicTools: stable,
    attachmentDelivery: id === "codex" ? stable : unsupported,
    runtimeRecovery: stable,
    extensions: {},
  };
  return {
    preflight: {
      runtime: {
        id,
        displayName,
        kind,
        transport,
        lifecycleScope,
        startupPolicy: id === "codex" ? "EAGER" : "ON_DEMAND",
      },
      readiness: {
        status: "READY",
        canStart: true,
        summary: "Ready",
        detail: `${displayName} is installed, authenticated, and ready.`,
        checks: {
          discovery: "FOUND",
          compatibility: "COMPATIBLE",
          initialization: "INITIALIZED",
          authentication: "AUTHENTICATED",
          modelCatalog: "AVAILABLE",
        },
        diagnostics: [],
      },
      capabilities,
      runtimeVersion: id === "codex" ? "0.141.0" : "1.4.2",
      accountLabel: "Demo workspace",
    },
    models: models.filter((candidate) => candidate.runtimeId === id),
    refreshedAt,
  };
}

function model(id, runtimeId, modelProvider, modelId, displayName, isDefault) {
  return {
    id,
    runtimeId,
    modelProvider,
    model: modelId,
    displayName,
    description: `${displayName} coding profile`,
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    serviceTiers: ["standard"],
    defaultServiceTier: "standard",
    inputModalities: ["text", "image"],
    isDefault,
  };
}

function preset(
  id,
  label,
  detail,
  sandbox,
  approvalPolicy,
  networkAccess,
  approvalsReviewer = "user",
) {
  return {
    id,
    label,
    detail,
    sandbox,
    approvalPolicy,
    approvalsReviewer,
    networkAccess,
  };
}

function board(id, name, color, repositoryIds, workflowPhases) {
  const at = "2026-07-20T09:30:00.000Z";
  return {
    id,
    name,
    color,
    repositoryIds,
    workflowPhases,
    createdAt: at,
    updatedAt: at,
  };
}

function runtimeForSlug(slug) {
  if (slug === "board-backlog" || slug === "preview-ready")
    return "cursor-agent-acp";
  if (slug === "preview-replacing") return "opencode";
  return "codex";
}

function modelForSlug(slug) {
  if (runtimeForSlug(slug) === "cursor-agent-acp") return "composer-1";
  if (runtimeForSlug(slug) === "opencode") return "claude-sonnet-4.5";
  return "gpt-5.3-codex";
}

function modelProviderForSlug(slug) {
  if (runtimeForSlug(slug) === "cursor-agent-acp") return "cursor";
  if (runtimeForSlug(slug) === "opencode") return "anthropic";
  return "openai";
}

function sanitizeSnapshotPaths(
  snapshot,
  taskIdBySlug,
  primaryRepository,
  secondaryRepository,
) {
  const taskRepository = new Map(
    snapshot.tasks.map((task) => [task.id, task.repositoryId]),
  );
  for (const worktree of snapshot.worktrees) {
    const repositoryId = taskRepository.get(worktree.taskId);
    const repository =
      repositoryId === secondaryRepository.id
        ? secondaryRepository
        : primaryRepository;
    const task = snapshot.tasks.find(
      (candidate) => candidate.id === worktree.taskId,
    );
    worktree.path = task
      ? `/Users/demo/.task-monki/worktrees/${slugify(task.title)}`
      : `/Users/demo/.task-monki/worktrees/${worktree.id.slice(0, 8)}`;
    worktree.repositoryPath = repository.path;
  }
  for (const artifact of snapshot.artifacts) {
    artifact.path = `/Users/demo/.task-monki/artifacts/${artifact.id}.log`;
  }
  for (const task of snapshot.tasks) {
    if (task.id === taskIdBySlug["preview-ready"]) {
      task.projection.summary =
        "Branch preview is healthy and ready to inspect.";
    }
  }
}

function polishReviewFinding(snapshot, taskId) {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  const review = task?.projection.agentReview;
  if (!review?.result) return;
  review.summary =
    "Review found one validation path that can emit an incomplete export.";
  review.result.summary = review.summary;
  review.result.findings = [
    {
      id: "billing-export-currency",
      severity: "MAJOR",
      title: "Invalid currency values bypass row validation",
      explanation:
        "Rows with an unknown currency code reach serialization and produce an incomplete export instead of an actionable validation error.",
      path: "src/core/billing/exportRows.ts",
      line: 118,
      endLine: 132,
      recommendation:
        "Validate currency and settlement date together before formatting the export row, then cover the rejected row in the focused test suite.",
    },
  ];
  task.projection.summary = review.summary;
}

function polishDeliveryEvidence(snapshot, taskId) {
  const pullRequestNumber = 184;
  const pullRequest = snapshot.pullRequests.find(
    (record) => record.taskId === taskId,
  );
  if (pullRequest) {
    pullRequest.title = "Polish multi-repository canvas navigation";
    pullRequest.url = `https://github.com/taskmonki/task-monki/pull/${pullRequestNumber}`;
    pullRequest.number = pullRequestNumber;
  }
  for (const record of [
    ...snapshot.ciRollups,
    ...snapshot.reviewRollups,
    ...snapshot.mergeSnapshots,
  ].filter((candidate) => candidate.taskId === taskId)) {
    record.pullRequestNumber = pullRequestNumber;
  }
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (task) {
    const gitSnapshot = snapshot.gitSnapshots.find(
      (record) => record.taskId === taskId,
    );
    task.projection.agentReview = {
      status: "PASSED",
      runId: "showcase-delivery-review",
      sourceRunId: task.currentRunId,
      reviewedGitSnapshotId: gitSnapshot?.id,
      reviewedHeadSha: gitSnapshot?.headSha,
      reviewedDirtyFingerprint: gitSnapshot?.dirtyFingerprint,
      summary: "Task Monki review passed with no findings.",
      updatedAt: task.updatedAt,
      result: {
        schemaVersion: "agent-review/v1",
        verdict: "PASSED",
        summary: "Task Monki review passed with no findings.",
        findings: [],
      },
    };
    task.projection.githubPullRequestNumber = pullRequestNumber;
    task.projection.githubPullRequestUrl = `https://github.com/taskmonki/task-monki/pull/${pullRequestNumber}`;
  }
}

function polishPreviewRecords(snapshot, taskId) {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  const worktree = snapshot.worktrees.find(
    (record) => record.taskId === taskId,
  );
  const gitSnapshot = snapshot.gitSnapshots.find(
    (record) => record.taskId === taskId,
  );
  const completedAt = "2026-07-20T09:48:00.000Z";
  const runId = "showcase-preview-implementation";
  const sessionId = "showcase-preview-session";

  if (task && worktree && gitSnapshot) {
    worktree.branchName = "task-monki/launch-dashboard-preview";
    gitSnapshot.branch = worktree.branchName;
    gitSnapshot.status = "COMMITTED_UNPUSHED";
    gitSnapshot.commitsAheadOfBase = 1;
    gitSnapshot.committedDiffFileCount = 3;
    gitSnapshot.diffStat =
      "index.html | 118 +++++++++++++++++++++++++++++++++++++++\nstyles.css | 286 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++\n.taskmonki/preview.yaml | 18 ++++\n3 files changed, 422 insertions(+)";

    task.workflowPhase = "DONE";
    task.resolution = "ACCEPTED";
    task.phaseVersion += 1;
    task.currentRunId = runId;
    task.currentAgentSessionId = sessionId;
    task.currentGitSnapshotId = gitSnapshot.id;
    task.updatedAt = completedAt;
    task.projection = {
      ...task.projection,
      requestedAction: "SUCCEEDED",
      agentRun: "COMPLETED",
      osProcess: "EXITED",
      git: "COMMITTED_UNPUSHED",
      agentReview: {
        status: "PASSED",
        runId: "showcase-preview-review",
        sourceRunId: runId,
        reviewedGitSnapshotId: gitSnapshot.id,
        reviewedHeadSha: gitSnapshot.headSha,
        reviewedDirtyFingerprint: gitSnapshot.dirtyFingerprint,
        summary: "Preview implementation passed review with no findings.",
        updatedAt: completedAt,
        result: {
          schemaVersion: "agent-review/v1",
          verdict: "PASSED",
          summary: "Preview implementation passed review with no findings.",
          findings: [],
        },
      },
      artifact: "FINAL_MESSAGE_PRESENT",
      health: "HEALTHY",
      summary: "Atlas launch operations dashboard is complete and previewable.",
      updatedAt: completedAt,
    };

    snapshot.runs.push({
      id: runId,
      runtimeId: task.runtimeId,
      taskId,
      iterationId: task.currentIterationId,
      worktreeId: task.currentWorktreeId,
      sessionId,
      serverInstanceId: "showcase-cursor-agent",
      mode: "IMPLEMENTATION",
      origin: "TASK_MONKI",
      status: "COMPLETED",
      recoveryState: "NONE",
      requestedSettings: task.agentSettings,
      startedAt: "2026-07-20T09:42:00.000Z",
      lastEventAt: completedAt,
      eventCount: 4,
      providerTurnId: "showcase-preview-turn",
      afterGitSnapshotId: gitSnapshot.id,
      finalMessage:
        "Built the Atlas launch operations dashboard and verified the preview readiness route.",
      endedAt: completedAt,
    });
    snapshot.agentSessions.push({
      id: sessionId,
      taskId,
      iterationId: task.currentIterationId,
      worktreeId: task.currentWorktreeId,
      runtimeId: task.runtimeId,
      role: "PRIMARY",
      relationshipState: "ROOT",
      worktreePath: worktree.path,
      status: "ACTIVE",
      materialized: true,
      requestedSettings: task.agentSettings,
      ownership: "TASK_MONKI",
      createdAt: "2026-07-20T09:42:00.000Z",
      updatedAt: completedAt,
      providerSessionId: "showcase-cursor-session",
      providerSessionTreeId: "showcase-preview-tree",
      lastAttachedAt: completedAt,
    });
    snapshot.agentPlanRevisions.push({
      id: "showcase-preview-plan",
      taskId,
      iterationId: task.currentIterationId,
      runId,
      sessionId,
      runtimeId: task.runtimeId,
      revision: 1,
      explanation: "Implementation and preview verification completed.",
      steps: [
        { step: "Build launch operations dashboard", status: "COMPLETED" },
        { step: "Add explicit preview recipe", status: "COMPLETED" },
        { step: "Verify readiness and route", status: "COMPLETED" },
      ],
      observedAt: completedAt,
    });
  }

  for (const plan of snapshot.previewPlans.filter(
    (record) => record.taskId === taskId,
  )) {
    plan.stableRoute = "/launch";
  }
  for (const resource of snapshot.previewResources.filter(
    (record) => record.taskId === taskId,
  )) {
    if (resource.routeName) resource.routeName = "launch";
  }
}

function extractTaskBundle(snapshot, taskId) {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Missing showcase template task ${taskId}.`);
  const records = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value) || key === "tasks") continue;
    records[key] = value
      .filter(
        (record) =>
          record && typeof record === "object" && record.taskId === taskId,
      )
      .map((record) => structuredClone(record));
  }
  return { task: structuredClone(task), records };
}

function removeHiddenTaskRecords(snapshot, visibleTaskIds) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value) || key === "tasks") continue;
    snapshot[key] = value.filter(
      (record) =>
        !record ||
        typeof record !== "object" ||
        !("taskId" in record) ||
        visibleTaskIds.has(record.taskId),
    );
  }
}

function removeTaskRecords(snapshot, taskId) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value) || key === "tasks") continue;
    snapshot[key] = value.filter(
      (record) =>
        !record || typeof record !== "object" || record.taskId !== taskId,
    );
  }
}

function replaceStrings(value, replacements) {
  if (typeof value === "string") return replacements[value] ?? value;
  if (Array.isArray(value))
    return value.map((candidate) => replaceStrings(candidate, replacements));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, candidate]) => [
      key,
      replaceStrings(candidate, replacements),
    ]),
  );
}

function requireScenario(scenarios, slug) {
  const scenario = scenarios.get(slug);
  if (!scenario) throw new Error(`Missing showcase seed scenario: ${slug}`);
  return scenario;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
