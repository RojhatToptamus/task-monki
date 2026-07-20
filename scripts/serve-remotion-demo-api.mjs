import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFINED_PROMPT,
  REFINED_TITLE,
  completeShowcaseFollowup,
  completeShowcaseImplementation,
  createShowcaseTask,
  loadShowcaseData,
  markShowcaseDone,
  prepareShowcaseWorktree,
  startShowcaseImplementation,
  startShowcaseReview,
  startShowcaseReviewFollowup,
} from "./showcase-demo-data.mjs";

export const DEFAULT_DEMO_API_PORT = 43099;

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function startDemoApiServer({
  port = DEFAULT_DEMO_API_PORT,
  previewUrl = "http://127.0.0.1:43130",
  previewEvidence,
} = {}) {
  const data = await loadShowcaseData(rootDir);
  data.previewEvidence = previewEvidence;
  const eventClients = new Set();

  const server = http.createServer((request, response) => {
    void route({
      request,
      response,
      data,
      previewUrl,
      eventClients,
    }).catch((error) => {
      sendJson(response, 500, {
        error: {
          code: "SHOWCASE_API_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Unknown showcase API error.",
          retryable: false,
        },
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
    data,
    close: async () => {
      for (const client of eventClients) client.end();
      eventClients.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function route({ request, response, data, previewUrl, eventClients }) {
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
    });
    response.write("\n");
    eventClients.add(response);
    request.once("close", () => eventClients.delete(response));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, data.appSettings);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/tools") {
    sendJson(response, 200, createExternalToolStatus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/runtimes") {
    sendJson(response, 200, data.runtimeCatalog);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/provider") {
    sendJson(response, 200, data.runtimeCatalog.runtimes[0]);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(response, 200, data.snapshot);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/defaultRepositoryPath"
  ) {
    sendJson(response, 200, data.repositories.primary.path);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: "Not found", retryable: false },
    });
    return;
  }

  const body = await readJson(request);

  if (url.pathname === "/api/settings") {
    mergeSettings(data.appSettings, body);
    broadcastUpdate(eventClients, "runtime.updated", "settings");
    sendJson(response, 200, data.appSettings);
    return;
  }

  if (url.pathname === "/api/settings/tools/test") {
    sendJson(response, 200, externalToolProbe(body.tool));
    return;
  }

  if (url.pathname === "/api/agent/runtimes/discover") {
    const runtime = data.runtimeCatalog.runtimes.find(
      (candidate) => candidate.preflight.runtime.id === body.runtimeId,
    );
    if (!runtime) throw new Error(`Unknown runtime ${body.runtimeId}`);
    await delay(280);
    sendJson(response, 200, runtime);
    return;
  }

  if (url.pathname === "/api/repository/chooseFolder") {
    sendJson(response, 200, data.repositories.primary.path);
    return;
  }

  if (url.pathname === "/api/prompt/refine") {
    await delay(1_600);
    sendJson(response, 200, {
      titleSuggestion: REFINED_TITLE,
      prompt: REFINED_PROMPT,
      source: "model",
    });
    return;
  }

  if (url.pathname === "/api/tasks") {
    const task = createShowcaseTask({
      data,
      input: body,
    });
    data.snapshot.tasks.unshift(task);
    broadcastUpdate(eventClients, "task.updated", task.id);
    sendJson(response, 200, task);
    return;
  }

  if (url.pathname === "/api/worktrees/prepare") {
    const worktree = prepareShowcaseWorktree(data, body.taskId);
    broadcastUpdate(eventClients, "worktree.updated", body.taskId);
    sendJson(response, 200, worktree);
    return;
  }

  if (url.pathname === "/api/runs/start") {
    const run = startShowcaseImplementation(data, body.taskId);
    broadcastUpdate(eventClients, "run.started", body.taskId, run.id);
    sendJson(response, 200, run);
    return;
  }

  if (url.pathname === "/api/runs/review") {
    const run = startShowcaseReview(data, body.taskId);
    broadcastUpdate(eventClients, "run.completed", body.taskId, run.id);
    sendJson(response, 200, run);
    return;
  }

  if (url.pathname === "/api/runs/continue") {
    const run = startShowcaseReviewFollowup(data, body.taskId);
    broadcastUpdate(eventClients, "run.started", body.taskId, run.id);
    sendJson(response, 200, run);
    return;
  }

  if (url.pathname === "/api/showcase/advance") {
    const task =
      body.to === "IMPLEMENTATION_COMPLETED"
        ? completeShowcaseImplementation(data, body.taskId)
        : body.to === "FOLLOWUP_COMPLETED"
          ? completeShowcaseFollowup(data, body.taskId)
          : undefined;
    if (!task) throw new Error(`Unknown showcase advance target ${body.to}`);
    broadcastUpdate(eventClients, "task.updated", body.taskId);
    sendJson(response, 200, task);
    return;
  }

  if (url.pathname === "/api/tasks/transition") {
    if (body.toPhase !== "DONE") {
      throw new Error(`Unsupported showcase transition ${body.toPhase}`);
    }
    const task = markShowcaseDone(data, body.taskId);
    broadcastUpdate(eventClients, "task.updated", body.taskId);
    sendJson(response, 200, task);
    return;
  }

  if (url.pathname === "/api/evidence/refresh") {
    const task = data.snapshot.tasks.find(
      (candidate) => candidate.id === body.taskId,
    );
    const gitSnapshot = data.snapshot.gitSnapshots.find(
      (candidate) => candidate.id === task?.currentGitSnapshotId,
    );
    if (!gitSnapshot) throw new Error("Showcase Git evidence is unavailable.");
    sendJson(response, 200, gitSnapshot);
    return;
  }

  if (url.pathname === "/api/agent/goal/sync") {
    sendJson(response, 200, {});
    return;
  }

  if (url.pathname === "/api/artifact/read") {
    sendJson(
      response,
      200,
      data.artifactTexts.get(body.artifactId) ??
        "Artifact output is unavailable in the showcase.",
    );
    return;
  }

  if (url.pathname === "/api/agent/protocol/read") {
    sendJson(response, 200, {
      raw: JSON.stringify(
        {
          method: "turn/completed",
          params: { status: "completed", source: "showcase" },
        },
        null,
        2,
      ),
      metadata: { redacted: true },
    });
    return;
  }

  if (url.pathname === "/api/preview/open") {
    sendJson(response, 200, { opened: false, url: `${previewUrl}/` });
    return;
  }

  if (url.pathname === "/api/preview/log/read") {
    const text =
      data.artifactTexts.get(body.artifactId) ??
      "Preview service is healthy.\n";
    const offset = Number(body.offset ?? 0);
    const maxBytes = Number(body.maxBytes ?? 64_000);
    const chunk = text.slice(offset, offset + maxBytes);
    sendJson(response, 200, {
      chunk,
      nextOffset: offset + chunk.length,
      endOfFile: offset + chunk.length >= text.length,
    });
    return;
  }

  if (url.pathname === "/api/open-target/inspect") {
    sendJson(response, 200, createOpenTargetInspection(body.target));
    return;
  }

  if (url.pathname === "/api/open-target/execute") {
    sendJson(response, 200, {
      ok: true,
      message: "Showcase target action completed.",
    });
    return;
  }

  sendJson(response, 404, {
    error: { code: "NOT_FOUND", message: "Not found", retryable: false },
  });
}

function createExternalToolStatus() {
  return {
    tools: {
      git: externalToolProbe("git"),
      codex: externalToolProbe("codex"),
      gh: externalToolProbe("gh"),
    },
    refreshedAt: "2026-07-20T09:40:00.000Z",
  };
}

function externalToolProbe(tool) {
  const definitions = {
    git: {
      label: "Git",
      required: true,
      executable: "git",
      resolvedPath: "/usr/bin/git",
      version: "git version 2.50.0",
    },
    codex: {
      label: "Codex CLI",
      required: true,
      executable: "codex",
      resolvedPath: "/usr/local/bin/codex",
      version: "codex-cli 0.141.0",
    },
    gh: {
      label: "GitHub CLI",
      required: false,
      executable: "gh",
      resolvedPath: "/usr/local/bin/gh",
      version: "gh version 2.74.0",
    },
  };
  const definition = definitions[tool] ?? definitions.git;
  return {
    tool,
    label: definition.label,
    required: definition.required,
    source: "auto",
    configuredPath: null,
    executable: definition.executable,
    resolvedPath: definition.resolvedPath,
    status: "ok",
    version: definition.version,
    error: null,
  };
}

function createOpenTargetInspection(target) {
  return {
    target: { type: target?.type ?? "repository", kind: "directory" },
    apps: [
      { id: "vscode", label: "Visual Studio Code" },
      { id: "cursor", label: "Cursor" },
    ],
    preferredAppId: "vscode",
    revealLabel: "Reveal in Finder",
    canOpen: true,
    canReveal: true,
    canOpenTerminal: true,
    canCopyFileContents: false,
    copyFileContentsDisabledReason: "Select a file to copy its contents.",
  };
}

function mergeSettings(settings, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete settings[key];
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      settings[key] &&
      typeof settings[key] === "object" &&
      !Array.isArray(settings[key])
    ) {
      settings[key] = { ...settings[key], ...value };
    } else {
      settings[key] = value;
    }
  }
}

function broadcastUpdate(clients, type, taskId, runId) {
  const event = {
    type,
    taskId,
    runId,
    payload: { source: "task-monki-showcase" },
    at: new Date().toISOString(),
  };
  const body = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(body);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
