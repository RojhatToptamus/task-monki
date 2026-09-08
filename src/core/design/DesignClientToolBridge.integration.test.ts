import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord
} from '../../shared/agentRuntime';
import {
  REDACTED_CREDENTIAL,
  redactCredentialValue
} from '../agent/AgentCredentialRedaction';
import {
  DesignClientToolBridge,
  resolveDesignToolMcpServerPath,
  type DesignClientToolHandler,
  type DesignClientToolAuthority
} from './DesignClientToolBridge';

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const bridges: DesignClientToolBridge[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('DesignClientToolBridge', () => {
  it('delivers the shared tool and its bounded image through the packaged stdio contract', async () => {
    const scratchRoot = await temporaryDirectory();
    const staleGrant = path.join(scratchRoot, 'grant-stale');
    await fs.mkdir(staleGrant);
    await fs.writeFile(path.join(staleGrant, 'turn-grant'), 'stale');
    const authority = designAuthority();
    const state = runtimeState(authority);
    const handler = vi.fn(async () => ({
      text: 'The card uses a violet border.',
      image: {
        mimeType: 'image/png' as const,
        bytes: Buffer.from('real-png-evidence'),
        width: 320,
        height: 240
      }
    }));
    const bridge = createBridge(scratchRoot, state, handler);
    await bridge.recover();
    await expect(fs.stat(staleGrant)).rejects.toMatchObject({ code: 'ENOENT' });
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    expect(redactCredentialValue(grant.launch.environment)).toMatchObject({
      TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL: REDACTED_CREDENTIAL,
      TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE: REDACTED_CREDENTIAL
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    const mcp = startMcp(grant.launch);

    expect(
      (await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      })).result
    ).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} }
    });
    const listed = await mcp.request('tools/list', {});
    expect(listed.result.tools).toHaveLength(1);
    expect(listed.result.tools[0]).toMatchObject({
      name: 'inspect_design',
      inputSchema: { required: ['operation'], additionalProperties: false }
    });

    const result = await mcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    expect(result.result).toEqual({
      content: [
        { type: 'text', text: 'The card uses a violet border.' },
        {
          type: 'image',
          data: Buffer.from('real-png-evidence').toString('base64'),
          mimeType: 'image/png'
        }
      ]
    });
    expect(handler).toHaveBeenCalledWith({
      runId: authority.runId,
      operation: { operation: 'observe' }
    });

    await mcp.close();
  });

  it('rejects missing durable grants and removes temporary credentials on release', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    const handler = vi.fn(async () => ({ text: 'should not run' }));
    const bridge = createBridge(scratchRoot, state, handler);
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    state.run.clientToolGrants = [];
    const mcp = startMcp(grant.launch);

    const denied = await mcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain('current active Design Run');
    expect(handler).not.toHaveBeenCalled();

    await expect(
      bridge.activateGrant({
        grantId: grant.id,
        authority: { ...authority, providerGeneration: 'stale-generation' }
      })
    ).rejects.toThrow('does not own this runtime session');
    await bridge.releaseSessionGrant(grant.id);
    expect(await fs.readdir(scratchRoot)).toEqual([]);

    const released = await mcp.request('tools/list', {});
    expect(released.error).toMatchObject({ code: -32603 });
    await mcp.close();
  });

  it.runIf(process.platform !== 'win32')(
    'keeps failed session cleanup retryable after it revokes provider access',
    async () => {
      const scratchRoot = await temporaryDirectory();
      const authority = designAuthority();
      const state = runtimeState(authority);
      const bridge = createBridge(
        scratchRoot,
        state,
        vi.fn(async () => ({ text: 'must not run' }))
      );
      const grant = await bridge.createSessionGrant({
        runtimeId: authority.runtimeId,
        sessionId: authority.sessionId,
        worktreeId: authority.worktreeId,
        providerGeneration: authority.providerGeneration
      });
      const mcp = startMcp(grant.launch);
      await fs.chmod(scratchRoot, 0o500);

      await expect(bridge.releaseSessionGrant(grant.id)).rejects.toThrow();
      await expect(mcp.request('tools/list', {})).resolves.toMatchObject({
        error: { code: -32603 }
      });

      await fs.chmod(scratchRoot, 0o700);
      await bridge.releaseSessionGrant(grant.id);
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      await mcp.close();
    }
  );

  it('blocks a revoked turn without replacing the provider MCP process', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    const handler = vi.fn(async () => ({ text: 'observed' }));
    const bridge = createBridge(scratchRoot, state, handler);
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    const mcp = startMcp(grant.launch);
    await bridge.revokeGrant(grant.id);

    const result = await mcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('current active Design Run');
    expect(handler).not.toHaveBeenCalled();
    expect((await mcp.request('tools/list', {})).result.tools[0].name).toBe(
      'inspect_design'
    );
    await mcp.close();
  });

  it('does not revoke a new Run while stale authorization is in flight', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    let releaseAuthorization!: () => void;
    const authorizationPaused = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let oldRunReadStarted = false;
    const handler = vi.fn(async () => ({ text: 'new run observed' }));
    const bridge = new DesignClientToolBridge({
      executablePath: process.execPath,
      serverPath: path.resolve('src/core/design/runtime/design-tool-mcp-server.mjs'),
      scratchRoot,
      handler,
      runtimeStore: {
        getSession: async (id) =>
          id === state.session.id ? state.session : undefined,
        getActiveRunForSession: async (id) => {
          if (id === authority.sessionId && !oldRunReadStarted) {
            oldRunReadStarted = true;
            await authorizationPaused;
            return undefined;
          }
          return id === state.session.id && !isTerminal(state.run.status)
            ? state.run
            : undefined;
        }
      }
    });
    bridges.push(bridge);
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    const mcp = startMcp(grant.launch);

    const stale = mcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    await vi.waitFor(() => expect(oldRunReadStarted).toBe(true));
    const nextAuthority = { ...authority, runId: 'run-2' };
    state.run = { ...state.run, id: nextAuthority.runId, status: 'RUNNING' };
    await bridge.activateGrant({ grantId: grant.id, authority: nextAuthority });
    releaseAuthorization();

    await expect(stale).resolves.toMatchObject({
      result: { isError: true }
    });
    await expect(
      mcp.request('tools/call', {
        name: 'inspect_design',
        arguments: { operation: 'observe' }
      })
    ).resolves.toMatchObject({
      result: { content: [{ type: 'text', text: 'new run observed' }] }
    });
    expect(handler).toHaveBeenCalledOnce();
    await mcp.close();
  });

  it('does not return an in-flight result or revoke the next Design Run grant', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    let completeHandler!: (result: { text: string }) => void;
    const handler = vi
      .fn<DesignClientToolHandler>()
      .mockImplementationOnce(
        () => new Promise<{ text: string }>((resolve) => {
          completeHandler = resolve;
        })
      )
      .mockResolvedValue({ text: 'next run observed' });
    const bridge = createBridge(scratchRoot, state, handler);
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    const mcp = startMcp(grant.launch);
    const concurrentMcp = startMcp(grant.launch);

    const pending = mcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    state.run.status = 'INTERRUPTED';
    const nextAuthority = { ...authority, runId: 'run-2' };
    state.run = {
      ...state.run,
      id: nextAuthority.runId,
      status: 'RUNNING'
    };
    await bridge.activateGrant({ grantId: grant.id, authority: nextAuthority });
    await expect(
      concurrentMcp.request('tools/call', {
        name: 'inspect_design',
        arguments: { operation: 'observe' }
      })
    ).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          { type: 'text', text: expect.stringContaining('still running') }
        ]
      }
    });
    completeHandler({ text: 'must not be delivered' });

    await expect(pending).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          { type: 'text', text: expect.stringContaining('ended before the operation completed') }
        ]
      }
    });
    await expect(
      mcp.request('tools/call', {
        name: 'inspect_design',
        arguments: { operation: 'observe' }
      })
    ).resolves.toMatchObject({
      result: {
        content: [{ type: 'text', text: 'next run observed' }]
      }
    });
    await mcp.close();
    await concurrentMcp.close();
  });

  it('allows only one concurrent operation to pass durable authorization', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    let authorizationReads = 0;
    let releaseAuthorization!: () => void;
    const authorizationPaused = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const handler = vi.fn(async () => ({ text: 'observed once' }));
    const bridge = new DesignClientToolBridge({
      executablePath: process.execPath,
      serverPath: path.resolve('src/core/design/runtime/design-tool-mcp-server.mjs'),
      scratchRoot,
      handler,
      runtimeStore: {
        getSession: async (id) =>
          id === state.session.id ? state.session : undefined,
        getActiveRunForSession: async (id) => {
          authorizationReads += 1;
          await authorizationPaused;
          return id === state.session.id ? state.run : undefined;
        }
      }
    });
    bridges.push(bridge);
    const grant = await bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await bridge.activateGrant({ grantId: grant.id, authority });
    const firstMcp = startMcp(grant.launch);
    const secondMcp = startMcp(grant.launch);

    const first = firstMcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    await vi.waitFor(() => expect(authorizationReads).toBe(1));
    const second = secondMcp.request('tools/call', {
      name: 'inspect_design',
      arguments: { operation: 'observe' }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const readsBeforeRelease = authorizationReads;
    releaseAuthorization();

    const results = await Promise.all([first, second]);
    expect(readsBeforeRelease).toBe(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: { content: [{ type: 'text', text: 'observed once' }] }
        }),
        expect.objectContaining({
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: expect.stringContaining('still running')
              }
            ]
          }
        })
      ])
    );
    expect(handler).toHaveBeenCalledOnce();
    await firstMcp.close();
    await secondMcp.close();
  });

  it('discards a session grant that finishes allocating after shutdown', async () => {
    const scratchRoot = await temporaryDirectory();
    const authority = designAuthority();
    const state = runtimeState(authority);
    const bridge = createBridge(
      scratchRoot,
      state,
      vi.fn(async () => ({ text: 'must not run' }))
    );
    const realMkdtemp = fs.mkdtemp.bind(fs);
    let allocationStarted = false;
    let releaseAllocation!: () => void;
    const allocationPaused = new Promise<void>((resolve) => {
      releaseAllocation = resolve;
    });
    vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (prefix, options) => {
      allocationStarted = true;
      await allocationPaused;
      return realMkdtemp(prefix, options);
    });

    const creating = bridge.createSessionGrant({
      runtimeId: authority.runtimeId,
      sessionId: authority.sessionId,
      worktreeId: authority.worktreeId,
      providerGeneration: authority.providerGeneration
    });
    await vi.waitFor(() => expect(allocationStarted).toBe(true));
    await bridge.shutdown();
    releaseAllocation();

    await expect(creating).rejects.toThrow('bridge is shutting down');
    expect(await fs.readdir(scratchRoot)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'closes its listener even when temporary credential cleanup fails',
    async () => {
      const scratchRoot = await temporaryDirectory();
      const authority = designAuthority();
      const state = runtimeState(authority);
      const bridge = createBridge(
        scratchRoot,
        state,
        vi.fn(async () => ({ text: 'observed' }))
      );
      const grant = await bridge.createSessionGrant({
        runtimeId: authority.runtimeId,
        sessionId: authority.sessionId,
        worktreeId: authority.worktreeId,
        providerGeneration: authority.providerGeneration
      });
      const mcp = startMcp(grant.launch);
      await fs.chmod(scratchRoot, 0o500);

      await expect(bridge.shutdown()).rejects.toThrow(
        'Design client-tool bridge cleanup failed'
      );
      await expect(mcp.request('tools/list', {})).resolves.toMatchObject({
        error: { code: -32603 }
      });

      await fs.chmod(scratchRoot, 0o700);
      const index = bridges.indexOf(bridge);
      if (index >= 0) bridges.splice(index, 1);
      await mcp.close();
    }
  );
});

