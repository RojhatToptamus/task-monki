#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18'
]);
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const endpoint = requiredEnvironment('TASK_MONKI_DESIGN_TOOL_ENDPOINT');
const sessionCredential = requiredEnvironment(
  'TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL'
);
const grantFile = requiredEnvironment('TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE');
const endpointUrl = new URL(endpoint);
if (
  endpointUrl.protocol !== 'http:' ||
  endpointUrl.hostname !== '127.0.0.1' ||
  endpointUrl.pathname !== '/design-tool' ||
  endpointUrl.username ||
  endpointUrl.password
) {
  throw new Error('The Task Monki Design tool endpoint is invalid.');
}

let input = Buffer.alloc(0);
let queue = Promise.resolve();

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  if (input.byteLength > MAX_REQUEST_BYTES && input.indexOf(0x0a) === -1) {
    process.exitCode = 1;
    process.stdin.destroy(new Error('The MCP request is too large.'));
    return;
  }
  for (;;) {
    const newline = input.indexOf(0x0a);
    if (newline === -1) break;
    const line = input.subarray(0, newline);
    input = input.subarray(newline + 1);
    if (line.byteLength === 0) continue;
    if (line.byteLength > MAX_REQUEST_BYTES) {
      queue = queue.then(() => writeError(null, -32600, 'The MCP request is too large.'));
      continue;
    }
    queue = queue.then(() => handleLine(line)).catch(() => undefined);
  }
});

process.stdin.once('end', () => {
  if (input.byteLength > 0) {
    queue = queue
      .then(() =>
        input.byteLength > MAX_REQUEST_BYTES
          ? writeError(null, -32600, 'The MCP request is too large.')
          : handleLine(input)
      )
      .catch(() => undefined);
  }
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line.toString('utf8'));
  } catch {
    await writeError(null, -32700, 'Parse error.');
    return;
  }
  if (!isRequest(request)) {
    await writeError(request?.id ?? null, -32600, 'Invalid request.');
    return;
  }
  if (request.method.startsWith('notifications/')) return;
  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion;
      await writeResult(request.id, {
        protocolVersion:
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'task-monki-design-tools', version: '1.0.0' }
      });
      return;
    }
    case 'ping':
      await writeResult(request.id, {});
      return;
    case 'tools/list': {
      try {
        const bridge = await callBridge({ method: 'definition' });
        if (!bridge.ok || !bridge.definition) {
          throw new Error(bridge.error || 'The Design tool definition is unavailable.');
        }
        await writeResult(request.id, { tools: [bridge.definition] });
      } catch (error) {
        await writeError(request.id, -32603, safeMessage(error));
      }
      return;
    }
    case 'tools/call': {
      if (
        !request.params ||
        request.params.name !== 'inspect_design' ||
        !Object.prototype.hasOwnProperty.call(request.params, 'arguments')
      ) {
        await writeResult(request.id, {
          content: [{ type: 'text', text: 'Only inspect_design is available.' }],
          isError: true
        });
        return;
      }
      try {
        const bridge = await callBridge(
          { method: 'call', arguments: request.params.arguments },
          await readTurnCredential()
        );
        await writeResult(request.id, {
          content: bridge.content ?? [
            { type: 'text', text: bridge.error || 'The Design browser operation failed.' }
          ],
          ...(bridge.ok ? {} : { isError: true })
        });
      } catch (error) {
        await writeResult(request.id, {
          content: [{ type: 'text', text: safeMessage(error) }],
          isError: true
        });
      }
      return;
    }
    default:
      await writeError(request.id, -32601, 'Method not found.');
  }
}

async function callBridge(body, turnCredential) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      endpointUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionCredential}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(turnCredential
            ? { 'x-task-monki-design-grant': turnCredential }
            : {})
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_BRIDGE_RESPONSE_BYTES) {
            response.destroy(new Error('The Design tool response is too large.'));
            return;
          }
          chunks.push(bytes);
        });
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
        response.once('error', reject);
      }
    );
    request.once('error', reject);
    request.end(payload);
  });
}

async function readTurnCredential() {
  let value;
  try {
    value = await fs.readFile(grantFile, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('inspect_design is available only in the current active Design Run.');
    }
    throw error;
  }
  const credential = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(credential)) {
    throw new Error('The active Design tool grant is invalid.');
  }
  return credential;
}

function isRequest(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.jsonrpc === '2.0' &&
      typeof value.method === 'string' &&
      (typeof value.id === 'string' ||
        typeof value.id === 'number' ||
        value.id === undefined)
  );
}

async function writeResult(id, result) {
  await writeMessage({ jsonrpc: '2.0', id, result });
}

async function writeError(id, code, message) {
  await writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function writeMessage(message) {
  const output = `${JSON.stringify(message)}\n`;
  if (process.stdout.write(output)) return;
  await new Promise((resolve) => process.stdout.once('drain', resolve));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required ${name} configuration.`);
  return value;
}

function safeMessage(error) {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (
    message.length > 0 &&
    message.length <= 1_000 &&
    !message.includes('/') &&
    !message.includes('\\')
  ) {
    return message;
  }
  return 'The Design browser operation failed.';
}
