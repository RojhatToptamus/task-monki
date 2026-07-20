import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  AgentServerInstance,
  AgentSessionRecord,
  InteractionRequestRecord,
  Task
} from '../../shared/contracts';
import { createInitialProjection } from '../../shared/contracts';
import type { AgentJsonValue } from '../../shared/agent';
import { createEmptyState, type StoreState } from '../projection/reducer';
import { validateCurrentStoreRecords } from './currentStoreValidation';

const NOW = '2026-07-18T10:00:00.000Z';

describe('validateCurrentStoreRecords', () => {
  it('rejects a task identifier that could escape managed artifact paths', () => {
    const state = createEmptyState();
    state.tasks = [{ ...validTask(), id: '../../escaped' }];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'tasks contains a malformed record'
    );
  });

  it('rejects an unknown Task Monki workflow projection status', () => {
    const task = validTask();
    task.projection = {
      ...task.projection,
      worktree: 'READY' as never
    };
    const state = createEmptyState();
    state.tasks = [task];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'tasks.projection contains a malformed record'
    );
  });

  it('validates the durable implementation retry requirement against its run identity', () => {
    const state = createEmptyState();
    const task = validTask();
    task.projection.implementationRetry = {
      runId: 'not-a-run-id',
      reason: 'Retry before review.'
    };
    state.tasks = [task];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'tasks.projection contains a malformed record'
    );
  });

  it('requires Task Monki ownership for durable agent sessions', () => {
    const state = createEmptyState();
    state.agentSessions = [{ ...validSession(), ownership: 'PROVIDER' as never }];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'agentSessions contains a malformed record'
    );
  });

  it('rejects provider runtime options deeper than the durable JSON bound', () => {
    const state = createEmptyState();
    const session = validSession();
    let nested: Record<string, AgentJsonValue> = {};
    const runtimeOptions: Record<string, AgentJsonValue> = { root: nested };
    for (let depth = 0; depth < 65; depth += 1) {
      const child: Record<string, AgentJsonValue> = {};
      nested.child = child;
      nested = child;
    }
    session.requestedSettings = { runtimeOptions };
    state.agentSessions = [session];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'agentSessions.requestedSettings contains a malformed record'
    );
  });

  it.each([
    ['direction', 'SIDEWAYS'],
    ['sha256', 'not-a-sha256']
  ] as const)('rejects an invalid protocol reference %s', (field, value) => {
    const state = stateWithAgentItem();
    state.agentItems[0]!.rawMessage = {
      ...state.agentItems[0]!.rawMessage!,
      [field]: value
    };

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'agentItems.rawMessage contains a malformed record'
    );
  });

  it('rejects malformed persisted runtime probe diagnostics', () => {
    const state = createEmptyState();
    const server = validServer();
    expect(() => validateCurrentStoreRecords({ ...state, agentServers: [server] })).not.toThrow();
    server.runtimeResolution!.probes[0]!.explicit = 'false' as never;
    state.agentServers = [server];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'agentServers contains a malformed record'
    );
  });

  it('rejects a malformed provider permission request payload', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.type = 'PERMISSION_APPROVAL';
    interaction.allowedActions = ['GRANT_TURN', 'DECLINE'];
    interaction.request = {
      startedAtMs: Date.now(),
      cwd: '/tmp/task-monki-validation-worktree',
      permissions: { network: { enabled: 'yes' as never } }
    };
    state.interactionRequests = [interaction];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });

  it('rejects an interaction decision for a different request type', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.decision = {
      interactionType: 'FILE_CHANGE_APPROVAL',
      action: 'ACCEPT'
    };
    state.interactionRequests = [interaction];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });

  it('validates the durable provider option selected for a command response', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.request = {
      startedAtMs: Date.now(),
      command: 'npm test',
      paths: ['/tmp/task-monki-validation-worktree/package.json'],
      networkApprovalContext: {},
      providerOptions: [
        {
          id: 'allow-once',
          label: 'Allow once',
          action: 'ACCEPT',
          providerRemembersChoice: false
        }
      ]
    };
    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT',
      providerOptionId: 'allow-once'
    };
    state.interactionRequests = [interaction];
    expect(() => validateCurrentStoreRecords(state)).not.toThrow();

    interaction.decision.providerOptionId = 7 as never;
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });

  it('accepts an inbound provider acknowledgement as interaction response evidence', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.responseRawMessage = {
      ...interaction.requestRawMessage,
      sequence: 2,
      direction: 'INBOUND'
    };
    state.interactionRequests = [interaction];

    expect(() => validateCurrentStoreRecords(state)).not.toThrow();
  });

  it('rejects ambiguous or mismatched durable provider permission options', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.request = {
      startedAtMs: Date.now(),
      command: 'npm test',
      providerOptions: [
        {
          id: 'same',
          label: 'Allow once',
          action: 'ACCEPT',
          providerRemembersChoice: false
        },
        {
          id: 'same',
          label: 'Allow always',
          action: 'ACCEPT',
          providerRemembersChoice: true
        }
      ]
    };
    state.interactionRequests = [interaction];
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );

    interaction.request = {
      startedAtMs: Date.now(),
      command: 'npm test',
      providerOptions: [
        {
          id: 'allow-always',
          label: 'Allow always',
          action: 'ACCEPT',
          providerRemembersChoice: true
        }
      ]
    };
    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'DECLINE',
      providerOptionId: 'allow-always'
    };
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });

  it('keeps an empty provider option catalog fail-closed in durable state', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.request = {
      startedAtMs: Date.now(),
      providerOptions: []
    };
    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'CANCEL'
    };
    state.interactionRequests = [interaction];

    expect(() => validateCurrentStoreRecords(state)).not.toThrow();

    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT'
    };
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );

    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT_FOR_SESSION'
    };
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );

    interaction.request = { startedAtMs: Date.now(), command: 'npm test' };
    expect(() => validateCurrentStoreRecords(state)).not.toThrow();

    interaction.decision = {
      interactionType: 'COMMAND_APPROVAL',
      action: 'ACCEPT',
      providerOptionId: 'allow-once'
    };
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });

  it('rejects malformed provider metadata and command paths', () => {
    const state = createEmptyState();
    const interaction = validInteraction();
    interaction.request = {
      startedAtMs: Date.now(),
      paths: [7 as never],
      providerOptions: [
        {
          id: 'allow-once',
          label: 'Allow once',
          action: 'ACCEPT',
          providerRemembersChoice: false
        }
      ]
    };
    state.interactionRequests = [interaction];

    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );

    interaction.request = {
      startedAtMs: Date.now(),
      providerOptions: [
        {
          id: 'allow-once',
          label: 'Allow once',
          action: 'ACCEPT',
          providerRemembersChoice: 'false' as never
        }
      ]
    };
    expect(() => validateCurrentStoreRecords(state)).toThrow(
      'interactionRequests contains a malformed record'
    );
  });
});

