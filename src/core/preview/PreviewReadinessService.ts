import http from 'node:http';
import net from 'node:net';

export interface PreviewReadinessResult {
  status: 'PASSED' | 'FAILED';
  lastStatusCode?: number;
  lastError?: string;
  observedAt: string;
}

export class PreviewReadinessService {
  async waitForHttp(input: {
    port: number;
    path: string;
    timeoutMs: number;
    requestTimeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  }): Promise<PreviewReadinessResult> {
    const deadline = Date.now() + input.timeoutMs;
    let lastStatusCode: number | undefined;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) throw abortError();
      try {
        const statusCode = await probeHttp({
          port: input.port,
          path: input.path,
          timeoutMs: Math.min(input.requestTimeoutMs ?? 2_000, Math.max(1, deadline - Date.now())),
          signal: input.signal
        });
        lastStatusCode = statusCode;
        lastError = undefined;
        if (statusCode >= 200 && statusCode < 400) {
          return { status: 'PASSED', lastStatusCode: statusCode, observedAt: new Date().toISOString() };
        }
        lastError = `HTTP ${statusCode}`;
      } catch (error) {
        if (input.signal?.aborted) throw abortError();
        lastError = boundedMessage(error);
      }
      await delay(Math.min(input.intervalMs ?? 100, Math.max(0, deadline - Date.now())), input.signal);
    }
    return {
      status: 'FAILED',
      lastStatusCode,
      lastError: lastError ?? 'Readiness timed out.',
      observedAt: new Date().toISOString()
    };
  }

  async waitForTcp(input: {
    port: number;
    timeoutMs: number;
    connectTimeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  }): Promise<PreviewReadinessResult> {
    const deadline = Date.now() + input.timeoutMs;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) throw abortError();
      try {
        await probeTcp({
          port: input.port,
          timeoutMs: Math.min(input.connectTimeoutMs ?? 2_000, Math.max(1, deadline - Date.now())),
          signal: input.signal
        });
        return { status: 'PASSED', observedAt: new Date().toISOString() };
      } catch (error) {
        if (input.signal?.aborted) throw abortError();
        lastError = boundedMessage(error);
      }
      await delay(Math.min(input.intervalMs ?? 100, Math.max(0, deadline - Date.now())), input.signal);
    }
    return {
      status: 'FAILED',
      lastError: lastError ?? 'TCP readiness timed out.',
      observedAt: new Date().toISOString()
    };
  }
}

function probeTcp(input: { port: number; timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port: input.port });
    const timer = setTimeout(() => finish(new Error('TCP readiness connection timed out.')), input.timeoutMs);
    const onAbort = () => finish(abortError());
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
    input.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function probeHttp(input: {
  port: number;
  path: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.get(
      {
        host: '127.0.0.1',
        port: input.port,
        path: input.path,
        headers: { connection: 'close' },
        signal: input.signal
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        finish(undefined, statusCode);
        response.destroy();
      }
    );
    const timer = setTimeout(
      () => request.destroy(new Error('Readiness request timed out.')),
      input.timeoutMs
    );
    const finish = (error?: Error, statusCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(statusCode ?? 0);
    };
    request.once('error', (error) => finish(error));
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(abortError());
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Preview readiness canceled.');
  error.name = 'AbortError';
  return error;
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