describe('resolveDesignToolMcpServerPath', () => {
  it('selects the unpacked resource in a packaged app', () => {
    expect(
      resolveDesignToolMcpServerPath({
        isPackaged: true,
        resourcesPath: '/app/Contents/Resources',
        appPath: '/project'
      })
    ).toBe('/app/Contents/Resources/design-tool-mcp-server.mjs');
  });

  it('selects the source resource in development', () => {
    expect(
      resolveDesignToolMcpServerPath({
        isPackaged: false,
        resourcesPath: '/resources',
        appPath: '/project'
      })
    ).toBe('/project/src/core/design/runtime/design-tool-mcp-server.mjs');
  });
});

function createBridge(
  scratchRoot: string,
  state: ReturnType<typeof runtimeState>,
  handler: DesignClientToolHandler
): DesignClientToolBridge {
  const bridge = new DesignClientToolBridge({
    executablePath: process.execPath,
    serverPath: path.resolve('src/core/design/runtime/design-tool-mcp-server.mjs'),
    scratchRoot,
    handler,
    runtimeStore: {
      getSession: async (id) => (id === state.session.id ? state.session : undefined),
      getActiveRunForSession: async (id) =>
        id === state.session.id && !isTerminal(state.run.status) ? state.run : undefined
    }
  });
  bridges.push(bridge);
  return bridge;
}

