import {
  createInitialProjection,
  type AgentItemRecord,
  type GitSnapshotRecord,
  type RunRecord,
  type StatusProjection,
  type Task
} from '../shared/contracts';
import type { AgentProtocolMessageReference } from '../shared/agent';

export const TEST_NOW = '2026-07-19T12:00:00.000Z';

type TaskOverrides = Omit<Partial<Task>, 'projection'> & {
  projection?: Partial<StatusProjection>;
};

export function makeTaskRecord(overrides: TaskOverrides = {}): Task {
  const { projection, ...taskOverrides } = overrides;
  const now = taskOverrides.createdAt ?? TEST_NOW;
  return {
    id: 'task-1',
    kind: 'NORMAL',
    title: 'Test task',
    prompt: 'Implement the requested change.',
    repositoryId: 'repository-1',
    runtimeId: 'codex',
    workflowPhase: 'BACKLOG',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    ...taskOverrides,
    projection: {
      ...createInitialProjection(now),
      ...projection
    }
  };
}

export function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: TEST_NOW,
    eventCount: 0,
    ...overrides
  };
}

export function makeRawMessage(
  overrides: Partial<AgentProtocolMessageReference> = {}
): AgentProtocolMessageReference {
  return {
    serverInstanceId: 'server-1',
    sequence: 1,
    direction: 'INBOUND',
    recordedAt: TEST_NOW,
    byteOffset: 0,
    byteLength: 1,
    sha256: 'test-message',
    ...overrides
  };
}

export function makeAgentItemRecord(
  overrides: Partial<AgentItemRecord> = {}
): AgentItemRecord {
  return {
    id: 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: 'provider-item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: { text: 'Progress: Working.' },
    rawMessage: makeRawMessage(),
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides
  };
}

export function makeGitSnapshotRecord(
  overrides: Partial<GitSnapshotRecord> = {}
): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/task-monki-test',
    repoRoot: '/tmp/task-monki-test',
    gitCommonDir: '/tmp/task-monki-test/.git',
    branch: 'task/test-task',
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    commitsAheadOfBase: 0,
    committedDiffFileCount: 0,
    workingDiffFileCount: 0,
    diffStat: '',
    dirtyFingerprint: 'clean',
    status: 'CLEAN',
    capturedAt: TEST_NOW,
    ...overrides
  };
}
