import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { TaskManagerService } from '../core/app/TaskManagerService';
import type { AppUpdateEvent } from '../shared/contracts';
import {
  authorizeDevApiRequest,
  DEFAULT_MAX_JSON_BODY_BYTES,
  DevApiHttpError,
  readBoundedJson,
  type DevApiAuthorizationFailure,
  type DevApiSecurityConfig
} from './devApiSecurity';

const MAX_HEADER_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_EVENT_STREAM_CLIENTS = 8;
const DEFAULT_MAX_EVENT_STREAM_BUFFER_BYTES = 64 * 1024;

export interface DevHttpServerOptions {
  service: TaskManagerService;
  security: DevApiSecurityConfig;
  chooseRepositoryFolder(): Promise<string | undefined>;
  maxJsonBodyBytes?: number;
  maxEventStreamClients?: number;
  maxEventStreamBufferBytes?: number;
  logger?: Pick<Console, 'error'>;
}

export interface DevHttpServer {
  server: http.Server;
  closeEventStreams(): void;
  dispose(): void;
}

interface StructuredErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export function createDevHttpServer(options: DevHttpServerOptions): DevHttpServer {
  const clients = new Set<http.ServerResponse>();
  const logger = options.logger ?? console;
  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const maxEventStreamClients =
    options.maxEventStreamClients ?? DEFAULT_MAX_EVENT_STREAM_CLIENTS;
  const maxEventStreamBufferBytes =
    options.maxEventStreamBufferBytes ?? DEFAULT_MAX_EVENT_STREAM_BUFFER_BYTES;
  let disposed = false;

  const sendEventFrame = (
    response: http.ServerResponse,
    frame: string,
    frameBytes: number
  ): void => {
    if (response.destroyed || response.writableEnded) {
      clients.delete(response);
      return;
    }
    const writableLimit = Math.min(
      maxEventStreamBufferBytes,
      response.writableHighWaterMark
    );
    if (
      frameBytes > maxEventStreamBufferBytes ||
      response.writableLength + frameBytes > writableLimit ||
      !response.write(frame)
    ) {
      clients.delete(response);
      response.destroy();
    }
  };

  const unsubscribe = options.service.events.on((event) => {
    const frame = createDevEventStreamFrame(event);
    const frameBytes = Buffer.byteLength(frame);
    for (const client of clients) {
      sendEventFrame(client, frame, frameBytes);
    }
  });

