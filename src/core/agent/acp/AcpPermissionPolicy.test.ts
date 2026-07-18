import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionRecord, RunRecord } from '../../../shared/contracts';
import { materializeAcpPermission } from './AcpPermissionPolicy';
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
    expect(policy.allowedActions).toEqual(['DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('commit, publication, merge');
  });

  it('offers only one-time approval when an execution request omits its command', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-2', kind: 'execute', title: 'Do something' },
      options,
      session,
      run,
      allowOpaqueExecuteOnce: true
    });
    expect(policy.allowedActions).toEqual([
      'ACCEPT',
      'DECLINE',
      'DECLINE_FOR_SESSION',
      'CANCEL'
    ]);
    expect(policy.warnings.join(' ')).toContain('verifiable command');
  });

  it('fails closed for opaque execution outside an explicitly attested profile', async () => {
    const { session, run } = await ownership();
    const policy = materializeAcpPermission({
      toolCall: { toolCallId: 'tool-opaque', kind: 'execute', title: 'Do something' },
      options,
      session,
      run
    });
    expect(policy.allowedActions).toEqual(['DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL']);
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
    expect(policy.allowedActions).toEqual(['DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL']);
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
      { id: 'yes-once', label: 'Allow', kind: 'allow_once' },
      { id: 'no-once', label: 'Reject', kind: 'reject_once' }
    ]);
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
    expect(policy.allowedActions).toEqual(['DECLINE', 'DECLINE_FOR_SESSION', 'CANCEL']);
    expect(policy.warnings.join(' ')).toContain('does not allow command network access');
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
