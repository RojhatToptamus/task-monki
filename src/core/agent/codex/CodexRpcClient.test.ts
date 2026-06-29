import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
      provider: 'codex',
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

  it('surfaces notifications, server requests, and malformed messages separately', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-events-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      provider: 'codex',
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
      provider: 'codex',
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
      provider: 'codex',
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

  it('marks timed-out mutations as ambiguous instead of inviting an automatic retry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-rpc-mutation-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      provider: 'codex',
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
      provider: 'codex',
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
