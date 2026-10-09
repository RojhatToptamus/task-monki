import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { AgentRuntimeStore } from '../AgentRuntimeStore';
import {
  clientToolContent,
  safeClientToolFailure,
  type ClientToolContent,
  type ClientToolDefinition,
  type ClientToolResult,
  type ClientToolSet
} from './ClientToolContract';
import { clientToolSet } from './ClientToolSets';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const SESSION_CREDENTIAL_ENV = 'TASK_MONKI_CLIENT_TOOL_SESSION_CREDENTIAL';
const ENDPOINT_ENV = 'TASK_MONKI_CLIENT_TOOL_ENDPOINT';
const GRANT_FILE_ENV = 'TASK_MONKI_CLIENT_TOOL_CREDENTIAL_FILE';
const TURN_CREDENTIAL_HEADER = 'x-task-monki-client-tool-grant';
const ENDPOINT_PATH = '/client-tool';
const ACTIVE_RUN_STATUSES = ['STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'];

export interface ClientToolSessionIdentity {
  runtimeId: string;
  sessionId: string;
  worktreeId: string;
  providerGeneration: string;
  toolSet: ClientToolSet['id'];
}

export interface ClientToolAuthority extends Omit<ClientToolSessionIdentity, 'toolSet'> {
  runId: string;
}

/** Executes one app-owned tool for the run that holds its grant. */
export interface ClientToolHandler {
  definition: ClientToolDefinition;
  call(input: { runId: string; arguments: unknown }): Promise<ClientToolResult>;
}

export interface ClientToolBridgeOptions {
  executablePath: string;
  serverPath: string;
  scratchRoot: string;
  handlers: readonly ClientToolHandler[];
  runtimeStore: Pick<AgentRuntimeStore, 'getSession' | 'getActiveRunForSession'>;
}

export interface ClientToolMcpLaunch {
  executablePath: string;
  argv: string[];
  environment: Record<string, string>;
}

export interface ClientToolSessionGrant {
  id: string;
  launch: ClientToolMcpLaunch;
}

interface ActiveGrant {
  authority: ClientToolAuthority;
  tokenHash: string;
}

interface StoredSessionGrant {
  id: string;
  identity: ClientToolSessionIdentity;
  sessionCredentialHash: string;
  rootPath: string;
  grantFilePath: string;
  active?: ActiveGrant;
  callInProgress: boolean;
}

type BridgeRequest =
  | { method: 'definitions' }
  | { method: 'call'; name: string; arguments: unknown };

interface BridgeResponse {
  ok: boolean;
  definitions?: ClientToolDefinition[];
  content?: ClientToolContent[];
  error?: string;
}

/**
 * Owns authenticated access from provider-launched MCP processes to the app-owned tool handlers.
 * A session grant names one tool set; a turn grant binds it to one active run. The bridge owns
 * credentials and admission only; each handler owns its own state.
 */
export class ClientToolBridge {
  private readonly handlers: ReadonlyMap<string, ClientToolHandler>;
  private readonly grants = new Map<string, StoredSessionGrant>();
  private readonly grantsBySessionCredential = new Map<string, StoredSessionGrant>();
  private readonly sockets = new Set<Socket>();
  private server?: http.Server;
  private endpoint?: string;
  private starting?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private recovered = false;

  constructor(private readonly options: ClientToolBridgeOptions) {
    this.handlers = new Map(options.handlers.map((handler) => [handler.definition.name, handler]));
  }

  async recover(): Promise<void> {
    if (this.shuttingDown || this.grants.size > 0) {
      throw new Error('The client-tool bridge cannot recover while it is active.');
    }
    await this.removeStaleGrantDirectories();
    this.recovered = true;
  }

