import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { TaskManagerService } from '../core/app/TaskManagerService';
import { TaskCreationRequestError } from '../core/storage/FileTaskStore';
import type { AppUpdateEvent } from '../shared/contracts';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isAttachmentClientToken,
  type AttachmentContent
} from '../shared/attachments';
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
const DEFAULT_MAX_ATTACHMENT_OPERATIONS = 2;
const DEFAULT_MAX_ATTACHMENT_IN_FLIGHT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_BATCH_MAX_JSON_BYTES = Math.ceil(ATTACHMENT_MAX_TOTAL_BYTES * 4 / 3) + 64 * 1024;

export interface DevHttpServerOptions {
  service: TaskManagerService;
  security: DevApiSecurityConfig;
  chooseRepositoryFolder(): Promise<string | undefined>;
  maxJsonBodyBytes?: number;
  maxEventStreamClients?: number;
  maxEventStreamBufferBytes?: number;
  maxAttachmentOperations?: number;
  maxAttachmentInFlightBytes?: number;
  logger?: Pick<Console, 'error'>;
}

function decodeAttachmentBatch(payload: unknown) {
  if (!payload || typeof payload !== 'object') throw invalidAttachmentBatch();
  const attachments = (payload as { attachments?: unknown }).attachments;
  if (
    !Array.isArray(attachments) ||
    attachments.length === 0 ||
    attachments.length > ATTACHMENT_MAX_COUNT
  ) {
    throw invalidAttachmentBatch();
  }
  let totalBytes = 0;
  return attachments.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw invalidAttachmentBatch();
    const value = candidate as Record<string, unknown>;
    if (
      !isAttachmentClientToken(value.clientToken) ||
      typeof value.displayName !== 'string' ||
      (value.declaredMediaType !== undefined && typeof value.declaredMediaType !== 'string') ||
      typeof value.bytesBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.bytesBase64)
    ) {
      throw invalidAttachmentBatch();
    }
    const bytes = Buffer.from(value.bytesBase64, 'base64');
    if (bytes.byteLength > ATTACHMENT_MAX_IMAGE_BYTES) throw invalidAttachmentBatch();
    totalBytes += bytes.byteLength;
    if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) throw invalidAttachmentBatch();
    return {
      clientToken: value.clientToken,
      displayName: value.displayName,
      declaredMediaType: value.declaredMediaType as string | undefined,
      bytes: Uint8Array.from(bytes).buffer
    };
  });
}

