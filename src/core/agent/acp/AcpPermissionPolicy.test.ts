import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionRecord, RunRecord } from '../../../shared/contracts';
import {
  materializeAcpPermission,
  selectAutomaticAcpPermissionOption
} from './AcpPermissionPolicy';
import type { AcpPermissionOption } from './AcpProtocol';

const temporaryDirectories: string[] = [];
const options: AcpPermissionOption[] = [
  { optionId: 'yes-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'yes-always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'no-always', name: 'Never', kind: 'reject_always' }
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('ACP permission safety intersection', () => {
  it('blocks Task Monki-controlled Git delivery commands', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'execute',
        rawInput: { command: 'git push origin feature', cwd: session.worktreePath }
      },
      options,
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('commit, publication, merge');
  });

  it('keeps opaque execution and remembered choices behind explicit profile gates', async () => {
    const { session, run } = await ownership();
    const oneTime = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-2', kind: 'execute', title: 'Do something' },
      options,
      session,
      run,
      allowOpaqueExecutePermissions: true
    });
    const remembered = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-2', kind: 'execute', title: 'Do something' },
      options,
      session,
      run,
      allowOpaqueExecutePermissions: true,
      rememberedPermissionOwner: 'Cursor Agent'
    });
    expect(oneTime.allowedActions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
    expect(oneTime.request.providerOptions?.map((option) => option.id)).not.toContain(
      'yes-always'
    );
    expect(oneTime.request.providerOptions?.map((option) => option.id)).not.toContain(
      'no-always'
    );
    expect(remembered.allowedActions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
    expect(remembered.request.providerOptions).toContainEqual({
      id: 'yes-always',
      label: 'Always',
      action: 'ACCEPT',
      providerRemembersChoice: true
    });
    expect(remembered.warnings.join(' ')).toContain('verifiable command');
    expect(remembered.warnings.join(' ')).toContain(
      'Cursor Agent owns its scope, storage, lifetime, and revocation'
    );
  });

  it('fails closed for opaque execution outside an explicitly attested profile', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-opaque', kind: 'execute', title: 'Do something' },
      options,
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
  });

  it('rejects file scope outside the owned worktree', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: {
        toolCallId: 'tool-3',
        kind: 'edit',
        locations: [{ path: path.join(session.worktreePath, '..', 'outside.txt') }]
      },
      options,
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('outside the writable task boundary');
  });

  it('intersects safe file requests with the exact choices the agent offered', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: {
        toolCallId: 'tool-4',
        kind: 'edit',
        locations: [{ path: path.join(session.worktreePath, 'src', 'safe.ts') }]
      },
      options: [options[0]!, options[2]!],
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
    expect(policy.request.providerOptions).toEqual([
      {
        id: 'yes-once',
        label: 'Allow',
        action: 'ACCEPT',
        providerRemembersChoice: false
      },
      {
        id: 'no-once',
        label: 'Reject',
        action: 'DECLINE',
        providerRemembersChoice: false
      }
    ]);
  });

  it('exposes an exact provider-remembered command option when the profile enables it', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: {
        toolCallId: 'tool-remembered',
        kind: 'execute',
        rawInput: { command: 'npm test', cwd: session.worktreePath }
      },
      options,
      session,
      run,
      rememberedPermissionOwner: 'Cursor Agent'
    });

    expect(policy.allowedActions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
    expect(policy.request.providerOptions).toContainEqual({
      id: 'yes-always',
      label: 'Always',
      action: 'ACCEPT',
      providerRemembersChoice: true
    });
    expect(policy.warnings.join(' ')).toContain(
      'Cursor Agent owns its scope, storage, lifetime, and revocation'
    );
  });

  it('exposes an exact remembered option for a verified file mutation only when enabled', async () => {
    const { session, run } = await ownership();
    const filePath = path.join(session.worktreePath, 'src', 'safe.ts');
    const enabled = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-file', kind: 'edit', locations: [{ path: filePath }] },
      options,
      session,
      run,
      rememberedPermissionOwner: 'Cursor Agent'
    });
    const disabled = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-file', kind: 'edit', locations: [{ path: filePath }] },
      options,
      session,
      run
    });

    expect(enabled.request.providerOptions?.map((option) => option.id)).toContain(
      'yes-always'
    );
    expect(disabled.request.providerOptions?.map((option) => option.id)).not.toContain(
      'yes-always'
    );
  });

  it('blocks network tool approval when the task policy disables network', async () => {
    const { session, run } = await ownership(false);
    const policy = materializeAcpPermission({
      toolCall: {
        toolCallId: 'tool-5',
        kind: 'fetch',
        rawInput: { url: 'https://example.com/data' }
      },
      options,
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['DECLINE', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('does not allow command network access');
  });
});

describe('ACP automatic permission selection', () => {
  it('does not select an option for ask-for-approval access', async () => {
    const { session, run } = await ownership();
    const toolCall = {
      toolCallId: 'tool-ask-for-approval',
      kind: 'edit' as const,
      locations: [{ path: path.join(session.worktreePath, 'src', 'safe.ts') }]
    };
    const materialized = materializeAcpPermission({ toolCall, options, session, run });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'on-request',
        toolCall,
        options,
        materialized
      })
    ).toBeUndefined();
  });

  it('auto-accepts only a locally verified file mutation with the exact one-time option', async () => {
    const { session, run } = await ownership();
    const safeToolCall = {
      toolCallId: 'tool-safe',
      kind: 'move' as const,
      locations: [{ path: path.join(session.worktreePath, 'src', 'safe.ts') }]
    };
    const unsafeToolCall = {
      toolCallId: 'tool-unsafe',
      kind: 'move' as const,
      locations: [{ path: path.join(session.worktreePath, '..', 'outside.ts') }]
    };

    const safe = materializeAcpPermission({
      toolCall: safeToolCall,
      options,
      session,
      run
    });
    const unsafe = materializeAcpPermission({
      toolCall: unsafeToolCall,
      options,
      session,
      run
    });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'auto-accept-edits',
        toolCall: safeToolCall,
        options,
        materialized: safe
      })
    ).toBe(options[0]);
    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'auto-accept-edits',
        toolCall: unsafeToolCall,
        options,
        materialized: unsafe
      })
    ).toBeUndefined();
  });

  it('does not auto-accept commands in auto-accept-edits mode', async () => {
    const { session, run } = await ownership();
    const toolCall = {
      toolCallId: 'tool-command',
      kind: 'execute' as const,
      rawInput: { command: 'npm test', cwd: session.worktreePath }
    };
    const materialized = materializeAcpPermission({ toolCall, options, session, run });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'auto-accept-edits',
        toolCall,
        options,
        materialized
      })
    ).toBeUndefined();
  });

  it('uses a one-time full-access approval and never falls back to a remembered option', async () => {
    const { session, run } = await ownership();
    const toolCall = { toolCallId: 'tool-full', kind: 'execute' as const };
    const materialized = materializeAcpPermission({
      toolCall,
      options,
      session,
      run,
      allowOpaqueExecutePermissions: true,
      rememberedPermissionOwner: 'Cursor Agent'
    });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'never',
        toolCall,
        options,
        materialized
      })
    ).toBe(options[0]);
    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'never',
        toolCall,
        options: [options[1]!, options[2]!],
        materialized
      })
    ).toBeUndefined();

    const outsideMutation = {
      toolCallId: 'tool-full-outside',
      kind: 'edit' as const,
      locations: [{ path: path.join(session.worktreePath, '..', 'outside.ts') }]
    };
    const blocked = materializeAcpPermission({
      toolCall: outsideMutation,
      options,
      session,
      run,
      rememberedPermissionOwner: 'Cursor Agent'
    });
    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'never',
        toolCall: outsideMutation,
        options,
        materialized: blocked
      })
    ).toBeUndefined();
  });

  it('leaves ambiguous positive provider choices for explicit user selection', async () => {
    const { session, run } = await ownership();
    const toolCall = {
      toolCallId: 'tool-ambiguous',
      kind: 'edit' as const,
      locations: [{ path: path.join(session.worktreePath, 'src', 'safe.ts') }]
    };
    const duplicateOneTime = [
      options[0]!,
      { optionId: 'yes-once-other', name: 'Allow this edit', kind: 'allow_once' as const },
      options[2]!
    ];
    const oneTimePolicy = materializeAcpPermission({
      toolCall,
      options: duplicateOneTime,
      session,
      run
    });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'auto-accept-edits',
        toolCall,
        options: duplicateOneTime,
        materialized: oneTimePolicy
      })
    ).toBeUndefined();

    const duplicateRemembered = [
      options[1]!,
      { optionId: 'yes-always-other', name: 'Remember this edit', kind: 'allow_always' as const },
      options[2]!
    ];
    const rememberedPolicy = materializeAcpPermission({
      toolCall,
      options: duplicateRemembered,
      session,
      run,
      rememberedPermissionOwner: 'Cursor Agent'
    });

    expect(
      selectAutomaticAcpPermissionOption({
        approvalPolicy: 'never',
        toolCall,
        options: duplicateRemembered,
        materialized: rememberedPolicy
      })
    ).toBeUndefined();
  });
});

async function ownership(networkAccess = true) {
  const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-policy-'));
  temporaryDirectories.push(worktreePath);
  const session = {
    id: 'session-local',
    runtimeId: 'grok-acp',
    worktreePath
  } as AgentSessionRecord;
  const run = {
    id: 'run-1',
    runtimeId: 'grok-acp',
    requestedSettings: { networkAccess }
  } as RunRecord;
  return { session, run };
}