  const server = http.createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    (request, response) => {
      void route(request, response).catch((error: unknown) => {
        const requestId = randomUUID();
        logger.error(`Dev API request ${requestId} failed outside the route handler.`, error);
        sendError(
          response,
          requestId,
          new DevApiHttpError(
            500,
            'INTERNAL_ERROR',
            'The development API could not complete the request.',
            true
          )
        );
      });
    }
  );
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  async function route(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const requestId = randomUUID();
    const authorizationFailure = authorizeDevApiRequest(request, options.security);
    if (authorizationFailure) {
      sendError(response, requestId, authorizationFailureError(authorizationFailure));
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/api/events') {
      if (clients.size >= maxEventStreamClients) {
        sendError(
          response,
          requestId,
          new DevApiHttpError(
            429,
            'EVENT_STREAM_LIMIT',
            'Too many development event streams are open.',
            true
          )
        );
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-request-id': requestId
      });
      if (!response.write(': connected\n\n')) {
        response.destroy();
        return;
      }
      clients.add(response);
      const removeClient = () => clients.delete(response);
      request.on('close', removeClient);
      response.on('close', removeClient);
      return;
    }

    const readJson = () => readBoundedJson(request, maxJsonBodyBytes);

    try {
    if (request.method === 'GET' && url.pathname === '/api/defaultRepositoryPath') {
      sendJson(response, requestId, 200, await options.service.getDefaultRepositoryPath());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/agent/provider') {
      sendJson(response, requestId, 200, await options.service.getAgentProviderState());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(response, requestId, 200, await options.service.getAppSettings());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      sendJson(response, requestId, 200, await options.service.updateAppSettings((await readJson()) as never));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/tools') {
      sendJson(response, requestId, 200, await options.service.getExternalToolStatus());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/tools/test') {
      sendJson(response, requestId, 200, await options.service.testExternalTool((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/open-target/inspect') {
      sendJson(response, requestId, 200, await options.service.inspectOpenTarget((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/open-target/execute') {
      sendJson(response, requestId, 200, await options.service.executeOpenTargetAction((await readJson()) as never));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      sendJson(response, requestId, 200, await options.service.listTasks());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/repository/validate') {
      const body = (await readJson()) as { path: string };
      sendJson(response, requestId, 200, await options.service.validateRepository(body.path));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/repository/chooseFolder') {
      await readJson();
      sendJson(
        response,
        requestId,
        200,
        (await options.chooseRepositoryFolder()) ?? null
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      sendJson(response, requestId, 200, await options.service.createTask((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/prompt/refine') {
      sendJson(response, requestId, 200, await options.service.refinePrompt((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/worktrees/prepare') {
      sendJson(response, requestId, 200, await options.service.prepareWorktree((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/start') {
      sendJson(response, requestId, 200, await options.service.startRun((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/steer') {
      await options.service.steerRun((await readJson()) as never);
      sendJson(response, requestId, 200, {});
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/continue') {
      sendJson(response, requestId, 200, await options.service.continueRun((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/retry') {
      sendJson(response, requestId, 200, await options.service.retryRun((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/review') {
      sendJson(response, requestId, 200, await options.service.startReview((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/goal/sync') {
      sendJson(response, requestId, 200, await options.service.syncAgentGoal((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/cancel') {
      await options.service.cancelRun((await readJson()) as never);
      sendJson(response, requestId, 200, {});
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/interactions/respond') {
      sendJson(
        response,
        requestId,
        200,
        await options.service.respondToInteraction((await readJson()) as never)
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/evidence/refresh') {
      sendJson(response, requestId, 200, await options.service.refreshEvidence((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/delivery-commit') {
      sendJson(response, requestId, 200, await options.service.createDeliveryCommit((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/preflight') {
      sendJson(response, requestId, 200, await options.service.preflightGitHub((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/publish') {
      sendJson(response, requestId, 200, await options.service.publishBranch((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/pr/create') {
      sendJson(response, requestId, 200, await options.service.createPullRequest((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/refresh') {
      sendJson(response, requestId, 200, await options.service.refreshGitHub((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/preview/resolve') {
      sendJson(response, requestId, 200, await options.service.resolvePreview((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/approve') {
      sendJson(response, requestId, 200, await options.service.approvePreviewPlan((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/start') {
      sendJson(response, requestId, 200, await options.service.startPreview((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/stop') {
      sendJson(response, requestId, 200, await options.service.stopPreview((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/open') {
      sendJson(response, requestId, 200, await options.service.openPreview((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/log/read') {
      sendJson(response, requestId, 200, await options.service.readPreviewLog((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/reset-data') {
      sendJson(response, requestId, 200, await options.service.resetPreviewData((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/retry-setup') {
      sendJson(response, requestId, 200, await options.service.retryPreviewSetup((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/binding/set') {
      sendJson(response, requestId, 200, await options.service.setPreviewLocalAttachmentBinding((await readJson()) as never));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/preview/binding/delete') {
      await options.service.deletePreviewLocalAttachmentBinding((await readJson()) as never);
      sendJson(response, requestId, 200, null);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks/transition') {
      sendJson(response, requestId, 200, await options.service.transitionTask((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks/delete') {
      sendJson(response, requestId, 200, await options.service.deleteTask((await readJson()) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/artifact/read') {
      const text = await options.service.readArtifact((await readJson()) as never);
      sendJson(response, requestId, 200, text);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/protocol/read') {
      sendJson(
        response,
        requestId,
        200,
        await options.service.readProtocolMessage((await readJson()) as never)
      );
      return;
    }

      sendError(response, requestId, new DevApiHttpError(404, 'NOT_FOUND', 'Not found.'));
    } catch (error) {
      if (error instanceof DevApiHttpError) {
        sendError(response, requestId, error);
        return;
      }
      logger.error(`Dev API request ${requestId} failed.`, error);
      sendError(
        response,
        requestId,
        new DevApiHttpError(
          500,
          'INTERNAL_ERROR',
          'The development API could not complete the request.',
          true
        )
      );
    }
  }

  return {
    server,
    closeEventStreams() {
      for (const client of clients) {
        client.destroy();
      }
      clients.clear();
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        unsubscribe();
      }
    }
  };
}

export function createDevEventStreamFrame(event: AppUpdateEvent): string {
  const signal: AppUpdateEvent = {
    type: event.type,
    taskId: event.taskId,
    iterationId: event.iterationId,
    runId: event.runId,
    worktreeId: event.worktreeId,
    previewGenerationId: event.previewGenerationId,
    payload: null,
    at: event.at
  };
  return `event: update\ndata: ${JSON.stringify(signal)}\n\n`;
}

function sendJson(
  response: http.ServerResponse,
  requestId: string,
  statusCode: number,
  body: unknown
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-request-id': requestId
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: http.ServerResponse,
  requestId: string,
  error: DevApiHttpError
): void {
  const body: StructuredErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId
    }
  };
  sendJson(response, requestId, error.statusCode, body);
}

function authorizationFailureError(failure: DevApiAuthorizationFailure): DevApiHttpError {
  switch (failure) {
    case 'NOT_READY':
      return new DevApiHttpError(503, 'DEV_API_STARTING', 'The development API is still starting.', true);
    case 'UNAUTHORIZED':
      return new DevApiHttpError(401, 'UNAUTHORIZED', 'Development API authentication failed.');
    case 'INVALID_HOST':
      return new DevApiHttpError(403, 'INVALID_HOST', 'The request host is not allowed.');
    case 'INVALID_ORIGIN':
      return new DevApiHttpError(403, 'INVALID_ORIGIN', 'The request origin is not allowed.');
    case 'INVALID_FETCH_SITE':
      return new DevApiHttpError(403, 'INVALID_FETCH_SITE', 'Cross-site requests are not allowed.');
  }
}
