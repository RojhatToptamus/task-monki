import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type RendererLocationKind = 'file' | 'development-server';

export interface RendererTrustPolicy {
  kind: RendererLocationKind;
  entryUrl: string;
  isTrustedUrl(candidate: string): boolean;
}

export interface RendererTrustPolicyOptions {
  isPackaged: boolean;
  rendererFilePath: string;
  devServerUrl?: string;
}

export interface IpcFrameLike {
  readonly url: string;
}

export interface IpcWebContentsLike {
  readonly mainFrame: IpcFrameLike;
  isDestroyed(): boolean;
}

export interface IpcInvokeEventLike {
  readonly sender: IpcWebContentsLike;
  readonly senderFrame: IpcFrameLike | null;
}

export interface RendererPermissionRequest {
  permission: string;
  requestingUrl?: string;
  isMainFrame: boolean;
  senderMatches: boolean;
}

export function createRendererTrustPolicy(
  options: RendererTrustPolicyOptions
): RendererTrustPolicy {
  if (!options.isPackaged && options.devServerUrl) {
    const entry = parseDevelopmentServerUrl(options.devServerUrl);
    return createPolicy('development-server', entry);
  }

  const entry = pathToFileURL(path.resolve(options.rendererFilePath));
  return createPolicy('file', entry);
}

export function isTrustedIpcInvokeEvent(
  event: IpcInvokeEventLike,
  trustedWebContents: IpcWebContentsLike,
  policy: RendererTrustPolicy
): boolean {
  try {
    if (event.sender !== trustedWebContents || trustedWebContents.isDestroyed()) {
      return false;
    }

    const frame = event.senderFrame;
    if (!frame || frame !== trustedWebContents.mainFrame) {
      return false;
    }

    return policy.isTrustedUrl(frame.url);
  } catch {
    return false;
  }
}

export function isTrustedRendererPermissionRequest(
  request: RendererPermissionRequest,
  policy: RendererTrustPolicy
): boolean {
  return (
    request.senderMatches &&
    request.permission === 'clipboard-sanitized-write' &&
    request.isMainFrame &&
    request.requestingUrl !== undefined &&
    policy.isTrustedUrl(request.requestingUrl)
  );
}

export function isSafeExternalUrl(candidate: string): boolean {
  const parsed = parseUrl(candidate);
  return Boolean(
    parsed &&
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password
  );
}

function createPolicy(
  kind: RendererLocationKind,
  entry: URL
): RendererTrustPolicy {
  const entryUrl = entry.href;
  return {
    kind,
    entryUrl,
    isTrustedUrl(candidate: string): boolean {
      const parsed = parseUrl(candidate);
      if (!parsed || parsed.username || parsed.password) {
        return false;
      }
      return urlsMatchIgnoringFragment(entry, parsed);
    }
  };
}

function parseDevelopmentServerUrl(value: string): URL {
  const parsed = parseUrl(value);
  if (!parsed) {
    throw new Error('VITE_DEV_SERVER_URL must be a valid URL.');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('VITE_DEV_SERVER_URL must use HTTP.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('VITE_DEV_SERVER_URL must not contain credentials.');
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error('VITE_DEV_SERVER_URL must use 127.0.0.1.');
  }
  return parsed;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function urlsMatchIgnoringFragment(expected: URL, candidate: URL): boolean {
  return (
    candidate.protocol === expected.protocol &&
    candidate.username === expected.username &&
    candidate.password === expected.password &&
    candidate.host === expected.host &&
    candidate.pathname === expected.pathname &&
    candidate.search === expected.search
  );
}
