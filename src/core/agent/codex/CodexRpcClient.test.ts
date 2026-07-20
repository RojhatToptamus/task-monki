import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import {
  CodexAmbiguousMutationError,
  CodexRpcClient
} from './CodexRpcClient';

describe('CodexRpcClient', () => {
  it('correlates responses and journals both directions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexRpcClient(input, output, store, server.id, 1_000);

    const outbound = readLine(input);
    const responsePromise = client.request('model/list', {
      includeHidden: false,
      limit: 10
    });
    const request = JSON.parse(await outbound) as { id: number };
    output.write(
      `${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`
    );

    await expect(responsePromise).resolves.toEqual({ data: [], nextCursor: null });
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(2);
  });

  it('redacts exact credential values from journals and provider errors without altering wire data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-redaction-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const secret = 'opaque-provider-credential-1742';
    const client = new CodexRpcClient(
      input,
      output,
      store,
      server.id,
      1_000,
      [secret]
    );

    const responseLine = readLine(input);
    await client.respond(41, { decision: 'accept', detail: secret });
    expect(await responseLine).toContain(secret);

    const requestLine = readLine(input);
    const requestPromise = client.request('model/list', {
      includeHidden: false,
      limit: 10
    });
    const request = JSON.parse(await requestLine) as { id: number };
    output.write(
      `${JSON.stringify({
        id: request.id,
        error: { code: -1, message: `failed ${secret}`, data: { detail: secret } }
      })}\n`
    );

    await expect(requestPromise).rejects.toMatchObject({
      message: 'failed [REDACTED]',
      data: { detail: '[REDACTED]' }
    });
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal).toContain('[REDACTED]');
    expect(journal).not.toContain(secret);
    client.close();
  });

  it('removes free-form streaming payloads from the journal across credential boundaries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-stream-redaction-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const output = new PassThrough();
    const secret = 'opaque-provider-credential-1742';
    const client = new CodexRpcClient(
      new PassThrough(),
      output,
      store,
      server.id,
      1_000,
      [secret]
    );
    const notifications: string[] = [];
    client.events.on('notification', (message) => {
      notifications.push(message.method);
    });

    output.write(
      `${JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'opaque-provider-'
        }
      })}\n`
    );
    output.write(
      `${JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'credential-1742'
        }
      })}\n`
    );

    await client.drainInbound();
    expect(notifications).toEqual([
      'item/agentMessage/delta',
      'item/agentMessage/delta'
    ]);
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal).toContain('item/agentMessage/delta');
    expect(journal).toContain('thread-1');
    expect(journal).toContain('[REDACTED]');
    expect(journal).not.toContain('opaque-provider-');
    expect(journal).not.toContain('credential-1742');
    client.close();
  });

  it('journals and reports malformed frames without retaining their original payload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-malformed-redaction-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const output = new PassThrough();
    const secret = 'opaque-provider-credential-1742';
    const client = new CodexRpcClient(
      new PassThrough(),
      output,
      store,
      server.id,
      1_000,
      [secret]
    );
    const reportedFrames: string[] = [];
    client.events.on('protocolError', (_error, rawLine) => {
      reportedFrames.push(rawLine);
    });

    output.write('opaque-provider-\n');
    output.write('credential-1742\n');
    output.write(`${JSON.stringify({ noise: 'opaque-provider-' })}\n`);
    output.write(`${JSON.stringify({ noise: 'credential-1742' })}\n`);
    await client.drainInbound();

    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(reportedFrames).toHaveLength(4);
    expect(reportedFrames.every((frame) => frame.includes('[REDACTED]'))).toBe(true);
    expect(`${journal}\n${reportedFrames.join('\n')}`).not.toContain('opaque-provider-');
    expect(`${journal}\n${reportedFrames.join('\n')}`).not.toContain('credential-1742');
    client.close();
  });

  it('surfaces notifications, server requests, and malformed messages separately', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-events-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const output = new PassThrough();
    const client = new CodexRpcClient(new PassThrough(), output, store, server.id, 1_000);
    const notification = new Promise<string>((resolve) => {
      client.events.once('notification', (message) => resolve(message.method));
    });
    const serverRequest = new Promise<string>((resolve) => {
      client.events.once('serverRequest', (message) => resolve(message.method));
    });
    const protocolError = new Promise<string>((resolve) => {
      client.events.once('protocolError', (error) => resolve(error.message));
    });

    output.write(
      `${JSON.stringify({
        method: 'thread/closed',
        params: { threadId: 'thread-1' }
      })}\n`
    );
    output.write(
      `${JSON.stringify({
        method: 'item/commandExecution/requestApproval',
        id: 9,
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: Date.now()
        }
      })}\n`
    );
    output.write('not-json\n');

    await expect(notification).resolves.toBe('thread/closed');
    await expect(serverRequest).resolves.toBe('item/commandExecution/requestApproval');
    await expect(protocolError).resolves.toContain('invalid JSON');
    client.close();
  });

  it('routes unknown server requests without accepting them as generated requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-unsupported-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexRpcClient(input, output, store, server.id, 1_000);
    const unsupported = new Promise<{ method: string; id: string | number }>(
      (resolve) => {
        client.events.once('unsupportedServerRequest', (request) =>
          resolve({ method: request.method, id: request.id })
        );
      }
    );

    output.write(
      `${JSON.stringify({
        method: 'future/requestApproval',
        id: 'future-1',
        params: { threadId: 'thread-1' }
      })}\n`
    );

    await expect(unsupported).resolves.toEqual({
      method: 'future/requestApproval',
      id: 'future-1'
    });
    client.close();
  });

  it('persists a server-request response reference before writing it to stdio', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-response-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const client = new CodexRpcClient(input, new PassThrough(), store, server.id, 1_000);
    let journaledBeforeWrite = false;
    const outbound = readLine(input).then((line) => {
      expect(journaledBeforeWrite).toBe(true);
      return JSON.parse(line) as { id: string | number };
    });

    const reference = await client.respond(
      41,
      { decision: 'accept' },
      async (journaled) => {
        journaledBeforeWrite = true;
        expect(journaled.direction).toBe('OUTBOUND');
      }
    );

    await expect(outbound).resolves.toMatchObject({ id: 41 });
    expect(reference.sequence).toBe(1);
    client.close();
  });

  it('does not write an outbound request before its journal append is durable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-durable-send-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexRpcClient(input, output, store, server.id, 1_000);
    const append = store.appendProtocolMessage.bind(store);
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.spyOn(store, 'appendProtocolMessage').mockImplementation(
      async (serverId, direction, raw, metadata) => {
        if (direction === 'OUTBOUND') await appendGate;
        return append(serverId, direction, raw, metadata);
      }
    );

    const response = client.request('model/list', {
      includeHidden: false,
      limit: 10
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(input.readableLength).toBe(0);

    const outbound = readLine(input);
    releaseAppend();
    const request = JSON.parse(await outbound) as { id: number };
    output.write(
      `${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`
    );
    await expect(response).resolves.toEqual({ data: [], nextCursor: null });
    client.close();
  });

  it('classifies a journaled response write failure as ambiguous delivery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-response-write-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('injected broken pipe'));
      }
    });
    const client = new CodexRpcClient(input, new PassThrough(), store, server.id, 1_000);
    let journaled = false;

    const response = client.respond(41, { decision: 'accept' }, async () => {
      journaled = true;
    });

    await expect(response).rejects.toBeInstanceOf(CodexAmbiguousMutationError);
    expect(journaled).toBe(true);
    client.close();
  });

  it('redacts exact credentials from query write failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-write-redaction-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const secret = 'opaque-codex-write-credential-319';
    const input = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error(`write failed with ${secret}`));
      }
    });
    const client = new CodexRpcClient(
      input,
      new PassThrough(),
      store,
      server.id,
      1_000,
      [secret]
    );

    const request = client.request('model/list', {
      includeHidden: false,
      limit: 10
    });

    await expect(request).rejects.toThrow('write failed with [REDACTED]');
    await expect(request).rejects.not.toThrow(secret);
    client.close();
  });

  it('settles a blocked response write when the client closes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-blocked-write-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const input = new Writable({
      write(_chunk, _encoding, _callback) {
        writeStarted();
      }
    });
    const client = new CodexRpcClient(input, new PassThrough(), store, server.id, 1_000);
    const response = client.respond(41, { decision: 'accept' });

    await started;
    client.close('test shutdown');

    await expect(response).rejects.toBeInstanceOf(CodexAmbiguousMutationError);
  });

  it('marks timed-out mutations as ambiguous instead of inviting an automatic retry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-mutation-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const client = new CodexRpcClient(
      new PassThrough(),
      new PassThrough(),
      store,
      server.id,
      10
    );

    await expect(
      client.requestMutation('turn/steer', {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Focus on tests.', text_elements: [] }],
        expectedTurnId: 'turn-1'
      })
    ).rejects.toBeInstanceOf(CodexAmbiguousMutationError);
    client.close();
  });

  it('ignores late responses for requests that already timed out', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-late-response-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexRpcClient(input, output, store, server.id, 10);
    const protocolErrors: string[] = [];
    client.events.on('protocolError', (error) => protocolErrors.push(error.message));

    const outbound = readLine(input);
    const responsePromise = client.request('model/list', {
      includeHidden: false,
      limit: 10
    });
    const rejection = expect(responsePromise).rejects.toThrow('timed out');
    const request = JSON.parse(await outbound) as { id: number };

    await rejection;
    output.write(
      `${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(protocolErrors).toEqual([]);
    client.close();
  });
});

function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      value += chunk.toString('utf8');
      const newline = value.indexOf('\n');
      if (newline >= 0) {
        stream.off('data', onData);
        resolve(value.slice(0, newline));
      }
    };
    stream.on('data', onData);
  });
}
