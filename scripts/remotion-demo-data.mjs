export const DEMO_REPOSITORY_PATH = "/Users/demo/TaskMonki/task-manager";
export const DEMO_WORKTREE_ROOT = "/Users/demo/.task-monki/worktrees";
export const FOCAL_TASK_TITLE =
  "Protect delivery actions during review follow-up";
export const IMPLEMENTATION_TASK_TITLE =
  "Tune evidence refresh progress states";

export const ROUGH_PROMPT = `When I request changes from Codex review, Task Monki still lets me commit or open a PR while the follow-up is running.

Please fix the workflow state and UI so delivery actions pause until follow-up is done. Add tests for the stale review case.`;

export const REFINED_PROMPT = `Implement review follow-up delivery guards in Task Monki.

Context:
- A Codex review is a detached quality gate inside the Review phase.
- Requesting review changes starts implementation work and moves the task to In Progress.
- The prior review becomes stale and must remain visible only as context.

Requirements:
1. When a review-derived follow-up run is active, pause Accept, Commit, and Create draft PR everywhere they appear.
2. Do not allow stale review findings to be treated as current actionable verdicts.
3. Keep the previous review visible as read-only context while follow-up work runs.
4. Add focused regression coverage for Review -> Request changes -> In Progress -> Review.

Verification:
- npm run typecheck
- npm test
- npm run build
- git diff --check`;

export const REFINED_TITLE = FOCAL_TASK_TITLE;

const baseTime = Date.parse("2026-06-29T09:12:00.000Z");

function at(minutes) {
  return new Date(baseTime + minutes * 60_000).toISOString();
}

function id(prefix, suffix) {
  return `${prefix}-${suffix}`;
}

function rawRef(sequence) {
  return {
    serverInstanceId: "server-codex-demo",
    sequence,
    direction: sequence % 2 === 0 ? "INBOUND" : "OUTBOUND",
    recordedAt: at(4 + sequence),
    byteOffset: sequence * 4096,
    byteLength: 920 + sequence * 17,
    sha256: `demo${String(sequence).padStart(2, "0")}c0ffee5eedfacefeedcab005e`,
  };
}

function defaultSettings(overrides = {}) {
  return {
    model: "gpt-5-codex",
    modelProvider: "openai",
    reasoningEffort: "medium",
    serviceTier: "standard",
    sandbox: "WORKSPACE_WRITE",
    networkAccess: false,
    approvalPolicy: "on-request",
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    requestedAction: "NONE",
    agentRun: "IDLE",
    osProcess: "EXITED",
    repositoryPreflight: "VALID",
    worktree: "PRESENT",
    git: "CLEAN",
    tests: "NOT_RUN",
    githubRepository: "NOT_CHECKED",
    branchPublication: "NOT_PUSHED",
    githubPullRequest: "NOT_CREATED",
    ciChecks: "NOT_APPLICABLE",
    reviews: "NOT_REQUESTED",
    codexReview: { status: "NOT_RUN" },
    merge: "NOT_MERGED",
    artifact: "NONE",
    health: "HEALTHY",
    summary: "Ready for the next step.",
    findings: [],
    updatedAt: at(0),
    ...overrides,
  };
}

const reviewFindings = [
  {
    id: "finding-finish-actions",
    severity: "BLOCKER",
    title: "Delivery actions stay enabled during follow-up implementation",
    explanation:
      "The detail header and finish panel only pause actions for the review run. A follow-up run can still be changing files while Commit and Create draft PR remain available.",
    path: "src/renderer/ui/TaskDetail.tsx",
    line: 211,
    endLine: 237,
    recommendation:
      "Treat active non-review runs as a shared review-action pause reason and apply it to every delivery action surface.",
  },
  {
    id: "finding-stale-review",
    severity: "MAJOR",
    title: "Stale review findings can be treated as current",
    explanation:
      "The request-changes path does not consistently distinguish a current NEEDS_CHANGES verdict from stale review context after implementation resumes.",
    path: "src/renderer/ui/taskView.ts",
    line: 58,
    endLine: 84,
    recommendation:
      "Allow request changes only for current review output and route stale findings to context-only display.",
  },
  {
    id: "finding-disabled-copy",
    severity: "MINOR",
    title: "Paused actions need one consistent reason",
    explanation:
      "Different panels describe the same paused state with different wording, which makes the workflow look less deterministic.",
    path: "src/renderer/ui/TaskDetail.tsx",
    line: 384,
    recommendation:
      "Use one pause reason for active implementation work and share it across review, finish, and evidence delivery controls.",
  },
];

export const reviewResult = {
  schemaVersion: "codex-review/v1",
  verdict: "NEEDS_CHANGES",
  summary:
    "Codex review found one blocker and two follow-up issues around stale review handling and delivery-action gating.",
  findings: reviewFindings,
};

const passedReviewResult = {
  schemaVersion: "codex-review/v1",
  verdict: "PASSED",
  summary:
    "The fresh review passed. Finish actions were consistently paused during follow-up and local evidence matches the reviewed diff.",
  findings: [],
};

