import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const DEV_API_TOKEN_HEADER = 'x-task-monki-dev-token';

export interface DevApiAuthorizationConfig {
  token: string;
  rendererOrigin: string;
}

export function authorizeDevApiRequest(
  headers: IncomingHttpHeaders,
  config: DevApiAuthorizationConfig
): { authorized: true } | { authorized: false; reason: string } {
  if (!config.token) {
    return { authorized: false, reason: 'The development API token is not configured.' };
  }
  const supplied = singleHeader(headers[DEV_API_TOKEN_HEADER]);
  if (!supplied || !constantTimeEqual(supplied, config.token)) {
    return { authorized: false, reason: 'The development API token is missing or invalid.' };
  }

  const origin = singleHeader(headers.origin);
  if (origin && origin !== config.rendererOrigin) {
    return { authorized: false, reason: 'The browser origin is not authorized.' };
  }
  return { authorized: true };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