function invalidAttachmentBatch(): DevApiHttpError {
  return new DevApiHttpError(
    400,
    'ATTACHMENT_INVALID_REQUEST',
    'Attachment batch data is invalid.',
    false
  );
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
  const maxAttachmentOperations =
    options.maxAttachmentOperations ?? DEFAULT_MAX_ATTACHMENT_OPERATIONS;
  const maxAttachmentInFlightBytes =
    options.maxAttachmentInFlightBytes ?? DEFAULT_MAX_ATTACHMENT_IN_FLIGHT_BYTES;
  let activeAttachmentOperations = 0;
  let attachmentInFlightBytes = 0;
  let disposed = false;

  const withAttachmentBudget = async <T>(
    reservedBytes: number,
    operation: () => Promise<T>
  ): Promise<T> => {
    if (
      activeAttachmentOperations >= maxAttachmentOperations ||
      attachmentInFlightBytes + reservedBytes > maxAttachmentInFlightBytes
    ) {
      throw new DevApiHttpError(
        429,
        'ATTACHMENT_OPERATION_LIMIT',
        'Too many attachment operations are in progress. Try again shortly.',
        true
      );
    }
    activeAttachmentOperations += 1;
    attachmentInFlightBytes += reservedBytes;
    try {
      return await operation();
    } finally {
      activeAttachmentOperations -= 1;
      attachmentInFlightBytes -= reservedBytes;
    }
  };

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
    // SSE only invalidates the renderer's cached snapshot. Provider output and other
    // payload data stay on the bounded JSON endpoints instead of being duplicated here.
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
        sendJson(
          response,
          requestId,
          200,
          await options.service.updateAppSettings((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/settings/tools') {
        sendJson(response, requestId, 200, await options.service.getExternalToolStatus());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/settings/tools/test') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.testExternalTool((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/open-target/inspect') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.inspectOpenTarget((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/open-target/execute') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.executeOpenTargetAction((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        sendJson(response, requestId, 200, await options.service.listTasks());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/attachments/stage-batch') {
        const payload = await readBoundedJson(request, ATTACHMENT_BATCH_MAX_JSON_BYTES);
        const attachments = decodeAttachmentBatch(payload);
        await withAttachmentBudget(
          attachments.reduce((total, attachment) => total + attachment.bytes.byteLength, 0),
          async () => {
            sendJson(
              response,
              requestId,
              201,
              await options.service.stageTaskAttachmentBatch({ attachments })
            );
          }
        );
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/api/attachments/drafts/discard'
      ) {
        await options.service.discardTaskAttachmentDraft((await readJson()) as never);
        sendJson(response, requestId, 200, {});
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/attachments/content') {
        const attachmentId = requiredQueryParameter(url, 'attachmentId');
        await withAttachmentBudget(
          ATTACHMENT_MAX_IMAGE_BYTES,
          async () => {
            await sendAttachment(
              response,
              requestId,
              await options.service.readTaskAttachment({ attachmentId })
            );
          }
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/repository/validate') {
        const body = (await readJson()) as { path: string };
        sendJson(
          response,
          requestId,
          200,
          await options.service.validateRepository(body.path)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/repository/chooseFolder') {
        await readJson();
        sendJson(response, requestId, 200, (await options.chooseRepositoryFolder()) ?? null);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.createTask((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/prompt/refine') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.refinePrompt((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/worktrees/prepare') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.prepareWorktree((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/start') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.startRun((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/steer') {
        await options.service.steerRun((await readJson()) as never);
        sendJson(response, requestId, 200, {});
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/continue') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.continueRun((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/retry') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.retryRun((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/runs/review') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.startReview((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/goal/sync') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.syncAgentGoal((await readJson()) as never)
        );
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
        sendJson(
          response,
          requestId,
          200,
          await options.service.refreshEvidence((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/git/delivery-commit') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.createDeliveryCommit((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/preflight') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.preflightGitHub((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/publish') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.publishBranch((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/pr/create') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.createPullRequest((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/refresh') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.refreshGitHub((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/resolve') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.resolvePreview((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/approve') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.approvePreviewPlan((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/start') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.startPreview((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/stop') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.stopPreview((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/open') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.openPreview((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/log/read') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.readPreviewLog((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/reset-data') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.resetPreviewData((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/retry-setup') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.retryPreviewSetup((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/binding/set') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.setPreviewLocalAttachmentBinding((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/preview/binding/delete') {
        await options.service.deletePreviewLocalAttachmentBinding((await readJson()) as never);
        sendJson(response, requestId, 200, null);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks/transition') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.transitionTask((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks/delete') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.deleteTask((await readJson()) as never)
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/artifact/read') {
        sendJson(
          response,
          requestId,
          200,
          await options.service.readArtifact((await readJson()) as never)
        );
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
      const safeError = toSafeHttpError(error);
      if (safeError) {
        sendError(response, requestId, safeError);
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
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-request-id': requestId
  });
  response.end(JSON.stringify(body));
}

async function sendAttachment(
  response: http.ServerResponse,
  requestId: string,
  attachment: AttachmentContent
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const bytes = Buffer.from(attachment.bytes);
  const contentType =
    attachment.kind === 'image' ? attachment.mediaType : 'text/plain; charset=utf-8';
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
    'content-disposition': 'attachment; filename="task-monki-attachment"',
    'cache-control': 'private, no-store',
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-request-id': requestId,
    'x-task-monki-attachment-id': attachment.attachmentId,
    'x-task-monki-attachment-name': encodeURIComponent(attachment.displayName),
    'x-task-monki-attachment-kind': attachment.kind,
    'x-task-monki-attachment-media-type': attachment.mediaType
  });
  await new Promise<void>((resolve) => {
    const finish = () => {
      response.off('finish', finish);
      response.off('close', finish);
      resolve();
    };
    response.once('finish', finish);
    response.once('close', finish);
    response.end(bytes);
  });
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
      return new DevApiHttpError(
        503,
        'DEV_API_STARTING',
        'The development API is still starting.',
        true
      );
    case 'UNAUTHORIZED':
      return new DevApiHttpError(401, 'UNAUTHORIZED', 'Development API authentication failed.');
    case 'INVALID_HOST':
      return new DevApiHttpError(403, 'INVALID_HOST', 'The request host is not allowed.');
    case 'INVALID_ORIGIN':
      return new DevApiHttpError(403, 'INVALID_ORIGIN', 'The request origin is not allowed.');
    case 'INVALID_FETCH_SITE':
      return new DevApiHttpError(
        403,
        'INVALID_FETCH_SITE',
        'Cross-site requests are not allowed.'
      );
  }
}

function requiredQueryParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) {
    throw new DevApiHttpError(
      400,
      'INVALID_REQUEST',
      `The ${name} query parameter is required.`
    );
  }
  return value;
}

function toSafeHttpError(error: unknown): DevApiHttpError | undefined {
  if (error instanceof DevApiHttpError) {
    return error;
  }
  if (error instanceof TaskCreationRequestError) {
    return new DevApiHttpError(error.httpStatus, error.code, error.message);
  }
  if (
    error instanceof Error &&
    error.name === 'AttachmentStoreError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^ATTACHMENT_[A-Z_]+$/u.test(error.code) &&
    'httpStatus' in error &&
    typeof error.httpStatus === 'number' &&
    [400, 404, 409, 413, 507].includes(error.httpStatus)
  ) {
    return new DevApiHttpError(error.httpStatus, error.code, error.message);
  }
  if (
    error instanceof Error &&
    error.name === 'AgentAttachmentDeliveryError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'INVALID_ATTACHMENT_DELIVERY',
      'ATTACHMENT_MISSING',
      'ATTACHMENT_NOT_REGULAR',
      'ATTACHMENT_NOT_READ_ONLY',
      'ATTACHMENT_SIZE_MISMATCH',
      'ATTACHMENT_HASH_MISMATCH',
      'MODEL_DOES_NOT_SUPPORT_IMAGES',
      'ATTACHMENT_READ_ISOLATION_UNAVAILABLE',
      'ATTACHMENTS_REQUIRE_MANAGED_SANDBOX'
    ].includes(error.code)
  ) {
    return new DevApiHttpError(
      error.code === 'INVALID_ATTACHMENT_DELIVERY' ? 400 : 409,
      error.code,
      error.message
    );
  }
  return undefined;
}