const diffArtifactText = `## Committed diff
diff --git a/src/renderer/ui/TaskDetail.tsx b/src/renderer/ui/TaskDetail.tsx
index 8a4f41b..c2d9a75 100644
--- a/src/renderer/ui/TaskDetail.tsx
+++ b/src/renderer/ui/TaskDetail.tsx
@@ -202,12 +202,22 @@ export function TaskDetail(props: TaskDetailProps) {
   const reviewIsRunning = reviewGate.status === 'RUNNING';
   const reviewPending = reviewStartPending && !reviewIsRunning;
   const reviewPhaseVisible = isReviewPhase(task.workflowPhase) || reviewRun?.mode === 'REVIEW';
+  const activeImplementationRun = run && isActiveNonReviewRun(run) ? run : undefined;
   const reviewActionsPaused =
-    reviewIsRunning || reviewPending;
+    reviewIsRunning || reviewPending || Boolean(activeImplementationRun);
+  const reviewPauseReason = reviewIsRunning
+    ? 'review-running'
+    : reviewPending
+      ? 'review-starting'
+      : activeImplementationRun
+        ? 'implementation-running'
+        : undefined;
   const canStartCodexReview =
     Boolean(reviewSourceRun) && !reviewActionsPaused && reviewPhaseVisible;
 
@@ -372,8 +382,12 @@ function FinishPanel({
   const reviewPassed = reviewStatus === 'PASSED';
   const cleanAccept = finishEvidence.mode === 'clean';
+  const pausedText =
+    actionsPausedReason === 'implementation-running'
+      ? 'Finish actions pause while the agent is running.'
+      : 'Finish actions pause while review runs.';
 
-  return <section className="tm-panel tm-finishpanel" aria-label="Finish task">
+  return <section className="tm-panel tm-finishpanel" aria-label="Finish task">
       <div className="tm-finishpanel__actions">
-        {actionsPaused ? <span>Finish actions pause while review runs.</span> : null}
+        {actionsPaused ? <span>{pausedText}</span> : null}
 
diff --git a/src/renderer/ui/taskView.ts b/src/renderer/ui/taskView.ts
index b7ce1cc..1d86f0a 100644
--- a/src/renderer/ui/taskView.ts
+++ b/src/renderer/ui/taskView.ts
@@ -48,14 +48,19 @@ export function describeTaskState(task: Task) {
   const review = codexReviewGate(task);
   if (REVIEW_PHASES.includes(task.workflowPhase) || review.status === 'RUNNING') {
     switch (review.status) {
       case 'RUNNING':
         return { label: 'AI reviewing', tone: 'info' };
       case 'PASSED':
         return { label: 'Review passed', tone: 'success' };
       case 'NEEDS_CHANGES':
         return { label: 'Needs changes', tone: 'error' };
+      case 'STALE':
+        return { label: 'Needs re-review', tone: 'action' };
     }
   }
 }

## Unstaged diff
diff --git a/src/renderer/ui/TaskDetail.test.tsx b/src/renderer/ui/TaskDetail.test.tsx
new file mode 100644
index 0000000..f2b6e90
--- /dev/null
+++ b/src/renderer/ui/TaskDetail.test.tsx
@@ -0,0 +1,31 @@
+import { describe, expect, it } from 'vitest';
+import { getFinishEvidenceState } from './taskView';
+
+describe('review follow-up delivery guards', () => {
+  it('requires re-review after request changes start follow-up work', () => {
+    const state = getFinishEvidenceState(
+      createTask({
+        workflowPhase: 'IN_PROGRESS',
+        projection: {
+          agentRun: 'RUNNING',
+          codexReview: { status: 'STALE' },
+          git: 'DIRTY',
+          tests: 'PASSED'
+        }
+      }),
+      'STALE',
+      3
+    );
+    expect(state.mode).toBe('override');
+    expect(state.warnings.map((warning) => warning.title)).toContain(
+      'Codex review is stale.'
+    );
+  });
+});
`;

const testOutputText = `> task-monki@0.1.0 typecheck
> tsc -p tsconfig.check.json --noEmit

> task-monki@0.1.0 test
> vitest run

 RUN  v2.1.9 /Users/demo/TaskMonki/task-manager

 ✓ src/renderer/ui/taskView.test.ts (12 tests) 18ms
 ✓ src/core/projection/reducer.test.ts (31 tests) 42ms
 ✓ src/core/storage/FileTaskStore.test.ts (46 tests) 118ms

 Test Files  3 passed (3)
      Tests  89 passed (89)
   Duration  1.42s

> task-monki@0.1.0 build
> npm run build:main && npm run build:renderer

vite v5.4.21 building for production...
✓ 68 modules transformed.
✓ built in 711ms`;

export const reviewFinalText = `Codex review verdict: NEEDS_CHANGES

Summary:
The diff moves most review gating into the right area, but delivery actions remain reachable while a review-derived follow-up implementation run is active.

Findings:
1. BLOCKER src/renderer/ui/TaskDetail.tsx:211
   Delivery actions stay enabled during follow-up implementation.
2. MAJOR src/renderer/ui/taskView.ts:58
   Stale review findings can be treated as current.
3. MINOR src/renderer/ui/TaskDetail.tsx:384
   Paused actions need one consistent reason.`;

const implementationFinalText = `Implemented review follow-up delivery guards.

- Paused review and finish actions while implementation-side follow-up runs are active.
- Preserved stale review findings as context instead of current action state.
- Added regression coverage for stale review acceptance warnings.
- Verified with typecheck, unit tests, build, and diff whitespace checks.`;

const artifactTexts = {
  "artifact-review-guard-diff": diffArtifactText,
  "artifact-review-guard-tests": testOutputText,
  "artifact-review-guard-review-final": reviewFinalText,
  "artifact-review-guard-impl-final": implementationFinalText,
  "artifact-impl-prompt": REFINED_PROMPT,
  "artifact-impl-output": implementationFinalText,
  "artifact-impl-diagnostics":
    "No runtime incidents. One provider retry recovered from a stale turn id.",
};

function artifact(idValue, taskId, kind, text, runId, testRunId) {
  return {
    id: idValue,
    taskId,
    runId,
    testRunId,
    kind,
    path: `artifacts/${idValue}.txt`,
    byteCount: Buffer.byteLength(text, "utf8"),
    createdAt: at(12),
    updatedAt: at(12),
  };
}

function taskBase({
  id: taskId,
  title,
  prompt,
  phase,
  projection: taskProjection,
  createdAt,
  updatedAt,
  currentRunId,
  currentAgentSessionId,
  currentIterationId,
  currentWorktreeId,
  currentTestRunId,
}) {
  return {
    id: taskId,
    title,
    prompt,
    repositoryPath: DEMO_REPOSITORY_PATH,
    workflowPhase: phase,
    resolution: phase === "DONE" ? "COMPLETED" : "NONE",
    completionPolicy:
      phase === "DONE" ? "LOCAL_ACCEPTANCE" : "ARTIFACT_ACCEPTANCE",
    phaseVersion: 3,
    currentRunId,
    currentAgentSessionId,
    currentIterationId,
    currentWorktreeId,
    currentTestRunId,
    forkedAlternativeTaskIds: [],
    agentSettings: defaultSettings(),
    testCommand: "npm test",
    createdAt,
    updatedAt,
    projection: taskProjection,
  };
}

function iteration(taskId, suffix, branchName, status = "ACTIVE") {
  return {
    id: id("iter", suffix),
    taskId,
    actionRequestId: id("action", suffix),
    generationKey: id("generation", suffix),
    status,
    branchName,
    baseRef: "main",
    baseSha: "2c1a47fa9a8b7f63df0cc8e9b84f3c13b985d021",
    worktreeId: id("worktree", suffix),
    createdAt: at(1),
    updatedAt: at(18),
  };
}

function worktree(taskId, suffix, branchName, headSha) {
  return {
    id: id("worktree", suffix),
    taskId,
    iterationId: id("iter", suffix),
    repositoryPath: DEMO_REPOSITORY_PATH,
    worktreePath: `${DEMO_WORKTREE_ROOT}/${branchName}`,
    branchName,
    baseRef: "main",
    baseSha: "2c1a47fa9a8b7f63df0cc8e9b84f3c13b985d021",
    headSha,
    status: "PRESENT",
    createdAt: at(2),
    updatedAt: at(18),
    lastVerifiedAt: at(18),
  };
}

