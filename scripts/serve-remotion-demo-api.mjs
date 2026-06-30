import http from "node:http";
import {
  DEMO_REPOSITORY_PATH,
  REFINED_PROMPT,
  REFINED_TITLE,
  createDemoProviderState,
  createDemoSnapshot,
  createReadyTaskFromRequest,
  getDemoArtifactText,
  reviewFinalText,
  reviewResult,
} from "./remotion-demo-data.mjs";

export const DEFAULT_DEMO_API_PORT = 43099;

const defaultAppSettings = {
  codexExternalTools: {
    webSearchMode: "disabled",
    mcpServers: "disabled",
    apps: "disabled",
  },
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

export async function startDemoApiServer({
  port = DEFAULT_DEMO_API_PORT,
} = {}) {
  const snapshot = createDemoSnapshot();
  const providerState = createDemoProviderState();
  const appSettings = structuredClone(defaultAppSettings);
  const eventClients = new Set();
  let createdTaskCounter = 0;

  const server = http.createServer((request, response) => {
    void route({
      request,
      response,
      snapshot,
      providerState,
      appSettings,
      eventClients,
      incrementCreatedTaskCounter: () => {
        createdTaskCounter += 1;
        return createdTaskCounter;
      },
    }).catch((error) => {
      sendJson(response, 500, {
        error:
          error instanceof Error ? error.message : "Unknown demo API error.",
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const client of eventClients) {
        client.end();
      }
      eventClients.clear();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function route({
  request,
  response,
  snapshot,
  providerState,
  appSettings,
  eventClients,
  incrementCreatedTaskCounter,
}) {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "127.0.0.1"}`,
  );

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    response.write("\n");
    eventClients.add(response);
    request.on("close", () => {
      eventClients.delete(response);
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/defaultRepositoryPath"
  ) {
    sendJson(response, 200, DEMO_REPOSITORY_PATH);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/provider") {
    sendJson(response, 200, providerState);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, appSettings);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const body = await readJson(request);

  if (url.pathname === "/api/settings") {
    appSettings.codexExternalTools = {
      ...appSettings.codexExternalTools,
      ...(body.codexExternalTools ?? {}),
    };
    broadcastUpdate(eventClients, {
      type: "provider.updated",
      taskId: "settings",
      payload: { source: "remotion-demo-settings" },
    });
    sendJson(response, 200, appSettings);
    return;
  }

  if (url.pathname === "/api/demo/reset") {
    resetSnapshot(snapshot);
    broadcastUpdate(eventClients, {
      type: "task.updated",
      taskId: "task-review-guard",
      payload: { source: "remotion-demo-reset" },
    });
    sendJson(response, 200, snapshot);
    return;
  }

  if (url.pathname === "/api/demo/review-state") {
    const state = typeof body.state === "string" ? body.state : "complete";
    const createdTask = findCreatedTask(snapshot, body.taskId);
    if (createdTask) {
      setCreatedTaskReviewState(snapshot, createdTask, state);
      broadcastUpdate(eventClients, {
        type: "projection.updated",
        taskId: createdTask.id,
        runId: createdTaskRecords(createdTask).reviewRunId,
        payload: { state, source: "remotion-demo-created-review-state" },
      });
    } else {
      setReviewState(snapshot, state);
      broadcastUpdate(eventClients, {
        type: "projection.updated",
        taskId: "task-review-guard",
        runId: "run-review-guard-review",
        payload: { state, source: "remotion-demo-review-state" },
      });
    }
    sendJson(response, 200, snapshot);
    return;
  }

  if (url.pathname === "/api/demo/created-task-state") {
    const task = findCreatedTask(snapshot, body.taskId);
    if (!task) {
      sendJson(response, 404, { error: "Created task not found." });
      return;
    }
    const state = typeof body.state === "string" ? body.state : "completed";
    if (state === "completed") {
      setCreatedTaskCompleted(snapshot, task);
    }
    broadcastUpdate(eventClients, {
      type: "projection.updated",
      taskId: task.id,
      runId: task.currentRunId,
      payload: { state, source: "remotion-demo-created-task-state" },
    });
    sendJson(response, 200, snapshot);
    return;
  }

  if (url.pathname === "/api/repository/validate") {
    sendJson(response, 200, {
      path: body.path ?? DEMO_REPOSITORY_PATH,
      status: "VALID",
      root: body.path ?? DEMO_REPOSITORY_PATH,
      headSha: "2c1a47fa9a8b7f63df0cc8e9b84f3c13b985d021",
      branch: "main",
      remotes: [
        {
          name: "origin",
          url: "git@github.com:taskmonki/task-manager.git",
          direction: "fetch",
        },
      ],
      checkedAt: new Date("2026-06-29T09:55:00.000Z").toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/repository/chooseFolder") {
    sendJson(response, 200, DEMO_REPOSITORY_PATH);
    return;
  }

  if (url.pathname === "/api/prompt/refine") {
    await delay(900);
    sendJson(response, 200, {
      titleSuggestion: REFINED_TITLE,
      prompt: REFINED_PROMPT,
      notes: [
        "Kept the workflow invariant explicit.",
        "Added concrete acceptance checks and verification commands.",
      ],
    });
    return;
  }

  if (url.pathname === "/api/tasks") {
    const task = createReadyTaskFromRequest(
      body,
      incrementCreatedTaskCounter(),
    );
    snapshot.tasks.unshift(task);
    sendJson(response, 200, task);
    return;
  }

  if (url.pathname === "/api/worktrees/prepare") {
    const task = findCreatedTask(snapshot, body.taskId);
    if (!task) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    const worktree = setCreatedTaskPrepared(snapshot, task);
    broadcastUpdate(eventClients, {
      type: "worktree.created",
      taskId: task.id,
      iterationId: task.currentIterationId,
      payload: { source: "remotion-demo-prepare-worktree" },
    });
    sendJson(response, 200, worktree);
    return;
  }

  if (url.pathname === "/api/runs/start") {
    const task = findCreatedTask(snapshot, body.taskId);
    if (!task) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    const run = setCreatedTaskRunning(snapshot, task);
    broadcastUpdate(eventClients, {
      type: "run.started",
      taskId: task.id,
      runId: run.id,
      iterationId: task.currentIterationId,
      payload: { source: "remotion-demo-start-run" },
    });
    sendJson(response, 200, run);
    return;
  }

  if (url.pathname === "/api/artifact/read") {
    sendJson(response, 200, getDemoArtifactText(body.artifactId));
    return;
  }

  if (url.pathname === "/api/agent/protocol/read") {
    sendJson(response, 200, {
      message:
        '{"id":"demo","method":"turn/diff/updated","params":{"byteCount":42816}}',
    });
    return;
  }

  if (url.pathname === "/api/runs/continue") {
    const createdTask = findCreatedTask(snapshot, body.taskId);
    if (createdTask) {
      const run = setCreatedTaskFollowupRunning(
        snapshot,
        createdTask,
        typeof body.instruction === "string" ? body.instruction : "",
      );
      broadcastUpdate(eventClients, {
        type: "run.started",
        taskId: createdTask.id,
        runId: run.id,
        iterationId: createdTask.currentIterationId,
        payload: { source: "remotion-demo-followup-start" },
      });
      sendJson(response, 200, run);
      return;
    }

    const run = snapshot.runs.find(
      (candidate) => candidate.id === "run-review-followup",
    );
    sendJson(response, 200, run ?? {});
    return;
  }

  if (url.pathname === "/api/runs/review") {
    const createdTask = findCreatedTask(snapshot, body.taskId);
    let taskId = "task-review-guard";
    let runId = "run-review-guard-review";
    if (createdTask) {
      const run = setCreatedTaskReviewState(snapshot, createdTask, "running");
      taskId = createdTask.id;
      runId = run.id;
    } else {
      setReviewState(snapshot, "running");
    }
    broadcastUpdate(eventClients, {
      type: "run.started",
      taskId,
      runId,
      payload: { source: "remotion-demo-review-start" },
    });
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    sendJson(response, 200, run ?? {});
    return;
  }

  if (url.pathname === "/api/tests/run") {
    sendJson(response, 200, snapshot.testRuns[0] ?? {});
    return;
  }

  if (url.pathname === "/api/evidence/refresh") {
    sendJson(response, 200, snapshot.gitSnapshots[0] ?? {});
    return;
  }

  if (url.pathname === "/api/github/preflight") {
    sendJson(response, 200, snapshot.githubRepositories[0] ?? {});
    return;
  }

  if (url.pathname === "/api/github/publish") {
    sendJson(response, 200, snapshot.branchPublications[0] ?? {});
    return;
  }

  if (
    url.pathname === "/api/github/pr/create" ||
    url.pathname === "/api/github/refresh"
  ) {
    sendJson(response, 200, snapshot.pullRequests[0] ?? {});
    return;
  }

  if (url.pathname === "/api/tasks/transition") {
    const task = snapshot.tasks.find(
      (candidate) => candidate.id === body.taskId,
    );
    if (task && body.toPhase) {
      task.workflowPhase = body.toPhase;
      task.updatedAt = new Date("2026-06-29T09:56:00.000Z").toISOString();
      task.projection = {
        ...task.projection,
        updatedAt: task.updatedAt,
        summary: `Task moved to ${body.toPhase}.`,
      };
    }
    sendJson(response, 200, task ?? {});
    return;
  }

  if (url.pathname === "/api/tasks/delete") {
    sendJson(response, 200, {
      deletedTaskId: body.taskId,
      removedWorktree: false,
    });
    return;
  }

  sendJson(response, 200, {});
}

function resetSnapshot(snapshot) {
  const fresh = createDemoSnapshot();
  for (const key of Object.keys(snapshot)) {
    delete snapshot[key];
  }
  Object.assign(snapshot, fresh);
}

function findCreatedTask(snapshot, taskId) {
  if (taskId) {
    return snapshot.tasks.find(
      (candidate) =>
        candidate.id === taskId && candidate.id.startsWith("task-created-"),
    );
  }
  return snapshot.tasks.find((candidate) =>
    candidate.id.startsWith("task-created-"),
  );
}

function setCreatedTaskPrepared(snapshot, task) {
  const records = createdTaskRecords(task);
  if (
    !snapshot.iterations.some(
      (candidate) => candidate.id === records.iteration.id,
    )
  ) {
    snapshot.iterations.push(records.iteration);
  }
  if (
    !snapshot.worktrees.some(
      (candidate) => candidate.id === records.worktree.id,
    )
  ) {
    snapshot.worktrees.push(records.worktree);
  }
  if (
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-worktree`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-worktree`,
      type: "WORKTREE_CREATED",
      taskId: task.id,
      iterationId: records.iteration.id,
      source: "repository",
      sourceEventId: `source-${task.id}-worktree`,
      occurredAt: records.now,
      receivedAt: records.now,
      payload: { branchName: records.branchName },
    });
  }

  task.currentIterationId = records.iteration.id;
  task.currentWorktreeId = records.worktree.id;
  task.updatedAt = records.now;
  task.projection = {
    ...task.projection,
    worktree: "PRESENT",
    git: "CLEAN",
    tests: "NOT_RUN",
    health: "HEALTHY",
    summary:
      "Isolated worktree is ready. Start implementation to hand the task to Codex.",
    updatedAt: records.now,
  };

  return records.worktree;
}

function setCreatedTaskRunning(snapshot, task) {
  setCreatedTaskPrepared(snapshot, task);
  const records = createdTaskRecords(task);

  const run = upsertById(snapshot.runs, {
    id: records.runId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    sessionId: records.sessionId,
    serverInstanceId: "server-codex-demo",
    providerTurnId: records.providerTurnId,
    mode: "IMPLEMENTATION",
    origin: "TASK_MONKI",
    status: "RUNNING",
    recoveryState: "NONE",
    generationKey: records.iteration.generationKey,
    requestedSettings: task.agentSettings,
    observedSettings: task.agentSettings,
    promptArtifactId: records.promptArtifactId,
    outputArtifactId: undefined,
    diagnosticArtifactId: undefined,
    beforeGitSnapshotId: undefined,
    afterGitSnapshotId: undefined,
    terminalReason: undefined,
    providerTerminalSource: undefined,
    providerTerminalRawMessage: undefined,
    startedAt: records.now,
    lastEventAt: records.now,
    endedAt: undefined,
    finalArtifactId: undefined,
    eventCount: 12,
    lastEventType: "turn/diff/updated",
    finalMessage: "",
  });

  upsertById(snapshot.agentSessions, {
    id: records.sessionId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    provider: "codex",
    role: "PRIMARY",
    providerSessionId: records.providerSessionId,
    providerSessionTreeId: `${records.providerSessionId}-tree`,
    parentSessionId: undefined,
    forkedFromSessionId: undefined,
    providerParentSessionId: undefined,
    providerForkedFromSessionId: undefined,
    parentRunId: undefined,
    relationshipState: "ROOT",
    worktreePath: records.worktree.worktreePath,
    status: "ACTIVE",
    materialized: true,
    requestedSettings: task.agentSettings,
    observedSettings: task.agentSettings,
    ownership: "TASK_MONKI",
    createdAt: records.now,
    updatedAt: records.now,
    lastAttachedAt: records.now,
  });

  upsertById(snapshot.agentPlanRevisions, {
    id: `plan-${task.id}-1`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: records.runId,
    sessionId: records.sessionId,
    provider: "codex",
    revision: 1,
    explanation: "Implementation in progress",
    steps: [
      {
        step: "Trace delivery-action state while review follow-up runs",
        status: "COMPLETED",
      },
      {
        step: "Share the active-run pause reason across review and finish panels",
        status: "IN_PROGRESS",
      },
      { step: "Add stale-review regression coverage", status: "PENDING" },
      {
        step: "Run typecheck, tests, build, and diff check",
        status: "PENDING",
      },
    ],
    observedAt: records.now,
  });

  upsertById(snapshot.agentItems, {
    id: `item-${task.id}-reasoning`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: records.runId,
    sessionId: records.sessionId,
    providerItemId: `provider-item-${task.id}-reasoning`,
    type: "REASONING_SUMMARY",
    status: "IN_PROGRESS",
    payload: {
      summary: [
        "Following the review lifecycle rules before changing delivery actions.",
        "Checking both header and finish-panel controls for active implementation guards.",
      ],
    },
    providerStartedAt: records.now,
    providerCompletedAt: undefined,
    createdAt: records.now,
    updatedAt: records.now,
  });

  if (
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-run-started`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-run-started`,
      type: "AGENT_RUN_STARTED",
      taskId: task.id,
      iterationId: records.iteration.id,
      runId: records.runId,
      agentSessionId: records.sessionId,
      serverInstanceId: "server-codex-demo",
      source: "provider",
      sourceEventId: `source-${task.id}-run-started`,
      occurredAt: records.now,
      receivedAt: records.now,
      payload: {
        mode: "IMPLEMENTATION",
        requestedSettings: task.agentSettings,
      },
    });
  }

  task.workflowPhase = "IN_PROGRESS";
  task.currentRunId = records.runId;
  task.currentAgentSessionId = records.sessionId;
  task.updatedAt = records.now;
  task.projection = {
    ...task.projection,
    agentRun: "RUNNING",
    osProcess: "RUNNING",
    worktree: "PRESENT",
    git: "DIRTY",
    tests: "NOT_RUN",
    artifact: "NONE",
    health: "HEALTHY",
    summary: "Codex is implementing the refined task in the isolated worktree.",
    updatedAt: records.now,
  };

  return run;
}

function setCreatedTaskCompleted(snapshot, task) {
  const run = setCreatedTaskRunning(snapshot, task);
  const records = createdTaskRecords(task);
  const completedAt = "2026-06-29T10:03:00.000Z";

  run.status = "COMPLETED";
  run.endedAt = completedAt;
  run.lastEventAt = completedAt;
  run.terminalReason = "completed";
  run.providerTerminalSource = "TURN_COMPLETED_NOTIFICATION";
  run.eventCount = 39;
  run.lastEventType = "turn/completed";
  run.finalArtifactId = records.finalArtifactId;
  run.outputArtifactId = records.outputArtifactId;
  run.finalMessage =
    "Implemented the review follow-up guards and added regression coverage. Local checks are ready to review.";

  const session = snapshot.agentSessions.find(
    (candidate) => candidate.id === records.sessionId,
  );
  if (session) {
    session.status = "IDLE";
    session.updatedAt = completedAt;
    session.lastAttachedAt = completedAt;
  }

  const plan = snapshot.agentPlanRevisions.find(
    (candidate) => candidate.id === `plan-${task.id}-1`,
  );
  if (plan) {
    plan.explanation = "Implementation complete";
    plan.steps = plan.steps.map((step) => ({ ...step, status: "COMPLETED" }));
    plan.observedAt = completedAt;
  }

  const reasoningItem = snapshot.agentItems.find(
    (candidate) => candidate.id === `item-${task.id}-reasoning`,
  );
  if (reasoningItem) {
    reasoningItem.status = "COMPLETED";
    reasoningItem.providerCompletedAt = completedAt;
    reasoningItem.updatedAt = completedAt;
  }

  upsertById(snapshot.agentItems, {
    id: `item-${task.id}-file-change`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: records.runId,
    sessionId: records.sessionId,
    providerItemId: `provider-item-${task.id}-file-change`,
    type: "FILE_CHANGE",
    status: "COMPLETED",
    payload: {
      changes: [
        { path: "src/renderer/ui/TaskDetail.tsx", kind: "modified" },
        { path: "src/renderer/ui/taskView.ts", kind: "modified" },
        { path: "src/renderer/ui/TaskDetail.test.tsx", kind: "created" },
      ],
    },
    providerStartedAt: records.now,
    providerCompletedAt: completedAt,
    createdAt: records.now,
    updatedAt: completedAt,
  });

  upsertById(snapshot.gitSnapshots, {
    id: records.gitSnapshotId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    worktreePath: records.worktree.worktreePath,
    repoRoot: DEMO_REPOSITORY_PATH,
    gitCommonDir: `${DEMO_REPOSITORY_PATH}/.git`,
    headSha: records.headSha,
    branch: records.branchName,
    baseRef: "main",
    baseSha: records.baseSha,
    upstreamRef: `origin/${records.branchName}`,
    upstreamSha: records.headSha,
    aheadCount: 1,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 2,
    untrackedCount: 1,
    conflictedCount: 0,
    commitsAheadOfBase: 1,
    committedDiffFileCount: 2,
    workingDiffFileCount: 1,
    diffStat:
      "src/renderer/ui/TaskDetail.tsx | 24 +++++++++++++++++---\nsrc/renderer/ui/taskView.ts | 8 ++++++--\nsrc/renderer/ui/TaskDetail.test.tsx | 31 +++++++++++++++++++++++++++++++",
    dirtyFingerprint: "dirty-created-review-flow",
    status: "DIRTY",
    capturedAt: completedAt,
    diffArtifactId: "artifact-review-guard-diff",
  });

  upsertById(snapshot.testRuns, {
    id: records.testRunId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    generationKey: records.iteration.generationKey,
    command: "npm run typecheck && npm test && npm run build",
    executable: "npm",
    argv: ["run", "typecheck"],
    cwd: records.worktree.worktreePath,
    status: "PASSED",
    processStatus: "EXITED",
    stdoutArtifactId: "artifact-review-guard-tests",
    stderrArtifactId: "artifact-review-guard-test-stderr",
    startedAt: "2026-06-29T10:01:00.000Z",
    endedAt: completedAt,
    exitCode: 0,
    signal: null,
    testedHeadSha: records.headSha,
    testedDirtyFingerprint: "dirty-created-review-flow",
  });

  upsertById(snapshot.artifacts, {
    id: records.finalArtifactId,
    taskId: task.id,
    runId: records.runId,
    kind: "agent-final",
    path: `artifacts/${records.finalArtifactId}.txt`,
    byteCount: run.finalMessage.length,
    createdAt: completedAt,
    updatedAt: completedAt,
  });

  if (
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-run-completed`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-run-completed`,
      type: "AGENT_RUN_COMPLETED",
      taskId: task.id,
      iterationId: records.iteration.id,
      runId: records.runId,
      agentSessionId: records.sessionId,
      serverInstanceId: "server-codex-demo",
      source: "provider",
      sourceEventId: `source-${task.id}-run-completed`,
      occurredAt: completedAt,
      receivedAt: completedAt,
      payload: { mode: "IMPLEMENTATION" },
    });
  }

  task.workflowPhase = "REVIEW";
  task.currentTestRunId = records.testRunId;
  task.updatedAt = completedAt;
  task.projection = {
    ...task.projection,
    agentRun: "COMPLETED",
    osProcess: "EXITED",
    worktree: "PRESENT",
    git: "DIRTY",
    tests: "PASSED",
    codexReview: { status: "NOT_RUN" },
    artifact: "FINAL_MESSAGE_PRESENT",
    health: "HEALTHY",
    summary:
      "Implementation finished. Local evidence is ready for Codex review.",
    updatedAt: completedAt,
  };
}

function setCreatedTaskReviewState(snapshot, task, state) {
  setCreatedTaskCompleted(snapshot, task);
  const records = createdTaskRecords(task);
  const startedAt = "2026-06-29T10:04:00.000Z";
  const completedAt = "2026-06-29T10:06:00.000Z";
  const running = state === "running";

  const reviewRun = upsertById(snapshot.runs, {
    id: records.reviewRunId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    sessionId: records.reviewSessionId,
    serverInstanceId: "server-codex-demo",
    providerTurnId: records.reviewProviderTurnId,
    mode: "REVIEW",
    origin: "TASK_MONKI",
    continuedFromRunId: records.runId,
    status: running ? "RUNNING" : "COMPLETED",
    recoveryState: "NONE",
    generationKey: records.iteration.generationKey,
    requestedSettings: {
      ...task.agentSettings,
      sandbox: "READ_ONLY",
      reasoningEffort: "low",
    },
    observedSettings: {
      ...task.agentSettings,
      sandbox: "READ_ONLY",
      reasoningEffort: "low",
    },
    promptArtifactId: records.promptArtifactId,
    outputArtifactId: running ? undefined : records.reviewFinalArtifactId,
    diagnosticArtifactId: undefined,
    beforeGitSnapshotId: undefined,
    afterGitSnapshotId: records.gitSnapshotId,
    terminalReason: running ? undefined : "completed",
    providerTerminalSource: running ? undefined : "TURN_COMPLETED_NOTIFICATION",
    providerTerminalRawMessage: undefined,
    startedAt,
    lastEventAt: running ? startedAt : completedAt,
    endedAt: running ? undefined : completedAt,
    finalArtifactId: running ? undefined : records.reviewFinalArtifactId,
    eventCount: running ? 18 : 29,
    lastEventType: running ? "review/running" : "turn/completed",
    finalMessage: running ? "" : reviewFinalText,
  });

  upsertById(snapshot.agentSessions, {
    id: records.reviewSessionId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    provider: "codex",
    role: "REVIEW",
    providerSessionId: records.reviewProviderSessionId,
    providerSessionTreeId: `${records.reviewProviderSessionId}-tree`,
    parentSessionId: records.sessionId,
    forkedFromSessionId: records.sessionId,
    providerParentSessionId: records.providerSessionId,
    providerForkedFromSessionId: records.providerSessionId,
    parentRunId: records.runId,
    relationshipState: "RESOLVED",
    worktreePath: records.worktree.worktreePath,
    status: running ? "ACTIVE" : "IDLE",
    materialized: true,
    requestedSettings: {
      ...task.agentSettings,
      sandbox: "READ_ONLY",
      reasoningEffort: "low",
    },
    observedSettings: {
      ...task.agentSettings,
      sandbox: "READ_ONLY",
      reasoningEffort: "low",
    },
    ownership: "TASK_MONKI",
    createdAt: startedAt,
    updatedAt: running ? startedAt : completedAt,
    lastAttachedAt: running ? startedAt : completedAt,
  });

  upsertById(snapshot.agentItems, {
    id: `item-${task.id}-review`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: records.reviewRunId,
    sessionId: records.reviewSessionId,
    providerItemId: `provider-item-${task.id}-review`,
    type: "REVIEW",
    status: running ? "IN_PROGRESS" : "COMPLETED",
    payload: running ? { status: "RUNNING" } : reviewResult,
    providerStartedAt: startedAt,
    providerCompletedAt: running ? undefined : completedAt,
    createdAt: startedAt,
    updatedAt: running ? startedAt : completedAt,
  });

  if (
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-review-started`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-review-started`,
      type: "AGENT_RUN_STARTED",
      taskId: task.id,
      iterationId: records.iteration.id,
      runId: records.reviewRunId,
      agentSessionId: records.reviewSessionId,
      serverInstanceId: "server-codex-demo",
      source: "provider",
      sourceEventId: `source-${task.id}-review-started`,
      occurredAt: startedAt,
      receivedAt: startedAt,
      payload: { mode: "REVIEW" },
    });
  }

  if (
    !running &&
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-review-completed`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-review-completed`,
      type: "AGENT_RUN_COMPLETED",
      taskId: task.id,
      iterationId: records.iteration.id,
      runId: records.reviewRunId,
      agentSessionId: records.reviewSessionId,
      serverInstanceId: "server-codex-demo",
      source: "provider",
      sourceEventId: `source-${task.id}-review-completed`,
      occurredAt: completedAt,
      receivedAt: completedAt,
      payload: { mode: "REVIEW", codexReviewResult: reviewResult },
    });
  }

  task.workflowPhase = "REVIEW";
  task.updatedAt = running ? startedAt : completedAt;
  task.projection = {
    ...task.projection,
    agentRun: "COMPLETED",
    osProcess: "EXITED",
    codexReview: running
      ? {
          status: "RUNNING",
          runId: records.reviewRunId,
          sourceRunId: records.runId,
          reviewedGitSnapshotId: records.gitSnapshotId,
          reviewedHeadSha: records.headSha,
          reviewedDirtyFingerprint: "dirty-created-review-flow",
          updatedAt: startedAt,
        }
      : {
          status: "NEEDS_CHANGES",
          runId: records.reviewRunId,
          sourceRunId: records.runId,
          reviewedGitSnapshotId: records.gitSnapshotId,
          reviewedHeadSha: records.headSha,
          reviewedDirtyFingerprint: "dirty-created-review-flow",
          finalArtifactId: records.reviewFinalArtifactId,
          summary: reviewResult.summary,
          result: reviewResult,
          updatedAt: completedAt,
        },
    artifact: "FINAL_MESSAGE_PRESENT",
    health: running ? "HEALTHY" : "WARNING",
    summary: running
      ? "Codex review is checking the current diff."
      : "Review found delivery-action and stale-review guard issues.",
    updatedAt: running ? startedAt : completedAt,
  };

  return reviewRun;
}

function setCreatedTaskFollowupRunning(snapshot, task, instruction) {
  setCreatedTaskReviewState(snapshot, task, "complete");
  const records = createdTaskRecords(task);
  const startedAt = "2026-06-29T10:07:00.000Z";
  const followupRunId = `run-${task.id}-followup`;
  const followupSessionId = `session-${task.id}-followup`;
  const followupPromptArtifactId = `artifact-${task.id}-followup-prompt`;
  const followupProviderSessionId = `thread-${task.id}-followup`;
  const followupProviderTurnId = `turn-${task.id}-followup`;

  const run = upsertById(snapshot.runs, {
    id: followupRunId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    sessionId: followupSessionId,
    serverInstanceId: "server-codex-demo",
    providerTurnId: followupProviderTurnId,
    mode: "FOLLOW_UP",
    origin: "TASK_MONKI",
    continuedFromRunId: records.runId,
    status: "RUNNING",
    recoveryState: "NONE",
    generationKey: records.iteration.generationKey,
    requestedSettings: task.agentSettings,
    observedSettings: task.agentSettings,
    promptArtifactId: followupPromptArtifactId,
    outputArtifactId: undefined,
    diagnosticArtifactId: undefined,
    beforeGitSnapshotId: records.gitSnapshotId,
    afterGitSnapshotId: undefined,
    terminalReason: undefined,
    providerTerminalSource: undefined,
    providerTerminalRawMessage: undefined,
    startedAt,
    lastEventAt: startedAt,
    endedAt: undefined,
    finalArtifactId: undefined,
    eventCount: 9,
    lastEventType: "turn/diff/updated",
    finalMessage: "",
  });

  upsertById(snapshot.agentSessions, {
    id: followupSessionId,
    taskId: task.id,
    iterationId: records.iteration.id,
    worktreeId: records.worktree.id,
    provider: "codex",
    role: "PRIMARY",
    providerSessionId: followupProviderSessionId,
    providerSessionTreeId: `${followupProviderSessionId}-tree`,
    parentSessionId: records.sessionId,
    forkedFromSessionId: undefined,
    providerParentSessionId: records.providerSessionId,
    providerForkedFromSessionId: undefined,
    parentRunId: records.runId,
    relationshipState: "RESOLVED",
    worktreePath: records.worktree.worktreePath,
    status: "ACTIVE",
    materialized: true,
    requestedSettings: task.agentSettings,
    observedSettings: task.agentSettings,
    ownership: "TASK_MONKI",
    createdAt: startedAt,
    updatedAt: startedAt,
    lastAttachedAt: startedAt,
  });

  upsertById(snapshot.agentPlanRevisions, {
    id: `plan-${task.id}-followup-1`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: followupRunId,
    sessionId: followupSessionId,
    provider: "codex",
    revision: 1,
    explanation: "Review follow-up in progress",
    steps: [
      {
        step: "Apply delivery-action pause reason across the remaining surfaces",
        status: "IN_PROGRESS",
      },
      {
        step: "Keep stale review findings visible as read-only context",
        status: "PENDING",
      },
      {
        step: "Re-run typecheck, tests, build, and diff check",
        status: "PENDING",
      },
    ],
    observedAt: startedAt,
  });

  upsertById(snapshot.agentItems, {
    id: `item-${task.id}-followup-user`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: followupRunId,
    sessionId: followupSessionId,
    providerItemId: `provider-item-${task.id}-followup-user`,
    type: "USER_MESSAGE",
    status: "COMPLETED",
    payload: { text: instruction },
    providerStartedAt: startedAt,
    providerCompletedAt: startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  upsertById(snapshot.agentItems, {
    id: `item-${task.id}-followup-reasoning`,
    taskId: task.id,
    iterationId: records.iteration.id,
    runId: followupRunId,
    sessionId: followupSessionId,
    providerItemId: `provider-item-${task.id}-followup-reasoning`,
    type: "REASONING_SUMMARY",
    status: "IN_PROGRESS",
    payload: {
      summary: [
        "Using the selected review findings as the follow-up scope.",
        "Preserving the stale review output while implementation resumes.",
      ],
    },
    providerStartedAt: startedAt,
    providerCompletedAt: undefined,
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  upsertById(snapshot.artifacts, {
    id: followupPromptArtifactId,
    taskId: task.id,
    runId: followupRunId,
    kind: "prompt",
    path: `artifacts/${followupPromptArtifactId}.txt`,
    byteCount: Buffer.byteLength(instruction, "utf8"),
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  if (
    !snapshot.events.some(
      (candidate) => candidate.id === `event-${task.id}-followup-started`,
    )
  ) {
    snapshot.events.push({
      id: `event-${task.id}-followup-started`,
      type: "AGENT_RUN_STARTED",
      taskId: task.id,
      iterationId: records.iteration.id,
      runId: followupRunId,
      agentSessionId: followupSessionId,
      serverInstanceId: "server-codex-demo",
      source: "provider",
      sourceEventId: `source-${task.id}-followup-started`,
      occurredAt: startedAt,
      receivedAt: startedAt,
      payload: { mode: "FOLLOW_UP" },
    });
  }

  task.workflowPhase = "IN_PROGRESS";
  task.currentRunId = followupRunId;
  task.currentAgentSessionId = followupSessionId;
  task.updatedAt = startedAt;
  task.projection = {
    ...task.projection,
    agentRun: "RUNNING",
    osProcess: "RUNNING",
    git: "DIRTY",
    tests: "STALE",
    codexReview: {
      status: "STALE",
      runId: records.reviewRunId,
      sourceRunId: records.runId,
      reviewedGitSnapshotId: records.gitSnapshotId,
      reviewedHeadSha: records.headSha,
      reviewedDirtyFingerprint: "dirty-created-review-flow",
      finalArtifactId: records.reviewFinalArtifactId,
      summary: reviewResult.summary,
      result: reviewResult,
      updatedAt: startedAt,
    },
    artifact: "FINAL_MESSAGE_PRESENT",
    health: "HEALTHY",
    summary:
      "Follow-up implementation is addressing selected Codex review findings.",
    updatedAt: startedAt,
  };

  return run;
}

function createdTaskRecords(task) {
  const baseSha = "2c1a47fa9a8b7f63df0cc8e9b84f3c13b985d021";
  const branchName = "codex/protect-delivery-actions";
  const now = "2026-06-29T10:00:00.000Z";
  return {
    now,
    baseSha,
    branchName,
    headSha: "84d13f27bca01de19bc13ef4cd859f1a930d4315",
    providerSessionId: `thread-${task.id}`,
    providerTurnId: `turn-${task.id}-impl`,
    reviewProviderTurnId: `turn-${task.id}-review`,
    runId: `run-${task.id}-impl`,
    reviewRunId: `run-${task.id}-review`,
    sessionId: `session-${task.id}-primary`,
    reviewSessionId: `session-${task.id}-review`,
    reviewProviderSessionId: `thread-${task.id}-review`,
    promptArtifactId: `artifact-${task.id}-prompt`,
    outputArtifactId: `artifact-${task.id}-output`,
    finalArtifactId: `artifact-${task.id}-final`,
    reviewFinalArtifactId: "artifact-review-guard-review-final",
    gitSnapshotId: `git-${task.id}-after`,
    testRunId: `test-${task.id}`,
    iteration: {
      id: `iter-${task.id}`,
      taskId: task.id,
      actionRequestId: `action-${task.id}`,
      generationKey: `generation-${task.id}`,
      status: "ACTIVE",
      branchName,
      baseRef: "main",
      baseSha,
      worktreeId: `worktree-${task.id}`,
      createdAt: now,
      updatedAt: now,
    },
    worktree: {
      id: `worktree-${task.id}`,
      taskId: task.id,
      iterationId: `iter-${task.id}`,
      repositoryPath: DEMO_REPOSITORY_PATH,
      worktreePath: `/Users/demo/.task-monki/worktrees/${branchName}`,
      branchName,
      baseRef: "main",
      baseSha,
      headSha: baseSha,
      status: "PRESENT",
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
    },
  };
}

function upsertById(records, next) {
  const existing = records.find((candidate) => candidate.id === next.id);
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  records.push(next);
  return next;
}

function setReviewState(snapshot, state) {
  const task = snapshot.tasks.find(
    (candidate) => candidate.id === "task-review-guard",
  );
  const reviewRun = snapshot.runs.find(
    (candidate) => candidate.id === "run-review-guard-review",
  );
  const reviewSession = snapshot.agentSessions.find(
    (candidate) => candidate.id === "session-review-guard-review",
  );
  const reviewItem = snapshot.agentItems.find(
    (candidate) => candidate.id === "item-review-guard-review",
  );
  const fresh = createDemoSnapshot();
  const freshTask = fresh.tasks.find(
    (candidate) => candidate.id === "task-review-guard",
  );
  const freshReviewRun = fresh.runs.find(
    (candidate) => candidate.id === "run-review-guard-review",
  );
  const freshReviewSession = fresh.agentSessions.find(
    (candidate) => candidate.id === "session-review-guard-review",
  );
  const freshReviewItem = fresh.agentItems.find(
    (candidate) => candidate.id === "item-review-guard-review",
  );

  if (!task || !reviewRun || !freshTask || !freshReviewRun) {
    return;
  }

  if (state === "not-run") {
    task.projection = {
      ...task.projection,
      codexReview: { status: "NOT_RUN" },
      summary:
        "Implementation is complete. The current diff is ready for Codex review.",
      updatedAt: "2026-06-29T09:34:00.000Z",
    };
    reviewRun.status = "COMPLETED";
    reviewRun.finalMessage = "";
    reviewRun.finalArtifactId = undefined;
    reviewRun.outputArtifactId = undefined;
    reviewRun.lastEventType = "turn/completed";
    if (reviewItem) {
      reviewItem.status = "COMPLETED";
      reviewItem.payload = {};
    }
    return;
  }

  if (state === "running") {
    task.projection = {
      ...task.projection,
      codexReview: {
        status: "RUNNING",
        runId: "run-review-guard-review",
        sourceRunId: "run-review-guard-impl",
        reviewedGitSnapshotId: "git-review-guard-after",
        reviewedHeadSha: "7fb4e2c3b17d9f3a624c5b20a0f7cc41d8e91a33",
        reviewedDirtyFingerprint: "dirty-review-guard-7fb4e2",
        updatedAt: "2026-06-29T09:35:00.000Z",
      },
      summary: "Codex review is checking the current diff.",
      updatedAt: "2026-06-29T09:35:00.000Z",
    };
    reviewRun.status = "RUNNING";
    reviewRun.endedAt = undefined;
    reviewRun.terminalReason = undefined;
    reviewRun.providerTerminalSource = undefined;
    reviewRun.providerTerminalRawMessage = undefined;
    reviewRun.finalMessage = "";
    reviewRun.finalArtifactId = undefined;
    reviewRun.outputArtifactId = undefined;
    reviewRun.eventCount = 18;
    reviewRun.lastEventType = "review/running";
    reviewRun.lastEventAt = "2026-06-29T09:35:00.000Z";
    if (reviewSession) {
      reviewSession.status = "ACTIVE";
      reviewSession.updatedAt = "2026-06-29T09:35:00.000Z";
    }
    if (reviewItem) {
      reviewItem.status = "IN_PROGRESS";
      reviewItem.payload = { status: "RUNNING" };
      reviewItem.updatedAt = "2026-06-29T09:35:00.000Z";
    }
    return;
  }

  task.projection = {
    ...task.projection,
    codexReview: freshTask.projection.codexReview,
    summary: freshTask.projection.summary,
    updatedAt: freshTask.projection.updatedAt,
  };
  Object.assign(reviewRun, freshReviewRun);
  if (reviewSession && freshReviewSession) {
    Object.assign(reviewSession, freshReviewSession);
  }
  if (reviewItem && freshReviewItem) {
    Object.assign(reviewItem, freshReviewItem);
  }
}

function broadcastUpdate(eventClients, event) {
  const payload = {
    iterationId: "iter-review-guard",
    payload: {},
    at: new Date("2026-06-29T09:56:00.000Z").toISOString(),
    ...event,
  };
  for (const client of eventClients) {
    client.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(
    process.env.TASK_MONKI_DEMO_API_PORT ?? DEFAULT_DEMO_API_PORT,
  );
  startDemoApiServer({ port })
    .then((server) => {
      console.log(`Task Monki demo API listening on ${server.url}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
