import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createRendererTrustPolicy,
  isSafeExternalUrl,
  isTrustedIpcInvokeEvent,
  isTrustedRendererPermissionRequest,
  type IpcFrameLike,
  type IpcWebContentsLike
} from './rendererTrust';

const rendererFilePath = path.resolve('/tmp/task-monki-renderer/index.html');

describe('renderer trust policy', () => {
  it('trusts only the exact packaged renderer file URL', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: true,
      rendererFilePath,
      devServerUrl: 'http://127.0.0.1:5173/'
    });
    const expected = pathToFileURL(rendererFilePath).href;

    expect(policy.kind).toBe('file');
    expect(policy.entryUrl).toBe(expected);
    expect(policy.isTrustedUrl(expected)).toBe(true);
    expect(policy.isTrustedUrl(`${expected}#task-1`)).toBe(true);
    expect(policy.isTrustedUrl(`${expected}?debug=true`)).toBe(false);
    expect(
      policy.isTrustedUrl(pathToFileURL(path.resolve(rendererFilePath, '..', 'other.html')).href)
    ).toBe(false);
    expect(policy.isTrustedUrl('https://task-monki.invalid/')).toBe(false);
    expect(policy.isTrustedUrl('not a url')).toBe(false);
  });

  it('trusts only the configured loopback development page', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: false,
      rendererFilePath,
      devServerUrl: 'http://127.0.0.1:5173/app?mode=dev'
    });

    expect(policy.kind).toBe('development-server');
    expect(policy.isTrustedUrl('http://127.0.0.1:5173/app?mode=dev')).toBe(true);
    expect(policy.isTrustedUrl('http://127.0.0.1:5173/app?mode=dev#task-1')).toBe(
      true
    );
    expect(policy.isTrustedUrl('http://localhost:5173/app?mode=dev')).toBe(false);
    expect(policy.isTrustedUrl('http://127.0.0.1:5174/app?mode=dev')).toBe(false);
    expect(policy.isTrustedUrl('http://127.0.0.1:5173/other?mode=dev')).toBe(false);
    expect(policy.isTrustedUrl('http://127.0.0.1:5173/app?mode=other')).toBe(false);
    expect(policy.isTrustedUrl('http://user@127.0.0.1:5173/app?mode=dev')).toBe(
      false
    );
    expect(policy.isTrustedUrl('http://127.0.0.1.evil.test:5173/app?mode=dev')).toBe(
      false
    );
  });

  it('rejects unsafe development server configuration', () => {
    const create = (devServerUrl: string) =>
      createRendererTrustPolicy({
        isPackaged: false,
        rendererFilePath,
        devServerUrl
      });

    expect(() => create('https://127.0.0.1:5173/')).toThrow('must use HTTP');
    expect(() => create('http://localhost:5173/')).toThrow('must use 127.0.0.1');
    expect(() => create('http://[::1]:5173/')).toThrow('must use 127.0.0.1');
    expect(() => create('https://example.com/')).toThrow('must use HTTP');
    expect(() => create('file:///tmp/index.html')).toThrow('must use HTTP');
    expect(() => create('http://user:secret@localhost:5173/')).toThrow(
      'must not contain credentials'
    );
    expect(() => create('not a url')).toThrow('valid URL');
  });

  it('uses the local renderer file when development has no server URL', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: false,
      rendererFilePath
    });

    expect(policy.kind).toBe('file');
    expect(policy.entryUrl).toBe(pathToFileURL(rendererFilePath).href);
  });
});

