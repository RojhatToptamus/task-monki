#!/usr/bin/env node

import http from 'node:http';

const port = Number(process.env.TASK_MANAGER_API_PORT ?? 3099);
const host = process.env.TASK_MANAGER_API_HOST ?? '127.0.0.1';
const repositoryPath =
  process.env.TASK_MANAGER_REPO_PATH ?? '/Users/rojhat/Documents/task-manager';
const now = '2026-06-24T10:30:00.000Z';

const baseProjection = {
  requestedAction: 'NONE',
  agentRun: 'IDLE',
  osProcess: 'UNKNOWN',
  repositoryPreflight: 'VALID',
  worktree: 'PRESENT',
  git: 'NOT_INSPECTED',
  tests: 'NOT_RUN',
  githubRepository: 'READY',
  branchPublication: 'NOT_PUSHED',
  githubPullRequest: 'UNLINKED',
  ciChecks: 'NOT_APPLICABLE',
  reviews: 'NOT_APPLICABLE',
  merge: 'NOT_APPLICABLE',
  artifact: 'NONE',
  health: 'HEALTHY',
  summary: 'No issues detected.',
  findings: [],
  updatedAt: now
};

const baseSettings = {
  modelProvider: 'openai',
  model: 'gpt-5-codex',
  reasoningEffort: 'high',
  sandbox: 'WORKSPACE_WRITE',
  networkAccess: false,
  approvalPolicy: 'on-request'
};

const tasks = [
  task({
    id: 'task-approve-scoped-filesystem',
    title: 'Approve scoped filesystem access for provider review',
    prompt:
      'Review the provider adapter changes, inspect only the generated diff, and report any safety regressions before the implementation continues.',
    workflowPhase: 'IN_PROGRESS',
    updatedAt: '2026-06-24T10:24:00.000Z',
    projection: {
      agentRun: 'AWAITING_APPROVAL',
      osProcess: 'RUNNING',
      git: 'DIRTY',
      tests: 'RUNNING',
      summary: 'Codex is waiting for approval to read the review worktree.'
    }
  }),
  task({
    id: 'task-provider-settings-choice',
    title: 'Choose migration path for multi-provider settings',
    prompt:
      'Compare global provider defaults with per-task overrides and ask for a decision before removing the old settings merge path.',
    workflowPhase: 'IN_PROGRESS',
    updatedAt: '2026-06-24T10:20:00.000Z',
    projection: {
      agentRun: 'AWAITING_USER_INPUT',
      osProcess: 'RUNNING',
      git: 'DIRTY',
      tests: 'STALE',
      summary: 'A product decision is needed before the settings schema is finalized.'
    }
  }),
  task({
    id: 'task-settings-merge',
    title: 'Extract settings merge into a pure, testable function',
    prompt:
      'Move provider defaults, model overrides, and task-specific execution settings into a deterministic merge utility with focused unit tests.',
    workflowPhase: 'IN_PROGRESS',
    updatedAt: '2026-06-24T10:12:00.000Z',
    projection: {
      agentRun: 'RUNNING',
      osProcess: 'RUNNING',
      git: 'DIRTY',
      tests: 'RUNNING',
      summary: 'Implementation is active and local verification is currently running.'
    }
  }),
  task({
    id: 'task-protocol-drift',
    title: 'Stabilize Codex protocol drift detector',
    prompt:
      'Make the protocol version probe fail with actionable diagnostics when generated bindings and runtime metadata diverge.',
    workflowPhase: 'BLOCKED',
    updatedAt: '2026-06-24T09:58:00.000Z',
    projection: {
      agentRun: 'FAILED',
      osProcess: 'EXITED',
      git: 'DIRTY',
      tests: 'FAILED',
      health: 'ERROR',
      summary: 'The regression suite found a missing unknown-version recovery case.'
    }
  }),
  task({
    id: 'task-keyboard-navigation',
    title: 'Add keyboard shortcuts for board navigation',
    prompt:
      'Add keyboard shortcuts for moving between Inbox, Board, Active runs, Review queue, Done, and Settings without breaking focus order.',
    workflowPhase: 'READY',
    updatedAt: '2026-06-24T09:48:00.000Z',
    projection: {
      git: 'CLEAN',
      tests: 'NOT_RUN',
      summary: 'Ready to implement after the current in-flight work finishes.'
    }
  }),
  task({
    id: 'task-onboarding-checklist',
    title: 'Write onboarding checklist for local agent safety',
    prompt:
      'Document the local repository prerequisites, approval model, test-command risks, and recovery expectations for first-time users.',
    workflowPhase: 'BACKLOG',
    updatedAt: '2026-06-24T09:30:00.000Z',
    projection: {
      worktree: 'NOT_CREATED',
      git: 'CLEAN',
      tests: 'NOT_CONFIGURED',
      summary: 'Queued behind core workflow and evidence improvements.'
    }
  }),
  task({
    id: 'task-provider-abstraction',
    title: 'Implement provider abstraction layer',
    prompt:
      'Introduce a provider-neutral execution interface while preserving explicit capability differences for Codex, Claude, Gemini, and future providers.',
    workflowPhase: 'REVIEW',
    updatedAt: '2026-06-24T10:06:00.000Z',
    projection: {
      agentRun: 'COMPLETED',
      osProcess: 'EXITED',
      git: 'DIRTY',
      tests: 'PASSED',
      artifact: 'FINAL_MESSAGE_PRESENT',
      summary: 'Implementation completed locally; diff is ready for human review.'
    }
  }),
  task({
    id: 'task-repository-trust',
    title: 'Add repository trust preflight',
    prompt:
      'Require an explicit trusted repository decision before preparing worktrees or running local commands for a newly selected project.',
    workflowPhase: 'REVIEW',
    updatedAt: '2026-06-24T09:54:00.000Z',
    projection: {
      agentRun: 'COMPLETED',
      osProcess: 'EXITED',
      git: 'COMMITTED_UNPUSHED',
      tests: 'PASSED',
      artifact: 'FINAL_MESSAGE_PRESENT',
      summary: 'Committed locally and waiting for branch publication.'
    }
  }),
  task({
    id: 'task-evidence-docs',
    title: 'Publish evidence model documentation',
    prompt:
      'Explain which fields are provider-reported, which fields are locally verified, and how stale evidence is surfaced in the UI.',
    workflowPhase: 'IN_REVIEW',
    updatedAt: '2026-06-24T09:42:00.000Z',
    projection: {
      agentRun: 'COMPLETED',
      git: 'PUSHED',
      tests: 'PASSED',
      branchPublication: 'PUSHED',
      githubPullRequest: 'OPEN_DRAFT',
      ciChecks: 'PASSING',
      reviews: 'REQUESTED',
      merge: 'MERGEABLE',
      artifact: 'FINAL_MESSAGE_PRESENT',
      summary: 'Draft pull request is open with passing checks and requested review.'
    }
  }),
  task({
    id: 'task-theme-renderer',
    title: 'Ship theme-aware renderer shell',
    prompt:
      'Finish the responsive renderer shell, app navigation, light/dark theme handling, and screenshot-ready brand polish.',
    workflowPhase: 'DONE',
    resolution: 'COMPLETED',
    updatedAt: '2026-06-24T09:18:00.000Z',
    projection: {
      agentRun: 'COMPLETED',
      osProcess: 'EXITED',
      git: 'PUSHED',
      tests: 'PASSED',
      branchPublication: 'PUSHED',
      githubPullRequest: 'MERGED',
      ciChecks: 'PASSING',
      reviews: 'APPROVED',
      merge: 'MERGED',
      artifact: 'FINAL_MESSAGE_PRESENT',
      summary: 'Merged after local verification and review approval.'
    }
  })
];