function designAuthority(): DesignClientToolAuthority {
  return {
    runtimeId: 'opencode',
    sessionId: 'session-1',
    runId: 'run-1',
    worktreeId: 'worktree-1',
    providerGeneration: 'server-1'
  };
}

function runtimeState(authority: DesignClientToolAuthority): {
  run: AgentRuntimeRunRecord;
  session: AgentRuntimeSessionRecord;
} {
  return {
    run: {
      id: authority.runId,
      owner: { kind: 'TASK', taskId: 'task-1' },
      scope: {
        kind: 'TASK',
        taskId: 'task-1',
        iterationId: 'iteration-1',
        worktreeId: authority.worktreeId
      },
      sessionId: authority.sessionId,
      purpose: 'TASK_DESIGN',
      status: 'RUNNING',
      serverInstanceId: authority.providerGeneration,
      clientToolGrants: ['inspect_design']
    } as AgentRuntimeRunRecord,
    session: {
      id: authority.sessionId,
      runtimeId: authority.runtimeId,
      taskContext: {
        iterationId: 'iteration-1',
        worktreeId: authority.worktreeId,
        worktreePath: '/worktree'
      }
    } as AgentRuntimeSessionRecord
  };
}

function startMcp(launch: {
  executablePath: string;
  argv: string[];
  environment: Record<string, string>;
}) {
  const child = spawn(launch.executablePath, launch.argv, {
    env: { ...process.env, ...launch.environment },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  children.push(child);
  let nextId = 0;
  let output = '';
  const pending = new Map<number, (value: any) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline === -1) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  return {
    request(method: string, params: unknown): Promise<any> {
      const id = ++nextId;
      const response = new Promise<any>((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    async close(): Promise<void> {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
    }
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-design-tool-test-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

function isTerminal(status: AgentRuntimeRunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}