describe('renderer permission and external URL policy', () => {
  const policy = createRendererTrustPolicy({
    isPackaged: false,
    rendererFilePath,
    devServerUrl: 'http://127.0.0.1:5173/'
  });

  it('allows only sanitized clipboard writes from the trusted main frame', () => {
    const base = {
      permission: 'clipboard-sanitized-write',
      requestingUrl: policy.entryUrl,
      isMainFrame: true,
      senderMatches: true
    };

    expect(isTrustedRendererPermissionRequest(base, policy)).toBe(true);
    expect(
      isTrustedRendererPermissionRequest({ ...base, permission: 'clipboard-read' }, policy)
    ).toBe(false);
    expect(
      isTrustedRendererPermissionRequest({ ...base, isMainFrame: false }, policy)
    ).toBe(false);
    expect(
      isTrustedRendererPermissionRequest({ ...base, senderMatches: false }, policy)
    ).toBe(false);
    expect(
      isTrustedRendererPermissionRequest(
        { ...base, requestingUrl: 'https://evil.example/' },
        policy
      )
    ).toBe(false);
  });

  it('allows safe HTTPS links while rejecting privileged or ambiguous schemes', () => {
    expect(isSafeExternalUrl('https://github.com/example/repo/pull/1')).toBe(true);
    expect(isSafeExternalUrl('http://github.com/example/repo/pull/1')).toBe(false);
    expect(isSafeExternalUrl('file:///tmp/private.txt')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('https://user:secret@example.com/')).toBe(false);
    expect(isSafeExternalUrl('not a URL')).toBe(false);
  });
});

describe('trusted IPC sender validation', () => {
  it('requires the exact live webContents, its main frame, and a trusted URL', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: false,
      rendererFilePath,
      devServerUrl: 'http://127.0.0.1:5173/'
    });
    const mainFrame: IpcFrameLike = { url: 'http://127.0.0.1:5173/' };
    const trustedWebContents: IpcWebContentsLike = {
      mainFrame,
      isDestroyed: () => false
    };
    const untrustedMainFrame: IpcFrameLike = { url: 'https://example.com/' };
    const untrustedLocationWebContents: IpcWebContentsLike = {
      mainFrame: untrustedMainFrame,
      isDestroyed: () => false
    };

    expect(
      isTrustedIpcInvokeEvent(
        { sender: trustedWebContents, senderFrame: mainFrame },
        trustedWebContents,
        policy
      )
    ).toBe(true);
    expect(
      isTrustedIpcInvokeEvent(
        {
          sender: { mainFrame, isDestroyed: () => false },
          senderFrame: mainFrame
        },
        trustedWebContents,
        policy
      )
    ).toBe(false);
    expect(
      isTrustedIpcInvokeEvent(
        {
          sender: trustedWebContents,
          senderFrame: { url: 'http://127.0.0.1:5173/' }
        },
        trustedWebContents,
        policy
      )
    ).toBe(false);
    expect(
      isTrustedIpcInvokeEvent(
        {
          sender: untrustedLocationWebContents,
          senderFrame: untrustedMainFrame
        },
        untrustedLocationWebContents,
        policy
      )
    ).toBe(false);
    expect(
      isTrustedIpcInvokeEvent(
        { sender: trustedWebContents, senderFrame: null },
        trustedWebContents,
        policy
      )
    ).toBe(false);
  });

  it('rejects a destroyed trusted webContents', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: false,
      rendererFilePath,
      devServerUrl: 'http://127.0.0.1:5173/'
    });
    const mainFrame: IpcFrameLike = { url: policy.entryUrl };
    const trustedWebContents: IpcWebContentsLike = {
      mainFrame,
      isDestroyed: () => true
    };

    expect(
      isTrustedIpcInvokeEvent(
        { sender: trustedWebContents, senderFrame: mainFrame },
        trustedWebContents,
        policy
      )
    ).toBe(false);
  });

  it('fails closed if Electron tears down the main frame during validation', () => {
    const policy = createRendererTrustPolicy({
      isPackaged: false,
      rendererFilePath,
      devServerUrl: 'http://127.0.0.1:5173/'
    });
    const senderFrame: IpcFrameLike = { url: policy.entryUrl };
    const trustedWebContents: IpcWebContentsLike = {
      get mainFrame(): IpcFrameLike {
        throw new Error('frame was detached');
      },
      isDestroyed: () => false
    };

    expect(
      isTrustedIpcInvokeEvent(
        { sender: trustedWebContents, senderFrame },
        trustedWebContents,
        policy
      )
    ).toBe(false);
  });
});