function gitSnapshot({
  id: snapshotId,
  taskId,
  suffix,
  headSha,
  branch,
  status,
  stagedCount,
  unstagedCount,
  untrackedCount,
  committedDiffFileCount,
  workingDiffFileCount,
  diffStat,
  dirtyFingerprint,
  diffArtifactId,
  capturedAt,
}) {
  return {
    id: snapshotId,
    taskId,
    iterationId: id("iter", suffix),
    worktreeId: id("worktree", suffix),
    worktreePath: `${DEMO_WORKTREE_ROOT}/${branch}`,
    repoRoot: DEMO_REPOSITORY_PATH,
    gitCommonDir: `${DEMO_REPOSITORY_PATH}/.git`,
    headSha,
    branch,
    baseRef: "main",
    baseSha: "2c1a47fa9a8b7f63df0cc8e9b84f3c13b985d021",
    upstreamRef: `origin/${branch}`,
    upstreamSha: headSha,
    aheadCount: status === "PUSHED" ? 0 : 1,
    behindCount: 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount: 0,
    commitsAheadOfBase: 1,
    committedDiffFileCount,
    workingDiffFileCount,
    diffStat,
    dirtyFingerprint,
    status,
    capturedAt,
    diffArtifactId,
  };
}

function run({
  id: runId,
  taskId,
  suffix,
  sessionId,
  mode,
  status,
  promptArtifactId,
  outputArtifactId,
  diagnosticArtifactId,
  beforeGitSnapshotId,
  afterGitSnapshotId,
  startedAt,
  endedAt,
  finalArtifactId,
  finalMessage,
  continuedFromRunId,
  providerTurnId,
  serverInstanceId = "server-codex-demo",
}) {
  return {
    id: runId,
    taskId,
    iterationId: id("iter", suffix),
    worktreeId: id("worktree", suffix),
    sessionId,
    serverInstanceId,
    providerTurnId,
    mode,
    origin: "TASK_MONKI",
    continuedFromRunId,
    generationKey: id("generation", suffix),
    status,
    recoveryState: "NONE",
    requestedSettings:
      mode === "REVIEW"
        ? defaultSettings({ sandbox: "READ_ONLY", reasoningEffort: "low" })
        : defaultSettings(),
    observedSettings:
      mode === "REVIEW"
        ? defaultSettings({ sandbox: "READ_ONLY", reasoningEffort: "low" })
        : defaultSettings(),
    promptArtifactId,
    outputArtifactId,
    diagnosticArtifactId,
    beforeGitSnapshotId,
    afterGitSnapshotId,
    terminalReason: status === "COMPLETED" ? "completed" : undefined,
    providerTerminalSource:
      status === "COMPLETED" ? "TURN_COMPLETED_NOTIFICATION" : undefined,
    providerTerminalRawMessage: status === "COMPLETED" ? rawRef(22) : undefined,
    startedAt,
    lastEventAt: endedAt ?? at(38),
    endedAt,
    finalArtifactId,
    eventCount: status === "RUNNING" ? 18 : 47,
    lastEventType:
      status === "RUNNING" ? "turn/diff/updated" : "turn/completed",
    finalMessage,
  };
}

function session({
  id: sessionId,
  taskId,
  suffix,
  role,
  providerSessionId,
  status,
  parentSessionId,
  forkedFromSessionId,
  parentRunId,
  createdAt,
  updatedAt,
}) {
  return {
    id: sessionId,
    taskId,
    iterationId: id("iter", suffix),
    worktreeId: id("worktree", suffix),
    provider: "codex",
    role,
    providerSessionId,
    providerSessionTreeId: `${providerSessionId}-tree`,
    parentSessionId,
    forkedFromSessionId,
    providerParentSessionId: parentSessionId,
    providerForkedFromSessionId: forkedFromSessionId,
    parentRunId,
    relationshipState: parentSessionId ? "RESOLVED" : "ROOT",
    worktreePath: `${DEMO_WORKTREE_ROOT}/codex/${suffix}`,
    status,
    materialized: true,
    requestedSettings:
      role === "REVIEW"
        ? defaultSettings({ sandbox: "READ_ONLY", reasoningEffort: "low" })
        : defaultSettings(),
    observedSettings:
      role === "REVIEW"
        ? defaultSettings({ sandbox: "READ_ONLY", reasoningEffort: "low" })
        : defaultSettings(),
    ownership: "TASK_MONKI",
    createdAt,
    updatedAt,
    lastAttachedAt: updatedAt,
  };
}

function event(
  eventId,
  taskId,
  suffix,
  type,
  source,
  occurredAt,
  payload = {},
  runId,
) {
  return {
    id: eventId,
    type,
    taskId,
    iterationId: id("iter", suffix),
    runId,
    agentSessionId: runId ? `session-${suffix}-primary` : undefined,
    serverInstanceId: "server-codex-demo",
    source,
    sourceEventId: `source-${eventId}`,
    occurredAt,
    receivedAt: occurredAt,
    payload,
  };
}

function providerItem({
  id: itemId,
  taskId,
  suffix,
  runId,
  sessionId,
  providerItemId,
  type,
  status,
  payload,
  sequence,
  createdAt,
  updatedAt,
}) {
  return {
    id: itemId,
    taskId,
    iterationId: id("iter", suffix),
    runId,
    sessionId,
    providerItemId,
    type,
    status,
    payload,
    rawMessage: rawRef(sequence),
    providerStartedAt: createdAt,
    providerCompletedAt: updatedAt,
    createdAt,
    updatedAt,
  };
}

function capability(maturity, detail) {
  return detail ? { maturity, detail } : { maturity };
}

export function createDemoProviderState() {
  return {
    preflight: {
      provider: "codex",
      ready: true,
      capabilities: {
        provider: "codex",
        modelCatalog: capability("stable"),
        reasoningEffort: capability("stable"),
        persistentSessions: capability("stable"),
        sessionResume: capability("stable"),
        sessionFork: capability("stable"),
        activeTurnSteering: capability("stable"),
        turnInterruption: capability("stable"),
        truePause: capability("unsupported", "Pause is not supported."),
        interactiveApprovals: capability("stable"),
        userInputRequests: capability("stable"),
        goals: capability("stable"),
        plans: capability("stable"),
        review: capability("experimental"),
        subagents: capability("experimental"),
        backgroundTerminals: capability("experimental"),
        dynamicTools: capability("experimental"),
      },
      runtimeVersion: "codex-app-server 0.42.0-demo",
      accountLabel: "rojhat@example.com",
      problems: [],
      warnings: [],
    },
    models: [
      {
        id: "model-gpt-5-codex",
        provider: "codex",
        model: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        description: "Default implementation model for coding turns.",
        hidden: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        serviceTiers: ["standard", "priority"],
        defaultServiceTier: "standard",
        inputModalities: ["text"],
        isDefault: true,
      },
      {
        id: "model-gpt-5-codex-review",
        provider: "codex",
        model: "gpt-5-codex-review",
        displayName: "GPT-5 Codex Review",
        description: "Lower-latency model profile for detached review gates.",
        hidden: false,
        supportedReasoningEfforts: ["low", "medium"],
        defaultReasoningEffort: "low",
        serviceTiers: ["standard"],
        defaultServiceTier: "standard",
        inputModalities: ["text"],
        isDefault: false,
      },
      {
        id: "model-gpt-5-codex-fast",
        provider: "codex",
        model: "gpt-5-codex-fast",
        displayName: "GPT-5 Codex Fast",
        description: "Fast prompt refinement profile.",
        hidden: false,
        supportedReasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        serviceTiers: ["standard"],
        defaultServiceTier: "standard",
        inputModalities: ["text"],
        isDefault: false,
      },
    ],
    refreshedAt: at(40),
  };
}

