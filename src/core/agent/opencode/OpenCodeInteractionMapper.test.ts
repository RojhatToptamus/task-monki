import { describe, expect, it } from 'vitest';
import {
  mapOpenCodeInteractionResponse,
  mapOpenCodePermission,
  mapOpenCodeQuestion,
  openCodePermissionRules,
  openCodeReadOnlyPermissionRules,
  openCodePermissionRulesEndWith
} from './OpenCodeInteractionMapper';

describe('OpenCodeInteractionMapper', () => {
  it('uses one deny-by-default suffix for provider-native read-only turns', () => {
    const rules = openCodeReadOnlyPermissionRules();

    expect(rules).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'list', pattern: '*', action: 'allow' },
      { permission: 'lsp', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'websearch', pattern: '*', action: 'deny' }
    ]);
    expect(openCodePermissionRulesEndWith(rules, rules)).toBe(true);
  });

  it('keeps mutation and external-directory tools approval-gated without claiming confinement', () => {
    const rules = openCodePermissionRules({
      runtimeId: 'opencode',
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'on-request',
      networkAccess: true
    });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'ask' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'ask' });
    expect(rules).toContainEqual({ permission: 'task', pattern: '*', action: 'deny' });
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'ask'
    });
    expect(rules).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'allow' });
    expect(() =>
      openCodePermissionRules({
        runtimeId: 'opencode',
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request',
        networkAccess: false
      })
    ).toThrow('cannot attest network-disabled execution');
  });

  it('fails closed for settings that falsely claim a Task Monki sandbox', () => {
    expect(() =>
      openCodePermissionRules({
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'on-request',
        networkAccess: true
      })
    ).toThrow('cannot attest Task Monki');
    expect(() =>
      openCodePermissionRules({
        sandbox: 'READ_ONLY',
        approvalPolicy: 'never',
        networkAccess: true
      })
    ).toThrow('cannot attest Task Monki');
  });

  it('only allows mutation tools for explicit danger-full-access settings', () => {
    const rules = openCodePermissionRules({
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'never',
      networkAccess: true
    });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'task', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'allow'
    });
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' });
    expect(rules.some((rule) => rule.action === 'ask')).toBe(false);
    expect(() =>
      openCodePermissionRules({
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never',
        networkAccess: false
      })
    ).toThrow('cannot attest network-disabled execution');
    const approvalRules = openCodePermissionRules({
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'on-request',
      networkAccess: true
    });
    expect(approvalRules).toContainEqual({
      permission: 'edit',
      pattern: '*',
      action: 'ask'
    });
  });

  it('attests only the effective native permission suffix', () => {
    const desired = openCodePermissionRules({
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'on-request',
      networkAccess: true
    });
    expect(openCodePermissionRulesEndWith(desired, desired)).toBe(true);
    expect(openCodePermissionRulesEndWith([
      { permission: 'edit', pattern: '*', action: 'allow' },
      ...desired
    ], desired)).toBe(true);
    expect(openCodePermissionRulesEndWith([
      ...desired,
      { permission: 'edit', pattern: '*', action: 'allow' }
    ], desired)).toBe(false);
  });

  it('maps command and file permissions with reviewable native context', () => {
    expect(
      mapOpenCodePermission(
        {
          id: 'per_1',
          sessionID: 'ses_1',
          action: 'bash',
          resources: ['npm test'],
          metadata: { cwd: '/repo' }
        },
        '/repo'
      )
    ).toEqual(
      expect.objectContaining({
        type: 'COMMAND_APPROVAL',
        request: expect.objectContaining({ command: 'npm test', cwd: '/repo' })
      })
    );
    expect(
      mapOpenCodePermission(
        {
          id: 'per_2',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['src/app.ts']
        },
        '/repo'
      )
    ).toEqual(
      expect.objectContaining({
        type: 'FILE_CHANGE_APPROVAL',
        providerItemPayload: { changes: [{ path: 'src/app.ts', kind: 'edit', diff: '' }] }
      })
    );
    expect(
      mapOpenCodePermission(
        {
          id: 'per_3',
          sessionID: 'ses_1',
          permission: 'external_directory',
          patterns: ['/outside/repo']
        },
        '/repo'
      )
    ).toEqual(
      expect.objectContaining({
        type: 'PERMISSION_APPROVAL',
        request: expect.objectContaining({
          permissions: {
            fileSystem: {
              entries: [{ path: { path: '/outside/repo' }, access: 'write' }]
            }
          }
        })
      })
    );
  });

  it('uses nonempty native patterns when resources cannot identify a command', () => {
    expect(
      mapOpenCodePermission(
        {
          id: 'per_pattern',
          sessionID: 'ses_1',
          action: 'bash',
          resources: ['   '],
          patterns: ['npm test']
        },
        '/repo'
      )
    ).toEqual(
      expect.objectContaining({
        type: 'COMMAND_APPROVAL',
        request: expect.objectContaining({ command: 'npm test' })
      })
    );

    expect(
      mapOpenCodePermission(
        {
          id: 'per_empty',
          sessionID: 'ses_1',
          action: 'bash',
          resources: [42 as unknown as string]
        },
        '/repo'
      ).request
    ).not.toHaveProperty('command');
  });

  it('keeps question answer ordering stable for the native reply endpoint', () => {
    const mapped = mapOpenCodeQuestion({
      id: 'que_1',
      sessionID: 'ses_1',
      questions: [
        { header: 'A', question: 'First?', options: [], custom: true },
        { header: 'B', question: 'Second?', options: [] },
        { header: 'C', question: 'Third?', options: [], custom: false }
      ]
    });
    expect(mapped.request).toEqual({
      questions: [
        expect.objectContaining({ id: 'que_1:0', isOther: true }),
        expect.objectContaining({ id: 'que_1:1', isOther: true }),
        expect.objectContaining({ id: 'que_1:2', isOther: false })
      ]
    });
    expect(
      mapOpenCodeInteractionResponse(
        {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: {
            'que_1:2': ['three'],
            'que_1:1': ['two'],
            'que_1:0': ['one']
          }
        },
        mapped.request
      )
    ).toEqual({
      path: 'question',
      body: { answers: [['one'], ['two'], ['three']] }
    });
  });

  it('preserves native multiple-choice and custom-answer semantics', () => {
    const mapped = mapOpenCodeQuestion({
      id: 'que_multiple',
      sessionID: 'ses_1',
      questions: [
        {
          header: 'Checks',
          question: 'Which checks should run?',
          multiple: true,
          custom: true,
          options: [
            { label: 'Unit', description: 'Run unit tests' },
            { label: 'Build', description: 'Build the app' }
          ]
        }
      ]
    });

    expect(mapped.request).toEqual({
      questions: [
        {
          id: 'que_multiple:0',
          header: 'Checks',
          question: 'Which checks should run?',
          isOther: true,
          isSecret: false,
          allowsMultiple: true,
          options: [
            { label: 'Unit', description: 'Run unit tests' },
            { label: 'Build', description: 'Build the app' }
          ]
        }
      ]
    });
    expect(
      mapOpenCodeInteractionResponse(
        {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: { 'que_multiple:0': ['Unit', 'A focused smoke test'] }
        },
        mapped.request
      )
    ).toEqual({
      path: 'question',
      body: { answers: [['Unit', 'A focused smoke test']] }
    });
  });

  it('maps only per-request native permission replies', () => {
    const mapped = mapOpenCodePermission(
      {
        id: 'per_reply',
        sessionID: 'ses_1',
        action: 'bash',
        resources: ['npm test']
      },
      '/repo'
    );
    expect(
      mapOpenCodeInteractionResponse(
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' },
        mapped.request
      )
    ).toEqual({ path: 'permission', body: { reply: 'once' } });
    expect(
      mapOpenCodeInteractionResponse(
        { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' },
        mapped.request
      )
    ).toEqual({ path: 'permission', body: { reply: 'reject' } });
    expect(() =>
      mapOpenCodeInteractionResponse(
        { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT_FOR_SESSION' },
        mapped.request
      )
    ).toThrow('does not expose a session-scoped permission reply');
  });

  it('fails closed for questions that may contain credentials', () => {
    const mapped = mapOpenCodeQuestion({
      id: 'que_secret',
      sessionID: 'ses_1',
      questions: [
        { header: 'API key', question: 'Paste the provider credential', options: [] }
      ]
    });

    expect(mapped.request).toEqual({
      questions: [expect.objectContaining({ isSecret: true })]
    });
  });
});
