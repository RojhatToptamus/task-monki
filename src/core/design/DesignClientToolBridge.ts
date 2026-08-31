import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { AgentRuntimeStore } from '../agent/AgentRuntimeStore';
import {
  parseInspectDesignOperation,
  type DesignBrowserToolResult,
  type InspectDesignOperation
} from './AgentBrowserRuntime';
import {
  designClientToolContent,
  INSPECT_DESIGN_TOOL_DEFINITION,
  safeDesignClientToolFailure
} from './DesignClientToolContract';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const SESSION_CREDENTIAL_ENV = 'TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL';
const ENDPOINT_ENV = 'TASK_MONKI_DESIGN_TOOL_ENDPOINT';
const GRANT_FILE_ENV = 'TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE';

export interface DesignClientToolSessionIdentity {
  runtimeId: string;
  sessionId: string;
  worktreeId: string;
  providerGeneration: string;
}

export interface DesignClientToolAuthority
  extends DesignClientToolSessionIdentity {
  runId: string;
}

export type DesignClientToolHandler = (input: {
  runId: string;
  operation: InspectDesignOperation;
}) => Promise<DesignBrowserToolResult>;

export interface DesignClientToolBridgeOptions {
  executablePath: string;
  serverPath: string;
  scratchRoot: string;
  handler: DesignClientToolHandler;
  runtimeStore: Pick<
    AgentRuntimeStore,
    'getSession' | 'getActiveRunForSession'
  >;
}

export interface DesignClientToolMcpLaunch {
  executablePath: string;
  argv: string[];
  environment: Record<string, string>;
}

export interface DesignClientToolSessionGrant {
  id: string;
  launch: DesignClientToolMcpLaunch;
}

interface ActiveGrant {
  authority: DesignClientToolAuthority;
  tokenHash: string;
}

interface StoredSessionGrant {
  id: string;
  identity: DesignClientToolSessionIdentity;
  sessionCredentialHash: string;
  rootPath: string;
  grantFilePath: string;
  active?: ActiveGrant;
  callInProgress: boolean;
}

interface BridgeRequest {
  method: 'definition' | 'call';
  arguments?: unknown;
}

interface BridgeResponse {
  ok: boolean;
  definition?: typeof INSPECT_DESIGN_TOOL_DEFINITION;
  content?: ReturnType<typeof designClientToolContent>;
  error?: string;
}

/**
 * Owns authenticated access from provider-launched MCP processes to the one
 * app-owned Design browser handler. It does not own browser or source state.
 */
export class DesignClientToolBridge {
  private readonly grants = new Map<string, StoredSessionGrant>();
  private readonly grantsBySessionCredential = new Map<string, StoredSessionGrant>();
  private readonly sockets = new Set<Socket>();
  private server?: http.Server;
  private endpoint?: string;
  private starting?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private recovered = false;

  constructor(private readonly options: DesignClientToolBridgeOptions) {}

  async recover(): Promise<void> {
    if (this.shuttingDown || this.grants.size > 0) {
      throw new Error('The Design client-tool bridge cannot recover while it is active.');
    }
    await this.removeStaleGrantDirectories();
    this.recovered = true;
  }