export function getDemoArtifactText(artifactId) {
  return (
    artifactTexts[artifactId] ??
    `Artifact ${artifactId} is not available in the demo.`
  );
}

export function createReadyTaskFromRequest(input, counter = 1) {
  const taskId = `task-created-${String(counter).padStart(2, "0")}`;
  const createdAt = at(41 + counter);
  return taskBase({
    id: taskId,
    title: input.title || REFINED_TITLE,
    prompt: input.prompt || REFINED_PROMPT,
    phase: "READY",
    createdAt,
    updatedAt: createdAt,
    projection: projection({
      agentRun: "IDLE",
      worktree: "NOT_CREATED",
      git: "NOT_INSPECTED",
      tests: "NOT_RUN",
      summary: "Implementation-ready task created from a refined request.",
      updatedAt: createdAt,
    }),
  });
}

export function createDemoSnapshot() {
  const focalTaskId = "task-review-guard";
  const implementationTaskId = "task-evidence-refresh";
  const followupTaskId = "task-review-followup";
  const doneTaskId = "task-accepted-delivery";

  const focalBranch = "codex/review-followup-guards";
  const implementationBranch = "codex/evidence-refresh-progress";
  const followupBranch = "codex/stale-review-followup";
  const doneBranch = "codex/repo-switcher-polish";

  const focalHead = "7fb4e2c3b17d9f3a624c5b20a0f7cc41d8e91a33";
  const implementationHead = "b43e2f51d30762ed088c343e53161a8fdd25af91";
  const doneHead = "ef1cc78bca25efb907912f3ea4960a2c9372a8df";

  const focalReviewGate = {
    status: "NEEDS_CHANGES",
    runId: "run-review-guard-review",
    sourceRunId: "run-review-guard-impl",
    reviewedGitSnapshotId: "git-review-guard-after",
    reviewedHeadSha: focalHead,
    reviewedDirtyFingerprint: "dirty-review-guard-7fb4e2",
    finalArtifactId: "artifact-review-guard-review-final",
    summary: reviewResult.summary,
    result: reviewResult,
    updatedAt: at(24),
  };

  const staleReviewGate = {
    ...focalReviewGate,
    status: "STALE",
    updatedAt: at(32),
  };

  const tasks = [
    taskBase({
      id: "task-settings-preflight",
      title: "Add settings preflight banner for missing Codex auth",
      prompt:
        "Show a compact settings warning when the provider model catalog cannot be loaded.",
      phase: "READY",
      createdAt: at(-80),
      updatedAt: at(13),
      projection: projection({
        agentRun: "IDLE",
        worktree: "NOT_CREATED",
        git: "NOT_INSPECTED",
        tests: "NOT_RUN",
        summary: "Ready to prepare an isolated worktree.",
        updatedAt: at(13),
      }),
    }),
    taskBase({
      id: "task-approval",
      title: "Confirm worktree cleanup before deleting a task",
      prompt:
        "Ask before removing Task Monki-owned worktrees when deleting a completed task.",
      phase: "IN_PROGRESS",
      currentRunId: "run-approval",
      currentAgentSessionId: "session-approval-primary",
      currentIterationId: "iter-approval",
      currentWorktreeId: "worktree-approval",
      createdAt: at(-70),
      updatedAt: at(31),
      projection: projection({
        agentRun: "AWAITING_APPROVAL",
        osProcess: "RUNNING",
        git: "DIRTY",
        tests: "NOT_RUN",
        summary: "Provider is waiting for permission to inspect the worktree.",
        updatedAt: at(31),
      }),
    }),
    taskBase({
      id: implementationTaskId,
      title: IMPLEMENTATION_TASK_TITLE,
      prompt:
        "Make evidence refresh progress easier to scan while long-running Git and test checks are active.",
      phase: "IN_PROGRESS",
      currentRunId: "run-evidence-refresh",
      currentAgentSessionId: "session-evidence-refresh-primary",
      currentIterationId: "iter-evidence-refresh",
      currentWorktreeId: "worktree-evidence-refresh",
      createdAt: at(-58),
      updatedAt: at(39),
      projection: projection({
        agentRun: "RUNNING",
        osProcess: "RUNNING",
        git: "DIRTY",
        tests: "RUNNING",
        artifact: "FINAL_MESSAGE_PRESENT",
        summary:
          "Codex is refining progress states for local evidence refresh.",
        updatedAt: at(39),
      }),
    }),
    taskBase({
      id: followupTaskId,
      title: "Apply review fixes for stale review context",
      prompt:
        "Continue from the current worktree and address stale review handling without hiding old findings.",
      phase: "IN_PROGRESS",
      currentRunId: "run-review-followup",
      currentAgentSessionId: "session-review-followup-primary",
      currentIterationId: "iter-review-followup",
      currentWorktreeId: "worktree-review-followup",
      createdAt: at(-44),
      updatedAt: at(36),
      projection: projection({
        agentRun: "RUNNING",
        osProcess: "RUNNING",
        git: "DIRTY",
        tests: "STALE",
        codexReview: staleReviewGate,
        artifact: "FINAL_MESSAGE_PRESENT",
        summary:
          "Follow-up implementation is fixing review feedback; finish actions are paused.",
        updatedAt: at(36),
      }),
    }),
    taskBase({
      id: focalTaskId,
      title: FOCAL_TASK_TITLE,
      prompt: REFINED_PROMPT,
      phase: "REVIEW",
      currentRunId: "run-review-guard-impl",
      currentAgentSessionId: "session-review-guard-primary",
      currentIterationId: "iter-review-guard",
      currentWorktreeId: "worktree-review-guard",
      currentTestRunId: "test-review-guard",
      createdAt: at(-36),
      updatedAt: at(34),
      projection: projection({
        agentRun: "COMPLETED",
        worktree: "PRESENT",
        git: "DIRTY",
        tests: "PASSED",
        githubRepository: "READY",
        branchPublication: "NOT_PUSHED",
        githubPullRequest: "NOT_CREATED",
        ciChecks: "NOT_APPLICABLE",
        reviews: "NOT_REQUESTED",
        codexReview: focalReviewGate,
        artifact: "FINAL_MESSAGE_PRESENT",
        health: "WARNING",
        summary: "Review found delivery-action and stale-review guard issues.",
        updatedAt: at(34),
      }),
    }),
    taskBase({
      id: "task-pr-delete-safeguards",
      title: "Draft PR for task deletion safeguards",
      prompt:
        "Publish the branch for task delete safety checks and keep the PR in draft until acceptance.",
      phase: "IN_REVIEW",
      currentRunId: "run-pr-delete-safeguards",
      currentAgentSessionId: "session-pr-delete-safeguards-primary",
      currentIterationId: "iter-pr-delete-safeguards",
      currentWorktreeId: "worktree-pr-delete-safeguards",
      createdAt: at(-28),
      updatedAt: at(27),
      projection: projection({
        agentRun: "COMPLETED",
        git: "PUSHED",
        tests: "PASSED",
        githubRepository: "READY",
        branchPublication: "PUSHED",
        githubPullRequest: "OPEN_DRAFT",
        ciChecks: "PASSING",
        reviews: "PENDING",
        summary: "Draft PR is open with passing checks and pending review.",
        updatedAt: at(27),
      }),
    }),
    taskBase({
      id: doneTaskId,
      title: "Accept repository switcher polish with verified evidence",
      prompt:
        "Finish the repository switcher polish after local tests, diff review, and draft PR creation.",
      phase: "DONE",
      currentRunId: "run-accepted-delivery",
      currentAgentSessionId: "session-accepted-delivery-primary",
      currentIterationId: "iter-accepted-delivery",
      currentWorktreeId: "worktree-accepted-delivery",
      currentTestRunId: "test-accepted-delivery",
      createdAt: at(-18),
      updatedAt: at(42),
      projection: projection({
        agentRun: "COMPLETED",
        git: "PUSHED",
        tests: "PASSED",
        githubRepository: "READY",
        branchPublication: "PUSHED",
        githubPullRequest: "OPEN_DRAFT",
        ciChecks: "PASSING",
        reviews: "APPROVED",
        merge: "MERGEABLE",
        codexReview: {
          status: "PASSED",
          runId: "run-accepted-review",
          sourceRunId: "run-accepted-delivery",
          reviewedHeadSha: doneHead,
          reviewedDirtyFingerprint: "clean-accepted-delivery",
          summary: passedReviewResult.summary,
          result: passedReviewResult,
          updatedAt: at(39),
        },
        artifact: "FINAL_MESSAGE_PRESENT",
        summary:
          "Accepted locally after passing tests, review, PR checks, and Git evidence.",
        updatedAt: at(42),
      }),
    }),
  ];

  const iterations = [
    iteration(focalTaskId, "review-guard", focalBranch, "COMPLETED"),
    iteration(implementationTaskId, "evidence-refresh", implementationBranch),
    iteration(followupTaskId, "review-followup", followupBranch),
    iteration(doneTaskId, "accepted-delivery", doneBranch, "COMPLETED"),
    iteration("task-approval", "approval", "codex/delete-safeguards"),
    iteration(
      "task-pr-delete-safeguards",
      "pr-delete-safeguards",
      "codex/task-delete-safety",
      "COMPLETED",
    ),
  ];

  const worktrees = [
    worktree(focalTaskId, "review-guard", focalBranch, focalHead),
    worktree(
      implementationTaskId,
      "evidence-refresh",
      implementationBranch,
      implementationHead,
    ),
    worktree(
      followupTaskId,
      "review-followup",
      followupBranch,
      "4a91db8e0142fa9f42c1bfb912a6ac8e2b513107",
    ),
    worktree(doneTaskId, "accepted-delivery", doneBranch, doneHead),
    worktree(
      "task-approval",
      "approval",
      "codex/delete-safeguards",
      "49e0a18be837df9cceccf2f68d870efe1a115009",
    ),
    worktree(
      "task-pr-delete-safeguards",
      "pr-delete-safeguards",
      "codex/task-delete-safety",
      "73a5cd20b7b32065efc20530f4d5e04c72a0814d",
    ),
  ];

  const gitSnapshots = [
    gitSnapshot({
      id: "git-review-guard-after",
      taskId: focalTaskId,
      suffix: "review-guard",
      headSha: focalHead,
      branch: focalBranch,
      status: "DIRTY",
      stagedCount: 0,
      unstagedCount: 2,
      untrackedCount: 1,
      committedDiffFileCount: 2,
      workingDiffFileCount: 1,
      diffStat:
        "src/renderer/ui/TaskDetail.tsx | 24 +++++++++++++++++---\nsrc/renderer/ui/taskView.ts | 8 ++++++--\nsrc/renderer/ui/TaskDetail.test.tsx | 31 +++++++++++++++++++++++++++++++",
      dirtyFingerprint: "dirty-review-guard-7fb4e2",
      diffArtifactId: "artifact-review-guard-diff",
      capturedAt: at(25),
    }),
    gitSnapshot({
      id: "git-evidence-refresh-after",
      taskId: implementationTaskId,
      suffix: "evidence-refresh",
      headSha: implementationHead,
      branch: implementationBranch,
      status: "DIRTY",
      stagedCount: 0,
      unstagedCount: 4,
      untrackedCount: 0,
      committedDiffFileCount: 1,
      workingDiffFileCount: 4,
      diffStat:
        "src/core/agent/codex/CodexAppServerAdapter.ts | 41 ++++++++++++++++++++++",
      dirtyFingerprint: "dirty-evidence-refresh",
      diffArtifactId: "artifact-review-guard-diff",
      capturedAt: at(38),
    }),
    gitSnapshot({
      id: "git-accepted-delivery-after",
      taskId: doneTaskId,
      suffix: "accepted-delivery",
      headSha: doneHead,
      branch: doneBranch,
      status: "PUSHED",
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      committedDiffFileCount: 3,
      workingDiffFileCount: 0,
      diffStat: "src/renderer/ui/RepositorySwitcher.tsx | 19 +++++++++++++",
      dirtyFingerprint: "clean-accepted-delivery",
      diffArtifactId: "artifact-review-guard-diff",
      capturedAt: at(41),
    }),
  ];

  const testRuns = [
    {
      id: "test-review-guard",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      worktreeId: "worktree-review-guard",
      generationKey: "generation-review-guard",
      command: "npm run typecheck && npm test && npm run build",
      executable: "npm",
      argv: ["run", "typecheck"],
      cwd: `${DEMO_WORKTREE_ROOT}/${focalBranch}`,
      status: "PASSED",
      processStatus: "EXITED",
      stdoutArtifactId: "artifact-review-guard-tests",
      stderrArtifactId: "artifact-review-guard-test-stderr",
      startedAt: at(26),
      endedAt: at(28),
      exitCode: 0,
      signal: null,
      testedHeadSha: focalHead,
      testedDirtyFingerprint: "dirty-review-guard-7fb4e2",
    },
    {
      id: "test-accepted-delivery",
      taskId: doneTaskId,
      iterationId: "iter-accepted-delivery",
      worktreeId: "worktree-accepted-delivery",
      generationKey: "generation-accepted-delivery",
      command: "npm test",
      executable: "npm",
      argv: ["test"],
      cwd: `${DEMO_WORKTREE_ROOT}/${doneBranch}`,
      status: "PASSED",
      processStatus: "EXITED",
      stdoutArtifactId: "artifact-review-guard-tests",
      stderrArtifactId: "artifact-review-guard-test-stderr",
      startedAt: at(39),
      endedAt: at(40),
      exitCode: 0,
      signal: null,
      testedHeadSha: doneHead,
      testedDirtyFingerprint: "clean-accepted-delivery",
    },
  ];

  const runs = [
    run({
      id: "run-review-guard-impl",
      taskId: focalTaskId,
      suffix: "review-guard",
      sessionId: "session-review-guard-primary",
      mode: "IMPLEMENTATION",
      status: "COMPLETED",
      promptArtifactId: "artifact-impl-prompt",
      outputArtifactId: "artifact-impl-output",
      diagnosticArtifactId: "artifact-impl-diagnostics",
      beforeGitSnapshotId: "git-review-guard-before",
      afterGitSnapshotId: "git-review-guard-after",
      startedAt: at(5),
      endedAt: at(20),
      finalArtifactId: "artifact-review-guard-impl-final",
      finalMessage: implementationFinalText,
      providerTurnId: "turn-review-guard-impl",
    }),
    run({
      id: "run-review-guard-review",
      taskId: focalTaskId,
      suffix: "review-guard",
      sessionId: "session-review-guard-review",
      mode: "REVIEW",
      status: "COMPLETED",
      promptArtifactId: "artifact-impl-prompt",
      outputArtifactId: "artifact-review-guard-review-final",
      diagnosticArtifactId: "artifact-impl-diagnostics",
      afterGitSnapshotId: "git-review-guard-after",
      startedAt: at(21),
      endedAt: at(24),
      finalArtifactId: "artifact-review-guard-review-final",
      finalMessage: reviewFinalText,
      providerTurnId: "turn-review-guard-review",
      continuedFromRunId: "run-review-guard-impl",
    }),
    run({
      id: "run-evidence-refresh",
      taskId: implementationTaskId,
      suffix: "evidence-refresh",
      sessionId: "session-evidence-refresh-primary",
      mode: "IMPLEMENTATION",
      status: "RUNNING",
      promptArtifactId: "artifact-impl-prompt",
      outputArtifactId: "artifact-impl-output",
      diagnosticArtifactId: "artifact-impl-diagnostics",
      afterGitSnapshotId: "git-evidence-refresh-after",
      startedAt: at(29),
      finalArtifactId: "artifact-review-guard-impl-final",
      finalMessage: "",
      providerTurnId: "turn-evidence-refresh",
    }),
    run({
      id: "run-review-followup",
      taskId: followupTaskId,
      suffix: "review-followup",
      sessionId: "session-review-followup-primary",
      mode: "FOLLOW_UP",
      status: "RUNNING",
      promptArtifactId: "artifact-impl-prompt",
      outputArtifactId: "artifact-impl-output",
      diagnosticArtifactId: "artifact-impl-diagnostics",
      startedAt: at(33),
      finalArtifactId: "artifact-review-guard-impl-final",
      finalMessage: "",
      providerTurnId: "turn-review-followup",
      continuedFromRunId: "run-review-guard-impl",
    }),
    run({
      id: "run-accepted-delivery",
      taskId: doneTaskId,
      suffix: "accepted-delivery",
      sessionId: "session-accepted-delivery-primary",
      mode: "IMPLEMENTATION",
      status: "COMPLETED",
      promptArtifactId: "artifact-impl-prompt",
      outputArtifactId: "artifact-impl-output",
      diagnosticArtifactId: "artifact-impl-diagnostics",
      afterGitSnapshotId: "git-accepted-delivery-after",
      startedAt: at(34),
      endedAt: at(38),
      finalArtifactId: "artifact-review-guard-impl-final",
      finalMessage: implementationFinalText,
      providerTurnId: "turn-accepted-delivery",
    }),
  ];

  const agentServers = [
    {
      id: "server-codex-demo",
      provider: "codex",
      runtimeKind: "APP_SERVER",
      transport: "STDIO",
      status: "READY",
      executable: "codex",
      argv: ["app-server", "--stdio"],
      pid: 48218,
      runtimeVersion: "codex-app-server 0.42.0-demo",
      schemaVersion: "protocol-v2",
      schemaHash: "8b7c3d4e5f6a-demo",
      protocolJournalPath: "/Users/demo/.task-monki/protocol/codex-demo.ndjson",
      startedAt: at(0),
      initializedAt: at(1),
      lastHealthAt: at(40),
    },
  ];

  const agentSessions = [
    session({
      id: "session-review-guard-primary",
      taskId: focalTaskId,
      suffix: "review-guard",
      role: "PRIMARY",
      providerSessionId: "thread-review-guard",
      status: "IDLE",
      createdAt: at(4),
      updatedAt: at(24),
    }),
    session({
      id: "session-review-guard-review",
      taskId: focalTaskId,
      suffix: "review-guard",
      role: "REVIEW",
      providerSessionId: "thread-review-guard-review",
      status: "IDLE",
      parentSessionId: "session-review-guard-primary",
      forkedFromSessionId: "session-review-guard-primary",
      parentRunId: "run-review-guard-impl",
      createdAt: at(21),
      updatedAt: at(24),
    }),
    session({
      id: "session-evidence-refresh-primary",
      taskId: implementationTaskId,
      suffix: "evidence-refresh",
      role: "PRIMARY",
      providerSessionId: "thread-evidence-refresh",
      status: "ACTIVE",
      createdAt: at(28),
      updatedAt: at(39),
    }),
    session({
      id: "session-review-followup-primary",
      taskId: followupTaskId,
      suffix: "review-followup",
      role: "PRIMARY",
      providerSessionId: "thread-review-followup",
      status: "ACTIVE",
      createdAt: at(33),
      updatedAt: at(39),
    }),
    session({
      id: "session-accepted-delivery-primary",
      taskId: doneTaskId,
      suffix: "accepted-delivery",
      role: "PRIMARY",
      providerSessionId: "thread-accepted-delivery",
      status: "IDLE",
      createdAt: at(34),
      updatedAt: at(42),
    }),
  ];

  const agentPlanRevisions = [
    {
      id: "plan-review-guard-1",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      runId: "run-review-guard-impl",
      sessionId: "session-review-guard-primary",
      provider: "codex",
      revision: 1,
      explanation: "Implementation path",
      steps: [
        {
          step: "Trace review follow-up state through reducer and selectors",
          status: "COMPLETED",
        },
        {
          step: "Pause finish and delivery actions for active implementation runs",
          status: "COMPLETED",
        },
        { step: "Add stale-review regression coverage", status: "COMPLETED" },
        {
          step: "Run typecheck, tests, build, and diff check",
          status: "COMPLETED",
        },
      ],
      rawMessage: rawRef(3),
      observedAt: at(8),
    },
    {
      id: "plan-evidence-refresh-1",
      taskId: implementationTaskId,
      iterationId: "iter-evidence-refresh",
      runId: "run-evidence-refresh",
      sessionId: "session-evidence-refresh-primary",
      provider: "codex",
      revision: 2,
      explanation: "Evidence refresh progress in motion",
      steps: [
        {
          step: "Trace evidence refresh state through selectors",
          status: "COMPLETED",
        },
        {
          step: "Tighten progress copy for Git and tests",
          status: "IN_PROGRESS",
        },
        {
          step: "Verify disabled refresh controls while checks run",
          status: "PENDING",
        },
      ],
      rawMessage: rawRef(13),
      observedAt: at(37),
    },
  ];

  const agentItems = [
    providerItem({
      id: "item-review-guard-user",
      taskId: focalTaskId,
      suffix: "review-guard",
      runId: "run-review-guard-impl",
      sessionId: "session-review-guard-primary",
      providerItemId: "provider-item-user-1",
      type: "USER_MESSAGE",
      status: "COMPLETED",
      payload: { text: REFINED_PROMPT },
      sequence: 4,
      createdAt: at(5),
      updatedAt: at(5),
    }),
    providerItem({
      id: "item-review-guard-command",
      taskId: focalTaskId,
      suffix: "review-guard",
      runId: "run-review-guard-impl",
      sessionId: "session-review-guard-primary",
      providerItemId: "provider-item-command-1",
      type: "COMMAND_EXECUTION",
      status: "COMPLETED",
      payload: {
        command: "npm test -- taskView",
        cwd: `${DEMO_WORKTREE_ROOT}/${focalBranch}`,
        exitCode: 0,
        durationMs: 1140,
        aggregatedOutput: "12 tests passed",
      },
      sequence: 5,
      createdAt: at(12),
      updatedAt: at(13),
    }),
    providerItem({
      id: "item-review-guard-file-change",
      taskId: focalTaskId,
      suffix: "review-guard",
      runId: "run-review-guard-impl",
      sessionId: "session-review-guard-primary",
      providerItemId: "provider-item-file-1",
      type: "FILE_CHANGE",
      status: "COMPLETED",
      payload: {
        changes: [
          { path: "src/renderer/ui/TaskDetail.tsx", kind: "modified" },
          { path: "src/renderer/ui/taskView.ts", kind: "modified" },
          { path: "src/renderer/ui/TaskDetail.test.tsx", kind: "created" },
        ],
      },
      sequence: 6,
      createdAt: at(14),
      updatedAt: at(17),
    }),
    providerItem({
      id: "item-review-guard-review",
      taskId: focalTaskId,
      suffix: "review-guard",
      runId: "run-review-guard-review",
      sessionId: "session-review-guard-review",
      providerItemId: "provider-item-review-1",
      type: "REVIEW",
      status: "COMPLETED",
      payload: reviewResult,
      sequence: 8,
      createdAt: at(22),
      updatedAt: at(24),
    }),
    providerItem({
      id: "item-evidence-refresh-reasoning",
      taskId: implementationTaskId,
      suffix: "evidence-refresh",
      runId: "run-evidence-refresh",
      sessionId: "session-evidence-refresh-primary",
      providerItemId: "provider-item-reasoning-1",
      type: "REASONING_SUMMARY",
      status: "IN_PROGRESS",
      payload: {
        summary: [
          "Checking how refresh progress is presented while Git and test checks run.",
          "Aligning local evidence status copy with the active task controls.",
        ],
      },
      sequence: 14,
      createdAt: at(34),
      updatedAt: at(39),
    }),
  ];

  const agentGoalSnapshots = [
    {
      id: "goal-review-guard",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      sessionId: "session-review-guard-primary",
      provider: "codex",
      taskGoalHash: "goalhash-review-guard",
      lastSynchronizedTaskGoalHash: "goalhash-review-guard",
      providerObjective: REFINED_PROMPT,
      providerStatus: "complete",
      tokensUsed: 84231,
      timeUsedSeconds: 912,
      syncState: "IN_SYNC",
      source: "PROVIDER_NOTIFICATION",
      rawMessage: rawRef(16),
      providerCreatedAt: at(5),
      providerUpdatedAt: at(20),
      observedAt: at(20),
    },
  ];

  const agentUsageSnapshots = [
    {
      id: "usage-review-guard",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      sessionId: "session-review-guard-primary",
      runId: "run-review-guard-impl",
      provider: "codex",
      total: {
        totalTokens: 84231,
        inputTokens: 51240,
        cachedInputTokens: 18840,
        outputTokens: 19643,
        reasoningOutputTokens: 13348,
      },
      last: {
        totalTokens: 12044,
        inputTokens: 7310,
        cachedInputTokens: 2100,
        outputTokens: 3020,
        reasoningOutputTokens: 1714,
      },
      modelContextWindow: 200000,
      rawMessage: rawRef(17),
      observedAt: at(20),
    },
  ];

  const agentSettingsObservations = [
    {
      id: "settings-review-guard",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      sessionId: "session-review-guard-primary",
      runId: "run-review-guard-impl",
      provider: "codex",
      source: "THREAD_SETTINGS_NOTIFICATION",
      settings: defaultSettings(),
      detail: "Observed settings matched Task Monki defaults.",
      rawMessage: rawRef(18),
      observedAt: at(6),
    },
  ];

  const agentSubagentObservations = [
    {
      id: "subagent-review-guard-static-analysis",
      taskId: focalTaskId,
      iterationId: "iter-review-guard",
      sessionId: "session-review-guard-primary",
      parentSessionId: "session-review-guard-primary",
      parentRunId: "run-review-guard-impl",
      providerChildSessionId: "thread-review-guard-static-analysis",
      providerParentSessionId: "thread-review-guard",
      source: "SUBAGENT_ACTIVITY",
      relationshipState: "RESOLVED",
      status: "COMPLETED",
      delegatedPrompt:
        "Inspect renderer delivery actions for stale review behavior.",
      providerNickname: "renderer-static-analysis",
      providerRole: "analysis",
      agentPath: "src/renderer/ui",
      detail: "Validated TaskDetail and taskView changes.",
      rawMessage: rawRef(19),
      observedAt: at(18),
    },
  ];

  const interactionRequests = [
    {
      id: "interaction-approval",
      serverInstanceId: "server-codex-demo",
      providerRequestId: "approval-delete-safeguards",
      taskId: "task-approval",
      iterationId: "iter-approval",
      runId: "run-approval",
      sessionId: "session-approval-primary",
      providerTurnId: "turn-approval",
      type: "COMMAND_APPROVAL",
      status: "PENDING",
      request: {
        startedAtMs: Date.parse(at(30)),
        approvalId: "approval-delete-safeguards",
        reason:
          "Need to inspect untracked worktree files before offering removal.",
        command: "git status --short",
        cwd: `${DEMO_WORKTREE_ROOT}/codex/delete-safeguards`,
      },
      allowedActions: ["ACCEPT", "DECLINE", "CANCEL"],
      policyWarnings: [],
      requestRawMessage: rawRef(20),
      requestedAt: at(30),
    },
  ];

  const events = [
    event(
      "event-created",
      focalTaskId,
      "review-guard",
      "TASK_CREATED",
      "ui",
      at(4),
      {
        title: FOCAL_TASK_TITLE,
      },
    ),
    event(
      "event-worktree",
      focalTaskId,
      "review-guard",
      "WORKTREE_CREATED",
      "repository",
      at(5),
      {
        branchName: focalBranch,
      },
    ),
    event(
      "event-run-started",
      focalTaskId,
      "review-guard",
      "AGENT_RUN_STARTED",
      "provider",
      at(6),
      {
        mode: "IMPLEMENTATION",
        requestedSettings: defaultSettings(),
      },
      "run-review-guard-impl",
    ),
    event(
      "event-plan",
      focalTaskId,
      "review-guard",
      "AGENT_PLAN_REVISED",
      "provider",
      at(8),
      {
        revision: 1,
      },
      "run-review-guard-impl",
    ),
    event(
      "event-git",
      focalTaskId,
      "review-guard",
      "GIT_SNAPSHOT_CAPTURED",
      "git",
      at(25),
      {
        status: "DIRTY",
        diffArtifactId: "artifact-review-guard-diff",
      },
    ),
    event(
      "event-test",
      focalTaskId,
      "review-guard",
      "TEST_RUN_COMPLETED",
      "test",
      at(28),
      {
        status: "PASSED",
        exitCode: 0,
      },
    ),
    event(
      "event-review-started",
      focalTaskId,
      "review-guard",
      "AGENT_RUN_STARTED",
      "provider",
      at(21),
      {
        mode: "REVIEW",
      },
      "run-review-guard-review",
    ),
    event(
      "event-review-completed",
      focalTaskId,
      "review-guard",
      "AGENT_RUN_COMPLETED",
      "provider",
      at(24),
      {
        mode: "REVIEW",
        codexReviewResult: reviewResult,
      },
      "run-review-guard-review",
    ),
  ];

  const artifacts = [
    artifact(
      "artifact-review-guard-diff",
      focalTaskId,
      "diff",
      diffArtifactText,
    ),
    artifact(
      "artifact-review-guard-tests",
      focalTaskId,
      "test-stdout",
      testOutputText,
      undefined,
      "test-review-guard",
    ),
    artifact(
      "artifact-review-guard-test-stderr",
      focalTaskId,
      "test-stderr",
      "",
    ),
    artifact(
      "artifact-review-guard-review-final",
      focalTaskId,
      "agent-final",
      reviewFinalText,
      "run-review-guard-review",
    ),
    artifact(
      "artifact-review-guard-impl-final",
      focalTaskId,
      "agent-final",
      implementationFinalText,
      "run-review-guard-impl",
    ),
    artifact(
      "artifact-impl-prompt",
      focalTaskId,
      "agent-prompt",
      REFINED_PROMPT,
      "run-review-guard-impl",
    ),
    artifact(
      "artifact-impl-output",
      focalTaskId,
      "agent-output",
      implementationFinalText,
      "run-review-guard-impl",
    ),
    artifact(
      "artifact-impl-diagnostics",
      focalTaskId,
      "agent-diagnostics",
      artifactTexts["artifact-impl-diagnostics"],
      "run-review-guard-impl",
    ),
  ];

  return {
    schemaVersion: 8,
    tasks,
    iterations,
    worktrees,
    gitSnapshots,
    testRuns,
    githubRepositories: [
      {
        id: "gh-review-guard",
        taskId: focalTaskId,
        iterationId: "iter-review-guard",
        worktreeId: "worktree-review-guard",
        remoteName: "origin",
        remoteUrl: "git@github.com:taskmonki/task-manager.git",
        host: "github.com",
        owner: "taskmonki",
        repo: "task-manager",
        ghVersion: "2.74.0",
        authStatus: "AUTHENTICATED",
        status: "READY",
        checkedAt: at(25),
      },
    ],
    branchPublications: [
      {
        id: "branch-accepted-delivery",
        taskId: doneTaskId,
        iterationId: "iter-accepted-delivery",
        worktreeId: "worktree-accepted-delivery",
        remoteName: "origin",
        branchName: doneBranch,
        remoteRef: `refs/heads/${doneBranch}`,
        headSha: doneHead,
        status: "PUSHED",
        requestedAt: at(40),
        updatedAt: at(40),
      },
    ],
    pullRequests: [
      {
        id: "pr-accepted-delivery",
        taskId: doneTaskId,
        iterationId: "iter-accepted-delivery",
        worktreeId: "worktree-accepted-delivery",
        number: 42,
        url: "https://github.com/taskmonki/task-manager/pull/42",
        status: "OPEN_DRAFT",
        state: "OPEN",
        isDraft: true,
        headRefName: doneBranch,
        headRefOid: doneHead,
        baseRefName: "main",
        title: "Polish repository switcher evidence flow",
        observedAt: at(41),
      },
    ],
    ciRollups: [
      {
        id: "ci-accepted-delivery",
        taskId: doneTaskId,
        iterationId: "iter-accepted-delivery",
        worktreeId: "worktree-accepted-delivery",
        pullRequestNumber: 42,
        headSha: doneHead,
        status: "PASSING",
        requiredStatus: "PASSING",
        totalCount: 6,
        pendingCount: 0,
        passingCount: 6,
        failingCount: 0,
        skippedCount: 0,
        observedAt: at(41),
      },
    ],
    reviewRollups: [
      {
        id: "review-rollup-accepted-delivery",
        taskId: doneTaskId,
        iterationId: "iter-accepted-delivery",
        worktreeId: "worktree-accepted-delivery",
        pullRequestNumber: 42,
        headSha: doneHead,
        status: "APPROVED",
        reviewDecision: "APPROVED",
        observedAt: at(41),
      },
    ],
    mergeSnapshots: [
      {
        id: "merge-accepted-delivery",
        taskId: doneTaskId,
        iterationId: "iter-accepted-delivery",
        worktreeId: "worktree-accepted-delivery",
        pullRequestNumber: 42,
        headSha: doneHead,
        status: "MERGEABLE",
        mergedAt: null,
        observedAt: at(41),
      },
    ],
    runs,
    agentServers,
    agentSessions,
    agentItems,
    agentGoalSnapshots,
    agentPlanRevisions,
    agentUsageSnapshots,
    agentSettingsObservations,
    agentSubagentObservations,
    interactionRequests,
    events,
    artifacts,
  };
}
