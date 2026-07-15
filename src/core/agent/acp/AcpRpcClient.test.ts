import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import { AcpAmbiguousMutationError, AcpRpcClient } from './AcpRpcClient';

describe('AcpRpcClient', () => {
  it('uses newline-delimited JSON-RPC 2.0 and journals both directions', async () => {
    const harness = rpcHarness();
    const resultPromise = harness.client.request<{ protocolVersion: number }>('initialize', {
      protocolVersion: 1
    });
    const outbound = JSON.parse(await harness.outbound.next()) as {
      jsonrpc: string;
      id: number;
      method: string;
    };
    expect(outbound).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize'
    });
    harness.agentOutput.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: outbound.id, result: { protocolVersion: 1 } })}\n`
    );
    await expect(resultPromise).resolves.toMatchObject({
      result: { protocolVersion: 1 },
      raw: { direction: 'INBOUND' }
    });
    expect(harness.journal.map((entry) => entry.direction)).toEqual([
      'OUTBOUND',
      'INBOUND'
    ]);
  });

  it('delivers server requests with durable raw references and returns exact results', async () => {
    const harness = rpcHarness();
    const requestPromise = new Promise<{ id: string | number | null; rawSequence: number }>(
      (resolve) => {
        harness.client.events.once('request', (request, raw) => {
          resolve({ id: request.id, rawSequence: raw.sequence });
        });
      }
    );
    harness.agentOutput.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'opaque-request',
        method: 'session/request_permission',
        params: { sessionId: 'session-1' }
      })}\n`
    );
    await expect(requestPromise).resolves.toEqual({ id: 'opaque-request', rawSequence: 1 });
    await harness.client.respond('opaque-request', {
      outcome: { outcome: 'selected', optionId: 'provider-option-938' }
    });
    expect(JSON.parse(await harness.outbound.next())).toEqual({
      jsonrpc: '2.0',
      id: 'opaque-request',
      result: {
        outcome: { outcome: 'selected', optionId: 'provider-option-938' }
      }
    });
  });

  it('marks submitted mutations ambiguous when the connection closes', async () => {
    const harness = rpcHarness();
    const started = await harness.client.startMutation('session/prompt', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }]
    }, { timeoutMs: null });
    await harness.outbound.next();
    harness.client.close('test disconnect');
    await expect(started.response).rejects.toBeInstanceOf(AcpAmbiguousMutationError);
  });

  it('lets an explicitly long-lived prompt outlast the bounded control timeout', async () => {
    const harness = rpcHarness(20);
    const started = await harness.client.startMutation('session/prompt', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'slow work' }]
    }, { timeoutMs: null });
    const prompt = JSON.parse(await harness.outbound.next()) as { id: number };

    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.agentOutput.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })}\n`
    );
    await expect(started.response).resolves.toMatchObject({
      result: { stopReason: 'end_turn' }
    });

    const control = harness.client.request('session/list', {});
    await harness.outbound.next();
    await expect(control).rejects.toThrow('ACP request timed out: session/list');
  });

  it('rejects malformed envelopes without resolving unrelated requests', async () => {
    const harness = rpcHarness();
    const protocolError = new Promise<Error>((resolve) => {
      harness.client.events.once('protocolError', resolve);
    });
    harness.agentOutput.write('{"id":1,"result":{}}\n');
    expect((await protocolError).message).toContain('JSON-RPC 2.0');
  });

  it('preserves opaque operational IDs while redacting journals and protocol errors', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const harness = rpcHarness(1_000, [opaque]);
    const request = harness.client.request('session/list', {});
    const outbound = JSON.parse(await harness.outbound.next()) as { id: number };
    harness.agentOutput.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: outbound.id,
        error: { code: -32000, message: `provider echoed ${opaque}` }
      })}\n`
    );

    await expect(request).rejects.toThrow('provider echoed [REDACTED]');
    expect(harness.journal.map((entry) => entry.raw).join('\n')).not.toContain(opaque);

    const sessionRequest = harness.client.request<{
      sessionId: string;
      models: { currentModelId: string };
      configOptions: Array<{ id: string; currentValue: string }>;
    }>('session/new', {});
    const sessionOutbound = JSON.parse(await harness.outbound.next()) as { id: number };
    harness.agentOutput.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: sessionOutbound.id,
        result: {
          sessionId: opaque,
          models: { currentModelId: `model-${opaque}` },
          configOptions: [
            { id: `control-${opaque}`, currentValue: `choice-${opaque}` }
          ]
        }
      })}\n`
    );
    await expect(sessionRequest).resolves.toMatchObject({
      result: {
        sessionId: opaque,
        models: { currentModelId: `model-${opaque}` },
        configOptions: [
          { id: `control-${opaque}`, currentValue: `choice-${opaque}` }
        ]
      }
    });
    expect(harness.journal.map((entry) => entry.raw).join('\n')).not.toContain(opaque);

    const protocolError = new Promise<string | undefined>((resolve) => {
      harness.client.events.once('protocolError', (_error, rawLine) => resolve(rawLine));
    });
    harness.agentOutput.write(`not-json-${opaque}\n`);
    await expect(protocolError).resolves.toBe('not-json-[REDACTED]');
  });
});

function rpcHarness(
  requestTimeoutMs = 1_000,
  sensitiveValues: readonly string[] = []
) {
  const clientInput = new PassThrough();
  const agentOutput = new PassThrough();
  const outbound = lineCollector(clientInput);
  const journal: Array<AgentProtocolMessageReference & { raw: string }> = [];
  let sequence = 0;
  const client = new AcpRpcClient(
    clientInput,
    agentOutput,
    async (direction, raw) => {
      sequence += 1;
      const reference: AgentProtocolMessageReference = {
        serverInstanceId: 'server-1',
        sequence,
        direction,
        recordedAt: new Date(0).toISOString(),
        byteOffset: 0,
        byteLength: Buffer.byteLength(raw),
        sha256: `${sequence}`.padStart(64, '0')
      };
      journal.push({ ...reference, raw });
      return reference;
    },
    'server-1',
    requestTimeoutMs,
    sensitiveValues
  );
  return { client, agentOutput, outbound, journal };
}

function lineCollector(stream: PassThrough) {
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffered = '';
  stream.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  return {
    next(): Promise<string> {
      const line = lines.shift();
      return line === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(line);
    }
  };
}
