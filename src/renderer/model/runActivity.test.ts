import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { buildRunActivityProjection } from './runActivity';

describe('run activity projection', () => {
  it('groups consecutive context reads and keeps the group key stable when appended', () => {
    const run = runFixture();
    const firstTwo = [
      readItem(
        'read-a',
        '/Users/rojhat/project/src/a.ts',
        '2026-07-07T10:01:00.000Z',
        'run-1',
        '/Users/rojhat/project'
      ),
      readItem(
        'read-b',
        '/Users/rojhat/project/src/b.ts',
        '2026-07-07T10:02:00.000Z',
        'run-1',
        '/Users/rojhat/project'
      )
    ];
    const projection = buildRunActivityProjection({ run, items: firstTwo });
    const appended = buildRunActivityProjection({
      run,
      items: [
        ...firstTwo,
        readItem(
          'read-c',
          '/Users/rojhat/project/src/c.ts',
          '2026-07-07T10:03:00.000Z',
          'run-1',
          '/Users/rojhat/project'
        )
      ]
    });

    expect(projection.rows).toMatchObject([
      {
        key: projection.rows[0]?.key,
        category: 'read',
        label: 'Read',
        detail: '2 files',
        grouped: true,
        children: [
          { label: 'Read', detail: 'src/a.ts' },
          { label: 'Read', detail: 'src/b.ts' }
        ]
      }
    ]);
    expect(appended.rows[0]?.key).toBe(projection.rows[0]?.key);
    expect(appended.rows[0]).toMatchObject({
      detail: '3 files',
      children: [
        { detail: 'src/a.ts' },
        { detail: 'src/b.ts' },
        { detail: 'src/c.ts' }
      ]
    });
  });

  it('groups consecutive searches and directory listings separately', () => {
    const run = runFixture();
    const projection = buildRunActivityProjection({
      run,
      items: [
        commandItem({
          id: 'context',
          payload: {
            command: 'rg RunActivity src && rg ProviderActivityPanel src && ls src/renderer',
            commandActions: [
              { type: 'search', query: 'RunActivity', path: 'src' },
              { type: 'search', query: 'ProviderActivityPanel', path: 'src' },
              { type: 'listFiles', path: 'src/renderer' },
              { type: 'listFiles', path: 'src/shared' }
            ]
          }
        })
      ]
    });

    expect(projection.rows).toMatchObject([
      {
        category: 'search',
        label: 'Searched',
        detail: '2 times',
        children: [
          { detail: 'RunActivity · src' },
          { detail: 'ProviderActivityPanel · src' }
        ]
      },
      {
        category: 'list',
        label: 'Listed',
        detail: '2 directories',
        children: [
          { detail: 'src/renderer' },
          { detail: 'src/shared' }
        ]
      }
    ]);
  });

  it('sanitizes verification commands and excludes raw output from overview rows', () => {
    const run = runFixture();
    const projection = buildRunActivityProjection({
      run,
      items: [
        commandItem({
          id: 'verify',
          payload: {
            command: "/bin/zsh -lc 'npm test -- --runInBand /Users/rojhat/project/src/renderer/model/runActivity.ts'",
            commandActions: [{ type: 'unknown' }],
            exitCode: 0,
            durationMs: 12_000,
            aggregatedOutput: 'secret output\nsecond line'
          }
        })
      ]
    });

    expect(projection.rows).toMatchObject([
      {
        category: 'verify',
        label: 'Verify',
        detail: 'npm test -- --runInBand src/renderer/model/runActivity.ts',
        metric: '0:12',
        tone: 'success'
      }
    ]);
    expect(projection.outputSummary).toBe('show full output · 2 lines');
    expect(JSON.stringify(projection.rows)).not.toContain('/bin/zsh');
    expect(JSON.stringify(projection.rows)).not.toContain('/Users/rojhat/project');
    expect(JSON.stringify(projection.rows)).not.toContain('secret output');
  });

  it('maps file changes to write, edit, and patch rows', () => {
    const run = runFixture();
    const projection = buildRunActivityProjection({
      run,
      items: [
        itemFixture({
          id: 'files',
          type: 'FILE_CHANGE',
          payload: {
            changes: [
              {
                path: 'src/new.ts',
                kind: { type: 'add' },
                diff: '+++ b/src/new.ts\n+one\n+two\n'
              },
              {
                path: 'src/existing.ts',
                kind: { type: 'update' },
                diff: '--- a/src/existing.ts\n+++ b/src/existing.ts\n-old\n+new\n'
              },
              {
                path: 'src/moved.ts',
                kind: { type: 'patch' },
                diff: '--- a/src/moved.ts\n+++ b/src/moved.ts\n-old\n+new\n+extra\n'
              }
            ]
          }
        })
      ]
    });

    expect(projection.rows).toMatchObject([
      { category: 'write', label: 'Write', detail: 'src/new.ts', metric: '+2' },
      { category: 'edit', label: 'Edit', detail: 'src/existing.ts', metric: '+1 -1' },
      { category: 'patch', label: 'Patch', detail: 'src/moved.ts', metric: '+2 -1' }
    ]);
    expect(projection.sections.find((section) => section.key === 'files')?.rows).toHaveLength(3);
  });

  it('categorizes subagent, MCP, dynamic tool, web, and compaction events', () => {
    const run = runFixture();
    const projection = buildRunActivityProjection({
      run,
      items: [
        itemFixture({
          id: 'mcp',
          type: 'MCP_TOOL_CALL',
          payload: { server: 'docs', tool: 'search' }
        }),
        itemFixture({
          id: 'dynamic',
          type: 'DYNAMIC_TOOL_CALL',
          payload: { namespace: 'multi-agent', tool: 'spawn' }
        }),
        itemFixture({
          id: 'search',
          type: 'OTHER',
          payload: {
            kind: 'search',
            title: 'Find tests',
            rawInput: { query: '*.test.ts', path: 'src' }
          }
        }),
        itemFixture({
          id: 'web',
          type: 'WEB_SEARCH',
          payload: {
            kind: 'fetch',
            title: 'Fetch ACP docs',
            rawInput: { url: 'https://agentclientprotocol.com/protocol/v1/tool-calls' }
          }
        }),
        itemFixture({
          id: 'compact',
          type: 'CONTEXT_COMPACTION',
          payload: {}
        }),
        itemFixture({
          id: 'subagent',
          type: 'SUBAGENT',
          payload: { tool: 'code-reviewer' }
        })
      ]
    });

    expect(projection.rows.map((row) => row.category)).toEqual([
      'mcp',
      'mcp',
      'search',
      'web',
      'compaction',
      'subagent'
    ]);
    expect(projection.sections.map((section) => section.key)).toEqual([
      'files',
      'tools',
      'subagents'
    ]);
    expect(projection.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'search', label: 'Search', detail: '*.test.ts' }),
        expect.objectContaining({
          category: 'web',
          label: 'Web',
          detail: 'https://agentclientprotocol.com/protocol/v1/tool-calls'
        })
      ])
    );
  });

  it('does not fabricate an actionable request from run status alone', () => {
    const projection = buildRunActivityProjection({
      run: runFixture({ status: 'AWAITING_APPROVAL' }),
      items: [],
      interactions: []
    });

    expect(projection.rows).toEqual([]);
  });

  it('maps permission and question interactions into request rows', () => {
    const run = runFixture({ status: 'AWAITING_USER_INPUT' });
    const projection = buildRunActivityProjection({
      run,
      items: [],
      interactions: [
        interactionFixture({
          id: 'approval',
          type: 'COMMAND_APPROVAL',
          request: { startedAtMs: 1, command: 'npm test' },
          status: 'RESOLVED',
          resolvedAt: '2026-07-07T10:02:00.000Z'
        }),
        interactionFixture({
          id: 'question',
          type: 'USER_INPUT',
          request: {
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Which files should be changed?',
                isOther: false,
                isSecret: false
              }
            ]
          },
          status: 'PENDING',
          requestedAt: '2026-07-07T10:03:00.000Z'
        })
      ]
    });

    expect(projection.rows).toMatchObject([
      {
        category: 'permission',
        label: 'Permission',
        detail: 'command approval',
        status: 'completed'
      },
      {
        category: 'question',
        label: 'Question',
        detail: 'Scope',
        status: 'active'
      }
    ]);
    expect(projection.sections.find((section) => section.key === 'requests')?.rows).toHaveLength(2);
  });

  it('excludes stale activity from previous runs', () => {
    const run = runFixture({ id: 'current' });
    const projection = buildRunActivityProjection({
      run,
      items: [
        readItem('old-read', 'src/old.ts', '2026-07-07T10:01:00.000Z', 'old-run'),
        readItem('current-read', 'src/current.ts', '2026-07-07T10:02:00.000Z', 'current')
      ]
    });

    expect(projection.rows).toMatchObject([
      {
        category: 'read',
        label: 'Read',
        detail: 'src/current.ts'
      }
    ]);
    expect(JSON.stringify(projection.rows)).not.toContain('old-read');
  });

  it('shortens Windows repository paths without disguising external paths', () => {
    const run = runFixture();
    const projection = buildRunActivityProjection({
      run,
      groupContext: false,
      items: [
        readItem(
          'repository-read',
          'C:\\Users\\runner\\project\\repo\\README.md',
          '2026-07-07T10:01:00.000Z',
          'run-1',
          'C:\\Users\\runner\\project\\repo'
        ),
        readItem(
          'external-read',
          'D:\\external\\src\\secrets.txt',
          '2026-07-07T10:02:00.000Z',
          'run-1',
          'C:\\Users\\runner\\project\\repo'
        )
      ]
    });

    expect(projection.rows).toMatchObject([
      { category: 'read', detail: 'README.md' },
      { category: 'read', detail: 'D:/external/src/secrets.txt' }
    ]);
  });
});