function validTask(): Task {
  return {
    id: randomUUID(),
    runtimeId: 'codex',
    title: 'Validate current schema',
    prompt: 'Reject malformed durable control state.',
    repositoryId: randomUUID(),
    workflowPhase: 'READY',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: { runtimeId: 'codex' },
    createdAt: NOW,
    updatedAt: NOW,
    projection: createInitialProjection(NOW)
  };
}

function validSession(): AgentSessionRecord {
  return {
    id: randomUUID(),
    taskId: randomUUID(),
    iterationId: randomUUID(),
    worktreeId: randomUUID(),
    runtimeId: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    worktreePath: '/tmp/task-monki-validation-worktree',
    status: 'IDLE',
    materialized: true,
    requestedSettings: { runtimeId: 'codex' },
    ownership: 'TASK_MONKI',
    createdAt: NOW,
    updatedAt: NOW
  };
}

function validServer(): AgentServerInstance {
  return {
    id: randomUUID(),
    runtimeId: 'codex',
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    status: 'READY',
    executable: '/usr/local/bin/codex',
    argv: ['app-server', '--stdio'],
    runtimeResolution: {
      selectedExecutable: '/usr/local/bin/codex',
      selectedSource: 'path',
      selectedVersion: '1.0.0',
      selectedLaunchArgv: ['app-server', '--stdio'],
      requiredCapabilities: ['thread/start'],
      probes: [
        {
          executable: '/usr/local/bin/codex',
          source: 'path',
          explicit: false,
          compatible: true,
          version: '1.0.0',
          launchArgv: ['app-server', '--stdio'],
          launchForm: 'stdio-flag',
          missingCapabilities: [],
          detail: ''
        }
      ]
    },
    protocolJournalPath: '/tmp/task-monki-validation/protocol.ndjson',
    startedAt: NOW
  };
}

function validInteraction(): InteractionRequestRecord {
  return {
    id: randomUUID(),
    runtimeId: 'codex',
    serverInstanceId: randomUUID(),
    providerRequestId: 'request-1',
    taskId: randomUUID(),
    iterationId: randomUUID(),
    runId: randomUUID(),
    sessionId: randomUUID(),
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: { startedAtMs: Date.now(), command: 'npm test' },
    allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: randomUUID(),
      direction: 'INBOUND',
      recordedAt: NOW,
      sequence: 1,
      byteOffset: 0,
      byteLength: 1,
      sha256: 'a'.repeat(64)
    },
    requestedAt: NOW
  };
}

function stateWithAgentItem(): StoreState {
  const state = createEmptyState();
  const item: AgentItemRecord = {
    id: randomUUID(),
    taskId: randomUUID(),
    iterationId: randomUUID(),
    runId: randomUUID(),
    sessionId: randomUUID(),
    providerItemId: 'provider-item/opaque',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: {},
    rawMessage: {
      serverInstanceId: randomUUID(),
      direction: 'INBOUND',
      recordedAt: NOW,
      sequence: 1,
      byteOffset: 0,
      byteLength: 1,
      sha256: 'a'.repeat(64)
    },
    createdAt: NOW,
    updatedAt: NOW
  };
  state.agentItems = [item];
  return state;
}