const snapshot = {
  schemaVersion: 7,
  tasks,
  iterations: [],
  worktrees: [],
  gitSnapshots: [],
  testRuns: [],
  githubRepositories: [],
  branchPublications: [],
  pullRequests: [],
  ciRollups: [],
  reviewRollups: [],
  mergeSnapshots: [],
  runs: [],
  agentServers: [],
  agentSessions: [],
  agentItems: [],
  agentGoalSnapshots: [],
  agentPlanRevisions: [],
  agentUsageSnapshots: [],
  agentSettingsObservations: [],
  agentSubagentObservations: [],
  interactionRequests: [],
  events: [],
  artifacts: []
};

const providerState = {
  preflight: {
    provider: 'openai',
    ready: true,
    capabilities: {
      provider: 'openai',
      modelCatalog: capability('stable'),
      reasoningEffort: capability('stable'),
      persistentSessions: capability('stable'),
      sessionResume: capability('stable'),
      sessionFork: capability('stable'),
      activeTurnSteering: capability('stable'),
      turnInterruption: capability('stable'),
      truePause: capability('experimental'),
      interactiveApprovals: capability('stable'),
      userInputRequests: capability('stable'),
      goals: capability('stable'),
      plans: capability('stable'),
      review: capability('stable'),
      subagents: capability('experimental'),
      backgroundTerminals: capability('stable'),
      dynamicTools: capability('experimental')
    },
    runtimeVersion: '0.141.0',
    accountLabel: 'Local Codex',
    problems: [],
    warnings: []
  },
  models: [
    model('gpt-5-codex', 'GPT-5 Codex', true, 'high'),
    model('gpt-5', 'GPT-5', false, 'medium'),
    model('o4-mini', 'o4 mini', false, 'low')
  ],
  refreshedAt: now
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    writeNoContent(response);
    return;
  }

  if (url.pathname === '/api/events') {
    response.writeHead(200, {
      ...corsHeaders(),
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    response.write(': connected\n\n');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/defaultRepositoryPath') {
    writeJson(response, repositoryPath);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/provider') {
    writeJson(response, providerState);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    writeJson(response, snapshot);
    return;
  }

  writeJson(response, { error: `No screenshot fixture route for ${request.method} ${url.pathname}` }, 404);
});

server.listen(port, host, () => {
  console.log(`Readme screenshot data server listening on http://${host}:${port}`);
});

function task({
  id,
  title,
  prompt,
  workflowPhase,
  resolution = 'NONE',
  updatedAt,
  projection
}) {
  return {
    id,
    title,
    prompt,
    repositoryPath,
    workflowPhase,
    resolution,
    completionPolicy: 'MANUAL',
    phaseVersion: 1,
    agentSettings: baseSettings,
    testCommand: 'npm test',
    createdAt: '2026-06-24T08:30:00.000Z',
    updatedAt,
    projection: {
      ...baseProjection,
      ...projection,
      updatedAt
    }
  };
}

function capability(maturity, detail) {
  return detail ? { maturity, detail } : { maturity };
}

function model(modelId, displayName, isDefault, defaultReasoningEffort) {
  return {
    id: `openai:${modelId}`,
    provider: 'openai',
    model: modelId,
    displayName,
    hidden: false,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort,
    serviceTiers: ['auto'],
    defaultServiceTier: 'auto',
    inputModalities: ['text'],
    isDefault
  };
}

function writeJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function writeNoContent(response) {
  response.writeHead(204, corsHeaders());
  response.end();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}
