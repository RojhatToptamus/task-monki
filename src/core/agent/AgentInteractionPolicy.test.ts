import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionRecord,
  AgentUserInputDecision,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import {
  buildInteractionPolicy,
  validateInteractionDecision
} from './AgentInteractionPolicy';

describe('Agent interaction policy', () => {
  it('offers explicit Preview folder inspection without granting writes, network or shell escalation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-inspection-'));
    try {
      const session = sessionFixture({ role: 'PREVIEW', worktreePath: path.join(directory, 'frontend') });
      const run = { ...runFixture(), mode: 'PREVIEW' as const };
      const request = { startedAtMs: 1, cwd: session.worktreePath, permissions: { fileSystem: { read: [directory] } } };
      const policy = buildInteractionPolicy({ type: 'PERMISSION_APPROVAL', request, session, run });
      expect(policy.allowedActions).toEqual(['GRANT_TURN', 'GRANT_SESSION', 'DECLINE']);
      const interaction = interactionFixture({ type: 'PERMISSION_APPROVAL', request, allowedActions: policy.allowedActions });
      expect(() => validateInteractionDecision(interaction, {
        interactionType: 'PERMISSION_APPROVAL', action: 'GRANT_TURN', permissions: request.permissions
      }, session, run)).not.toThrow();
      for (const permissions of [
        { fileSystem: { read: [os.homedir()] } },
        { fileSystem: { read: [path.parse(directory).root] } },
        { fileSystem: { read: [directory], write: [directory] } },
        { fileSystem: { entries: [{ path: { type: 'path' as const, path: directory }, access: 'write' as const }] } },
        { fileSystem: { read: [directory] }, network: { enabled: true } }
      ]) {
        expect(buildInteractionPolicy({ type: 'PERMISSION_APPROVAL', request: { ...request, permissions }, session, run }).allowedActions).toEqual(['DECLINE']);
        expect(() => validateInteractionDecision({ ...interaction, request: { ...request, permissions } }, {
          interactionType: 'PERMISSION_APPROVAL', action: 'GRANT_SESSION', permissions
        }, session, run)).toThrow();
      }
      expect(buildInteractionPolicy({ type: 'COMMAND_APPROVAL', request: { startedAtMs: 1, cwd: session.worktreePath, command: 'npm install' }, session, run }).allowedActions).toEqual(['DECLINE', 'CANCEL']);
      expect(buildInteractionPolicy({ type: 'FILE_CHANGE_APPROVAL', request: { startedAtMs: 1 }, session, run }).allowedActions).toEqual(['DECLINE', 'CANCEL']);
      expect(buildInteractionPolicy({ type: 'PERMISSION_APPROVAL', request, session, run: runFixture() }).allowedActions).toEqual(['DECLINE']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('offers a Preview read of one external file only when its folder could be approved', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-file-inspection-'));
    const home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
    try {
      await fs.mkdir(path.join(directory, 'backend'));
      await fs.writeFile(path.join(directory, 'backend', 'package.json'), '{}');
      await fs.writeFile(path.join(directory, '.npmrc'), 'token');
      const session = sessionFixture({ role: 'PREVIEW', worktreePath: path.join(directory, 'frontend') });
      const run = { ...runFixture(), mode: 'PREVIEW' as const };
      const read = (file: string) => buildInteractionPolicy({
        type: 'PERMISSION_APPROVAL',
        request: { startedAtMs: 1, cwd: session.worktreePath, permissions: { fileSystem: { entries: [{ path: { type: 'path', path: file }, access: 'read' }] } } },
        session,
        run
      }).allowedActions;
      expect(read(path.join(directory, 'backend', 'package.json'))).toContain('GRANT_TURN');
      // A file directly in the home directory is as broad as approving home itself.
      expect(read(path.join(directory, '.npmrc'))).toEqual(['DECLINE']);
    } finally {
      home.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for commands outside the task worktree or requiring blocked network', () => {
    const outside = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'curl https://example.com',
        cwd: '/tmp/other',
        networkApprovalContext: { host: 'example.com', protocol: 'https' }
      },
      session: sessionFixture(),
      run: runFixture()
    });

    expect(outside.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(outside.warnings).toHaveLength(2);
  });

  it('fails closed when a command request has no verifiable command or structured action', () => {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: { startedAtMs: 1, command: '   ' },
      session: sessionFixture(),
      run: runFixture()
    });

    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings).toContain('Task Monki could not verify the requested command.');
  });

  it('exposes only provider-supplied command amendments', () => {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        proposedExecPolicyAmendment: ['npm', 'test']
      },
      session: sessionFixture(),
      run: runFixture()
    });
    expect(policy.allowedActions).toContain('ACCEPT_EXEC_POLICY_AMENDMENT');

    const interaction = interactionFixture({
      request: {
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        proposedExecPolicyAmendment: ['npm', 'test']
      },
      allowedActions: policy.allowedActions
    });
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT_EXEC_POLICY_AMENDMENT',
          amendment: ['npm', 'publish']
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('does not match');
  });

  it('requires the exact provider option selected for a native permission request', () => {
    const interaction = interactionFixture({
      request: {
        startedAtMs: 1,
        command: 'npm test',
        cwd: '/tmp/worktree',
        providerOptions: [
          {
            id: 'allow-once',
            label: 'Allow once',
            action: 'ACCEPT',
            providerRemembersChoice: false
          },
          {
            id: 'allow-always',
            label: 'Allow always',
            action: 'ACCEPT',
            providerRemembersChoice: true
          },
          {
            id: 'reject-once',
            label: 'Reject',
            action: 'DECLINE',
            providerRemembersChoice: false
          }
        ]
      },
      allowedActions: ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL']
    });

    expect(() =>
      validateInteractionDecision(
        interaction,
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('exact option ID');
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT',
          providerOptionId: 'reject-once'
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('does not match');
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT',
          providerOptionId: 'allow-once'
        },
        sessionFixture(),
        runFixture()
      )
    ).not.toThrow();
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT',
          providerOptionId: 'allow-always'
        },
        sessionFixture(),
        runFixture()
      )
    ).not.toThrow();
    expect(() =>
      validateInteractionDecision(
        interaction,
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT_FOR_SESSION' },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('exact provider option or cancellation');
  });

  it('keeps empty provider requests fail-closed without changing generic approvals', () => {
    const providerInteraction = interactionFixture({
      request: {
        startedAtMs: 1,
        providerOptions: []
      },
      allowedActions: ['ACCEPT', 'ACCEPT_FOR_SESSION', 'CANCEL']
    });

    expect(() =>
      validateInteractionDecision(
        providerInteraction,
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('exact option ID');
    expect(() =>
      validateInteractionDecision(
        providerInteraction,
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT_FOR_SESSION' },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('exact provider option or cancellation');
    expect(() =>
      validateInteractionDecision(
        providerInteraction,
        { interactionType: 'COMMAND_APPROVAL', action: 'CANCEL' },
        sessionFixture(),
        runFixture()
      )
    ).not.toThrow();

    const genericInteraction = interactionFixture({
      request: { startedAtMs: 1, command: 'npm test' },
      allowedActions: ['ACCEPT', 'ACCEPT_FOR_SESSION', 'DECLINE', 'CANCEL']
    });
    expect(() =>
      validateInteractionDecision(
        genericInteraction,
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT_FOR_SESSION' },
        sessionFixture(),
        runFixture()
      )
    ).not.toThrow();
    expect(() =>
      validateInteractionDecision(
        genericInteraction,
        {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT',
          providerOptionId: 'allow-once'
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('no provider permission options');
  });

  it('does not delegate Task Monki-controlled Git delivery actions to Codex', () => {
    const policy = buildInteractionPolicy({
      type: 'COMMAND_APPROVAL',
      request: {
        startedAtMs: 1,
        command: 'git commit -am "generated"',
        cwd: '/tmp/worktree'
      },
      session: sessionFixture(),
      run: runFixture()
    });

    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('reserves commit');
  });

  it('rejects permission grants outside the requested and task-owned subset', () => {
    const interaction = interactionFixture({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: {
          fileSystem: { write: ['/tmp/worktree/cache'] }
        }
      },
      allowedActions: ['GRANT_TURN', 'DECLINE']
    });

    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'PERMISSION_APPROVAL',
          action: 'GRANT_TURN',
          permissions: {
            fileSystem: { write: ['/tmp/other'] }
          }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('subset');
  });

  it('allows only an explicitly authorized exact read path and never parent reads or writes', () => {
    const attachmentPath = '/tmp/task-monki/attachments/task-1/file.txt';
    const readPolicy = buildInteractionPolicy({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: { fileSystem: { read: [attachmentPath] } }
      },
      session: sessionFixture(),
      run: runFixture(),
      additionalReadOnlyPaths: [attachmentPath]
    });
    expect(readPolicy.allowedActions).toContain('GRANT_TURN');
    expect(readPolicy.warnings).toEqual([]);
    const interaction = interactionFixture({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: { fileSystem: { read: [attachmentPath] } }
      },
      allowedActions: readPolicy.allowedActions
    });
    const grant = {
      interactionType: 'PERMISSION_APPROVAL' as const,
      action: 'GRANT_TURN' as const,
      permissions: { fileSystem: { read: [attachmentPath] } }
    };
    expect(() =>
      validateInteractionDecision(
        interaction,
        grant,
        sessionFixture(),
        runFixture(),
        [attachmentPath]
      )
    ).not.toThrow();
    expect(() =>
      validateInteractionDecision(
        interaction,
        grant,
        sessionFixture(),
        runFixture()
      )
    ).toThrow('outside the task worktree');

    const parentRead = buildInteractionPolicy({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: {
          fileSystem: { read: ['/tmp/task-monki/attachments/task-1'] }
        }
      },
      session: sessionFixture(),
      run: runFixture(),
      additionalReadOnlyPaths: [attachmentPath]
    });
    expect(parentRead.allowedActions).toEqual(['DECLINE']);

    const writePolicy = buildInteractionPolicy({
      type: 'PERMISSION_APPROVAL',
      request: {
        startedAtMs: 1,
        cwd: '/tmp/worktree',
        permissions: { fileSystem: { write: [attachmentPath] } }
      },
      session: sessionFixture(),
      run: runFixture(),
      additionalReadOnlyPaths: [attachmentPath]
    });
    expect(writePolicy.allowedActions).toEqual(['DECLINE']);
    expect(writePolicy.warnings.join(' ')).toContain('write permission');

  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink alias even when it resolves to an allowed run attachment',
    async () => {
      const delivery = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-policy-delivery-')
      );
      const aliases = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-policy-alias-')
      );
      const attachmentPath = path.join(delivery, 'attachment.txt');
      const aliasPath = path.join(aliases, 'retargetable.txt');
      await fs.writeFile(attachmentPath, 'untrusted input');
      await fs.symlink(attachmentPath, aliasPath);

      const policy = buildInteractionPolicy({
        type: 'PERMISSION_APPROVAL',
        request: {
          startedAtMs: 1,
          cwd: '/tmp/worktree',
          permissions: { fileSystem: { read: [aliasPath] } }
        },
        session: sessionFixture(),
        run: runFixture(),
        additionalReadOnlyPaths: [attachmentPath]
      });

      expect(policy.allowedActions).toEqual(['DECLINE']);
      expect(policy.warnings.join(' ')).toContain('outside the task worktree');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a missing write target below a worktree symlink that escapes the worktree',
    async () => {
      const worktree = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-policy-worktree-')
      );
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-policy-outside-')
      );
      await fs.symlink(outside, path.join(worktree, 'escape'), 'dir');
      const escapedTarget = path.join(worktree, 'escape', 'not-created-yet.txt');

      const policy = buildInteractionPolicy({
        type: 'PERMISSION_APPROVAL',
        request: {
          startedAtMs: 1,
          cwd: worktree,
          permissions: { fileSystem: { write: [escapedTarget] } }
        },
        session: sessionFixture({ worktreePath: worktree }),
        run: runFixture()
      });

      expect(policy.allowedActions).toEqual(['DECLINE']);
      expect(policy.warnings.join(' ')).toContain('outside the task worktree');
    }
  );

  it('validates accepted MCP form content against the provider schema', () => {
    const interaction = interactionFixture({
      type: 'MCP_ELICITATION',
      request: {
        mode: 'form',
        serverName: 'tickets',
        message: 'Select severity',
        requestedSchema: {
          type: 'object',
          required: ['severity'],
          properties: {
            severity: { type: 'string', enum: ['low', 'high'] }
          }
        }
      },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL']
    });

    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          interactionType: 'MCP_ELICITATION',
          action: 'ACCEPT',
          content: { severity: 'critical' }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('not an allowed value');
  });

  it('validates single, multiple, custom, and free-text user answers', () => {
    const interaction = interactionFixture({
      type: 'USER_INPUT',
      request: {
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Choose one scope.',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Core', description: '' },
              { label: 'Renderer', description: '' }
            ]
          },
          {
            id: 'checks',
            header: 'Checks',
            question: 'Choose checks or add one.',
            isOther: true,
            isSecret: false,
            allowsMultiple: true,
            options: [
              { label: 'Unit', description: '' },
              { label: 'Build', description: '' }
            ]
          },
          {
            id: 'detail',
            header: 'Detail',
            question: 'Add a note.',
            isOther: false,
            isSecret: false
          }
        ]
      },
      allowedActions: ['ANSWER']
    });
    const valid: AgentUserInputDecision = {
      interactionType: 'USER_INPUT',
      action: 'ANSWER',
      answers: {
        scope: ['Core'],
        checks: ['Unit', 'Smoke'],
        detail: ['Keep the change small.']
      }
    };

    expect(() =>
      validateInteractionDecision(
        interaction,
        valid,
        sessionFixture(),
        runFixture()
      )
    ).not.toThrow();
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          ...valid,
          answers: { ...valid.answers, scope: ['Core', 'Renderer'] }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('Only one answer');
    expect(() =>
      validateInteractionDecision(
        interaction,
        {
          ...valid,
          answers: { ...valid.answers, scope: ['Database'] }
        },
        sessionFixture(),
        runFixture()
      )
    ).toThrow('not one of the supplied options');
  });

  it('keeps secret-marked user input blocked after typed boolean redaction', () => {
    expect(
      buildInteractionPolicy({
        type: 'USER_INPUT',
        request: {
          questions: [
            {
              id: 'credential',
              header: 'Credential',
              question: 'Enter a secret.',
              isOther: false,
              isSecret: true
            }
          ]
        },
        session: sessionFixture(),
        run: runFixture()
      })
    ).toMatchObject({
      allowedActions: [],
      warnings: [expect.stringContaining('secret-safe response channel')]
    });
  });

  it.each([
    ['no questions', []],
    [
      'duplicate question IDs',
      [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Choose a scope.',
          isOther: false,
          isSecret: false
        },
        {
          id: 'scope',
          header: 'Detail',
          question: 'Add detail.',
          isOther: false,
          isSecret: false
        }
      ]
    ],
    [
      'no answer route',
      [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Choose a scope.',
          isOther: false,
          isSecret: false,
          options: []
        }
      ]
    ],
    [
      'a blank option label',
      [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Choose a scope.',
          isOther: false,
          isSecret: false,
          options: [{ label: ' ', description: 'Invalid provider option.' }]
        }
      ]
    ],
    [
      'blank question metadata',
      [
        {
          id: ' ',
          header: 'Scope',
          question: 'Choose a scope.',
          isOther: false,
          isSecret: false
        }
      ]
    ],
    [
      'duplicate option labels',
      [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Choose a scope.',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Core', description: 'First provider option.' },
            { label: ' Core ', description: 'Ambiguous duplicate option.' }
          ]
        }
      ]
    ]
  ])('blocks malformed user input with %s', (_case, questions) => {
    expect(
      buildInteractionPolicy({
        type: 'USER_INPUT',
        request: { questions },
        session: sessionFixture(),
        run: runFixture()
      })
    ).toMatchObject({
      allowedActions: [],
      warnings: [expect.stringContaining('malformed or unanswerable')]
    });
  });
});

function sessionFixture(
  overrides: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return {
    id: 'session-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    runtimeId: 'codex',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    worktreePath: '/tmp/worktree',
    status: 'ACTIVE',
    materialized: true,
    requestedSettings: {
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request'
    },
    ownership: 'TASK_MONKI',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    ...overrides
  };
}

function runFixture(): RunRecord {
  return {
    id: 'run-1',
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    serverInstanceId: 'server-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'AWAITING_APPROVAL',
    recoveryState: 'NONE',
    requestedSettings: {
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request'
    },
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    attachmentSelection: [],
    startedAt: '2026-06-22T00:00:00.000Z',
    eventCount: 0
  };
}

function interactionFixture(
  overrides: Partial<InteractionRequestRecord> = {}
): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    serverInstanceId: 'server-1',
    providerRequestId: 7,
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: {
      startedAtMs: 1,
      command: 'npm test',
      cwd: '/tmp/worktree'
    },
    allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-06-22T00:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    requestedAt: '2026-06-22T00:00:00.000Z',
    ...overrides,
    runtimeId: overrides.runtimeId ?? 'codex'
  };
}
