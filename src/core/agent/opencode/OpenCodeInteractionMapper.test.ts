import { describe, expect, it } from 'vitest';
import {
  mapOpenCodeInteractionResponse,
  mapOpenCodePermission,
  mapOpenCodeQuestion,
  openCodePermissionRules
} from './OpenCodeInteractionMapper';

describe('OpenCodeInteractionMapper', () => {
  it('keeps mutation tools gated and blocks external-directory escape', () => {
    const rules = openCodePermissionRules({
      runtimeId: 'opencode',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: true
    });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'ask' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'ask' });
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny'
    });
    expect(rules).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'allow' });
    expect(() =>
      openCodePermissionRules({
        runtimeId: 'opencode',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false
      })
    ).toThrow('cannot attest network-disabled execution');
  });

  it('fails closed for read-only and never-approval execution', () => {
    const rules = openCodePermissionRules({
      sandbox: 'READ_ONLY',
      approvalPolicy: 'never',
      networkAccess: true
    });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'deny' });
    expect(() =>
      openCodePermissionRules({
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'never',
        networkAccess: true
      })
    ).toThrow('cannot safely honor approvalPolicy "never"');
  });

  it('only allows mutation tools for explicit danger-full-access settings', () => {
    const rules = openCodePermissionRules({
      sandbox: 'DANGER_FULL_ACCESS',
      approvalPolicy: 'never',
      networkAccess: true
    });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'allow'
    });
    expect(() =>
      openCodePermissionRules({
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never',
        networkAccess: false
      })
    ).toThrow('cannot attest network-disabled execution');
    expect(() =>
      openCodePermissionRules({
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request',
        networkAccess: true
      })
    ).toThrow('only represent full access');
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
  });

  it('keeps question answer ordering stable for the native reply endpoint', () => {
    const mapped = mapOpenCodeQuestion({
      id: 'que_1',
      sessionID: 'ses_1',
      questions: [
        { header: 'A', question: 'First?', options: [], custom: true },
        { header: 'B', question: 'Second?', options: [] }
      ]
    });
    expect(mapped.request).toEqual({
      questions: [
        expect.objectContaining({ id: 'que_1:0', isOther: true }),
        expect.objectContaining({ id: 'que_1:1', isOther: false })
      ]
    });
    expect(
      mapOpenCodeInteractionResponse(
        {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: { 'que_1:1': ['two'], 'que_1:0': ['one'] }
        },
        mapped.request
      )
    ).toEqual({ path: 'question', body: { answers: [['one'], ['two']] } });
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