function readItem(
  id: string,
  path: string,
  at: string,
  runId = 'run-1',
  cwd?: string
): AgentItemRecord {
  return commandItem({
    id,
    runId,
    providerCompletedAt: at,
    payload: {
      command: `sed -n 1,10p ${path}`,
      commandActions: [{ type: 'read', path }],
      ...(cwd ? { cwd } : {})
    }
  });
}

function commandItem(
  overrides: Partial<AgentItemRecord> = {}
): AgentItemRecord {
  return itemFixture({
    type: 'COMMAND_EXECUTION',
    payload: { command: 'npm test', commandActions: [{ type: 'unknown' }] },
    ...overrides
  });
}

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
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
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 0,
    ...overrides
  };
}

function itemFixture(overrides: Partial<AgentItemRecord> = {}): AgentItemRecord {
  return {
    id: 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: overrides.id ?? 'provider-item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: { text: 'Progress: Working.' },
    rawMessage: rawMessageFixture(),
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    providerCompletedAt: '2026-07-07T10:01:00.000Z',
    ...overrides
  };
}

function interactionFixture(
  overrides: Partial<InteractionRequestRecord> = {}
): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    runtimeId: 'codex',
    serverInstanceId: 'server-1',
    providerRequestId: 'request-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: { startedAtMs: 1, command: 'npm test' },
    allowedActions: ['ACCEPT', 'DECLINE'],
    policyWarnings: [],
    requestRawMessage: rawMessageFixture(),
    requestedAt: '2026-07-07T10:01:00.000Z',
    ...overrides
  };
}

function rawMessageFixture() {
  return {
    serverInstanceId: 'server-1',
    sequence: 1,
    direction: 'INBOUND' as const,
    recordedAt: '2026-07-07T10:00:00.000Z',
    byteOffset: 0,
    byteLength: 1,
    sha256: 'hash'
  };
}