  async createSessionGrant(identity: ClientToolSessionIdentity): Promise<ClientToolSessionGrant> {
    this.assertOpen();
    assertSessionIdentity(identity);
    await this.ensureStarted();
    this.assertOpen();
    await fs.mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    const rootPath = await fs.mkdtemp(path.join(this.options.scratchRoot, 'grant-'));
    await fs.chmod(rootPath, 0o700);
    if (this.shuttingDown) {
      await fs.rm(rootPath, { recursive: true, force: true });
      this.assertOpen();
    }
    const sessionCredential = randomCredential();
    const stored: StoredSessionGrant = {
      id: randomUUID(),
      identity: { ...identity },
      sessionCredentialHash: hashCredential(sessionCredential),
      rootPath,
      grantFilePath: path.join(rootPath, 'turn-grant'),
      callInProgress: false
    };
    this.grants.set(stored.id, stored);
    this.grantsBySessionCredential.set(stored.sessionCredentialHash, stored);
    return {
      id: stored.id,
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

  async activateGrant(input: { grantId: string; authority: ClientToolAuthority }): Promise<void> {
    const grant = this.requireGrant(input.grantId);
    assertAuthority(input.authority);
    if (!sameSessionIdentity(grant.identity, input.authority)) {
      throw new Error('The client-tool grant does not own this runtime session.');
    }
    await this.revokeGrant(input.grantId);
    const credential = randomCredential();
    grant.active = { authority: { ...input.authority }, tokenHash: hashCredential(credential) };
    try {
      await fs.writeFile(grant.grantFilePath, credential, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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

  /** Runs one tool for an in-process caller that has already admitted the run; MCP processes use the grant endpoint. */
  invoke(input: { tool: string; runId: string; arguments: unknown }): Promise<ClientToolResult> {
    return this.requireHandler(input.tool).call({ runId: input.runId, arguments: input.arguments });
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownNow();
    return this.shutdownPromise;
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new Error('The client-tool bridge is shutting down.');
  }

  private async shutdownNow(): Promise<void> {
    this.shuttingDown = true;
    await this.starting?.catch(() => undefined);
    const failures = (await Promise.allSettled([...this.grants.keys()].map((grantId) => this.releaseSessionGrant(grantId))))
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
    if (failures.length > 0) throw new AggregateError(failures, 'Client-tool bridge cleanup failed.');
  }

  private requireGrant(grantId: string): StoredSessionGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('The client-tool session grant is not active.');
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
      throw new Error('The client-tool bridge did not bind a loopback port.');
    }
    this.endpoint = `http://127.0.0.1:${address.port}${ENDPOINT_PATH}`;
  }

  private async removeStaleGrantDirectories(): Promise<void> {
    await fs.mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.options.scratchRoot, 0o700);
    const entries = await fs.readdir(this.options.scratchRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith('grant-'))
        .map((entry) => fs.rm(path.join(this.options.scratchRoot, entry.name), { recursive: true, force: true }))
    );
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (this.shuttingDown || request.method !== 'POST' || request.url !== ENDPOINT_PATH) {
        return writeResponse(response, 404, { ok: false, error: 'Not found.' });
      }
      const sessionCredential = bearerCredential(request.headers.authorization);
      const grant = sessionCredential ? this.grantsBySessionCredential.get(hashCredential(sessionCredential)) : undefined;
      if (!grant) return writeResponse(response, 401, { ok: false, error: 'Unauthorized.' });
      const set = clientToolSet(grant.identity.toolSet);
      const body = parseRequest(await readRequest(request));
      if (body.method === 'definitions') {
        return writeResponse(response, 200, { ok: true, definitions: [...set.definitions] });
      }
      if (!set.tools.includes(body.name)) {
        return writeResponse(response, 400, { ok: false, error: `${body.name} is not available in this session.` });
      }
      const handler = this.requireHandler(body.name);
      const active = grant.active;
      const turnCredential = singleHeader(request.headers[TURN_CREDENTIAL_HEADER]);
      const unavailable = `${body.name} is available only in the current active run.`;
      if (!active || !turnCredential || hashCredential(turnCredential) !== active.tokenHash) {
        return writeResponse(response, 409, { ok: false, error: unavailable });
      }
      if (grant.callInProgress) {
        return writeResponse(response, 409, { ok: false, error: `Another ${body.name} operation is still running.` });
      }
      grant.callInProgress = true;
      try {
        const ended = `The ${body.name} grant ended before the operation completed.`;
        if (!(await this.authorize(active.authority, set, body.name))) {
          if (grant.active === active) await this.revokeGrant(grant.id);
          return writeResponse(response, 409, { ok: false, error: unavailable });
        }
        if (grant.active !== active) return writeResponse(response, 409, { ok: false, error: ended });
        const result = await handler.call({ runId: active.authority.runId, arguments: body.arguments });
        if (grant.active !== active || !(await this.authorize(active.authority, set, body.name))) {
          if (grant.active === active) await this.revokeGrant(grant.id);
          return writeResponse(response, 409, { ok: false, error: ended });
        }
        return writeResponse(response, 200, { ok: true, content: clientToolContent(result) });
      } finally {
        grant.callInProgress = false;
      }
    } catch (error) {
      return writeResponse(response, 400, { ok: false, error: safeClientToolFailure(error) });
    }
  }

  private requireHandler(name: string): ClientToolHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`${name} has no handler in this Task Monki host.`);
    return handler;
  }

  /** The run must still be the session's active run, hold the grant for this tool, and run with the set's purpose. */
  private async authorize(authority: ClientToolAuthority, set: ClientToolSet, tool: string): Promise<boolean> {
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
        run.purpose === set.purpose &&
        run.clientToolGrants?.includes(tool) &&
        run.serverInstanceId === authority.providerGeneration &&
        ACTIVE_RUN_STATUSES.includes(run.status) &&
        session.runtimeId === authority.runtimeId &&
        session.taskContext?.worktreeId === authority.worktreeId
    );
  }
}

export function resolveClientToolMcpServerPath(input: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'client-tool-mcp-server.mjs')
    : path.join(input.appPath, 'src/core/agent/clientTools/client-tool-mcp-server.mjs');
}

function assertSessionIdentity(identity: ClientToolSessionIdentity): void {
  if (
    [identity.runtimeId, identity.sessionId, identity.worktreeId, identity.providerGeneration, identity.toolSet].some(
      (value) => typeof value !== 'string' || value.length === 0
    )
  ) {
    throw new Error('The client-tool session identity is invalid.');
  }
}

function assertAuthority(authority: ClientToolAuthority): void {
  if (
    [authority.runtimeId, authority.sessionId, authority.worktreeId, authority.providerGeneration, authority.runId].some(
      (value) => typeof value !== 'string' || value.length === 0
    )
  ) {
    throw new Error('The client-tool run identity is invalid.');
  }
}

function sameSessionIdentity(session: ClientToolSessionIdentity, authority: ClientToolAuthority): boolean {
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
    throw new Error('The client-tool request is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.method === 'definitions' && keys.length === 1) return { method: 'definitions' };
  if (
    record.method === 'call' &&
    typeof record.name === 'string' &&
    keys.every((key) => ['method', 'name', 'arguments'].includes(key)) &&
    Object.prototype.hasOwnProperty.call(record, 'arguments')
  ) {
    return { method: 'call', name: record.name, arguments: record.arguments };
  }
  throw new Error('The client-tool request is invalid.');
}

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > REQUEST_LIMIT_BYTES) throw new Error('The client-tool request is too large.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeResponse(response: http.ServerResponse, status: number, body: BridgeResponse): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function bearerCredential(value: string | undefined): string | undefined {
  return value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
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