  async createSessionGrant(
    identity: DesignClientToolSessionIdentity
  ): Promise<DesignClientToolSessionGrant> {
    if (this.shuttingDown) {
      throw new Error('The Design client-tool bridge is shutting down.');
    }
    assertSessionIdentity(identity);
    await this.ensureStarted();
    if (this.shuttingDown) {
      throw new Error('The Design client-tool bridge is shutting down.');
    }
    await fs.mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const rootPath = await fs.mkdtemp(path.join(this.options.scratchRoot, 'grant-'));
    await fs.chmod(rootPath, 0o700);
    if (this.shuttingDown) {
      await fs.rm(rootPath, { recursive: true, force: true });
      throw new Error('The Design client-tool bridge is shutting down.');
    }
    const sessionCredential = randomCredential();
    const id = randomUUID();
    const stored: StoredSessionGrant = {
      id,
      identity: { ...identity },
      sessionCredentialHash: hashCredential(sessionCredential),
      rootPath,
      grantFilePath: path.join(rootPath, 'turn-grant'),
      callInProgress: false
    };
    this.grants.set(id, stored);
    this.grantsBySessionCredential.set(stored.sessionCredentialHash, stored);
    return {
      id,
      launch: {
        executablePath: this.options.executablePath,
        argv: [this.options.serverPath],
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          [ENDPOINT_ENV]: this.endpoint!,
          [SESSION_CREDENTIAL_ENV]: sessionCredential,
          [GRANT_FILE_ENV]: stored.grantFilePath
        }
      }
    };
  }

  async activateGrant(input: {
    grantId: string;
    authority: DesignClientToolAuthority;
  }): Promise<void> {
    const grant = this.requireGrant(input.grantId);
    assertAuthority(input.authority);
    if (!sameSessionIdentity(grant.identity, input.authority)) {
      throw new Error('The Design client-tool grant does not own this runtime session.');
    }
    await this.revokeGrant(input.grantId);
    const credential = randomCredential();
    grant.active = {
      authority: { ...input.authority },
      tokenHash: hashCredential(credential)
    };
    try {
      await fs.writeFile(grant.grantFilePath, credential, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
    } catch (error) {
      grant.active = undefined;
      throw error;
    }
  }

  async revokeGrant(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant) return;
    grant.active = undefined;
    await fs.rm(grant.grantFilePath, { force: true });
  }

  async releaseSessionGrant(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant) return;
    this.grantsBySessionCredential.delete(grant.sessionCredentialHash);
    grant.active = undefined;
    await fs.rm(grant.rootPath, { recursive: true, force: true });
    this.grants.delete(grantId);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownNow();
    return this.shutdownPromise;
  }

  private async shutdownNow(): Promise<void> {
    this.shuttingDown = true;
    await this.starting?.catch(() => undefined);
    const failures = (await Promise.allSettled(
      [...this.grants.keys()].map((grantId) => this.releaseSessionGrant(grantId))
    ))
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (server) {
      for (const socket of this.sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve) =>
          server.close((error) => {
            if (error) failures.push(error);
            resolve();
          })
        );
      }
    }
    this.sockets.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Design client-tool bridge cleanup failed.');
    }
  }

  private requireGrant(grantId: string): StoredSessionGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('The Design client-tool session grant is not active.');
    return grant;
  }

  private async ensureStarted(): Promise<void> {
    if (this.endpoint) return;
    this.starting ??= this.start();
    await this.starting;
  }

  private async start(): Promise<void> {
    if (!this.recovered) await this.recover();
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The Design client-tool bridge did not bind a loopback port.');
    }
    this.endpoint = `http://127.0.0.1:${address.port}/design-tool`;
  }

  private async removeStaleGrantDirectories(): Promise<void> {
    await fs.mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.options.scratchRoot, 0o700);
    const entries = await fs.readdir(this.options.scratchRoot, {
      withFileTypes: true
    });
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith('grant-'))
        .map((entry) =>
          fs.rm(path.join(this.options.scratchRoot, entry.name), {
            recursive: true,
            force: true
          })
        )
    );
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    try {
      if (this.shuttingDown || request.method !== 'POST' || request.url !== '/design-tool') {
        return writeResponse(response, 404, { ok: false, error: 'Not found.' });
      }
      const sessionCredential = bearerCredential(request.headers.authorization);
      const grant = sessionCredential
        ? this.grantsBySessionCredential.get(hashCredential(sessionCredential))
        : undefined;
      if (!grant) {
        return writeResponse(response, 401, { ok: false, error: 'Unauthorized.' });
      }
      const body = parseRequest(await readRequest(request));
      if (body.method === 'definition') {
        return writeResponse(response, 200, {
          ok: true,
          definition: INSPECT_DESIGN_TOOL_DEFINITION
        });
      }
      const active = grant.active;
      const turnCredential = singleHeader(request.headers['x-task-monki-design-grant']);
      if (
        !active ||
        !turnCredential ||
        hashCredential(turnCredential) !== active.tokenHash
      ) {
        return writeResponse(response, 409, {
          ok: false,
          error: 'inspect_design is available only in the current active Design Run.'
        });
      }
      if (grant.callInProgress) {
        return writeResponse(response, 409, {
          ok: false,
          error: 'Another inspect_design operation is still running for this Design.'
        });
      }
      const operation = parseInspectDesignOperation(body.arguments);
      grant.callInProgress = true;
      try {
        const authorized = await this.authorize(active.authority);
        if (grant.active !== active) {
          return writeResponse(response, 409, {
            ok: false,
            error: 'The inspect_design grant ended before the operation started.'
          });
        }
        if (!authorized) {
          await this.revokeGrant(grant.id);
          return writeResponse(response, 409, {
            ok: false,
            error: 'inspect_design is available only in the current active Design Run.'
          });
        }
        const result = await this.options.handler({
          runId: active.authority.runId,
          operation
        });
        if (grant.active !== active) {
          return writeResponse(response, 409, {
            ok: false,
            error: 'The inspect_design grant ended before the operation completed.'
          });
        }
        if (!(await this.authorize(active.authority))) {
          if (grant.active === active) await this.revokeGrant(grant.id);
          return writeResponse(response, 409, {
            ok: false,
            error: 'The inspect_design grant ended before the operation completed.'
          });
        }
        if (grant.active !== active) {
          return writeResponse(response, 409, {
            ok: false,
            error: 'The inspect_design grant ended before the operation completed.'
          });
        }
        return writeResponse(response, 200, {
          ok: true,
          content: designClientToolContent(result)
        });
      } finally {
        grant.callInProgress = false;
      }
    } catch (error) {
      return writeResponse(response, 400, {
        ok: false,
        error: safeDesignClientToolFailure(error)
      });
    }
  }

  private async authorize(authority: DesignClientToolAuthority): Promise<boolean> {
    const [session, run] = await Promise.all([
      this.options.runtimeStore.getSession(authority.sessionId),
      this.options.runtimeStore.getActiveRunForSession(authority.sessionId)
    ]);
    return Boolean(
      run &&
        session &&
        run.id === authority.runId &&
        run.sessionId === session.id &&
        run.owner.kind === 'TASK' &&
        run.scope.kind === 'TASK' &&
        run.scope.worktreeId === authority.worktreeId &&
        run.purpose === 'TASK_DESIGN' &&
        run.clientToolGrants?.includes(INSPECT_DESIGN_TOOL_DEFINITION.name) &&
        run.serverInstanceId === authority.providerGeneration &&
        ['STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
          run.status
        ) &&
        session.runtimeId === authority.runtimeId &&
        session.taskContext?.worktreeId === authority.worktreeId
    );
  }
}

export function resolveDesignToolMcpServerPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'design-tool-mcp-server.mjs')
    : path.join(input.appPath, 'src/core/design/runtime/design-tool-mcp-server.mjs');
}

function assertSessionIdentity(identity: DesignClientToolSessionIdentity): void {
  if (
    [
      identity.runtimeId,
      identity.sessionId,
      identity.worktreeId,
      identity.providerGeneration
    ].some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error('The Design client-tool session identity is invalid.');
  }
}

function assertAuthority(authority: DesignClientToolAuthority): void {
  assertSessionIdentity(authority);
  if (typeof authority.runId !== 'string' || authority.runId.length === 0) {
    throw new Error('The Design client-tool Run identity is invalid.');
  }
}

function sameSessionIdentity(
  session: DesignClientToolSessionIdentity,
  authority: DesignClientToolAuthority
): boolean {
  return (
    session.runtimeId === authority.runtimeId &&
    session.sessionId === authority.sessionId &&
    session.worktreeId === authority.worktreeId &&
    session.providerGeneration === authority.providerGeneration
  );
}

function parseRequest(value: string): BridgeRequest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The Design client-tool request is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.method === 'definition' && Object.keys(record).length === 1) {
    return { method: 'definition' };
  }
  if (
    record.method === 'call' &&
    Object.keys(record).every((key) => key === 'method' || key === 'arguments') &&
    Object.prototype.hasOwnProperty.call(record, 'arguments')
  ) {
    return { method: 'call', arguments: record.arguments };
  }
  throw new Error('The Design client-tool request is invalid.');
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > REQUEST_LIMIT_BYTES) {
      throw new Error('The Design client-tool request is too large.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeResponse(
  response: http.ServerResponse,
  status: number,
  body: BridgeResponse
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function bearerCredential(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
  return match?.[1];
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function randomCredential(): string {
  return randomBytes(32).toString('base64url');
}

function hashCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
