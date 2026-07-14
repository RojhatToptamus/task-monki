import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  authorizeDevApiRequest,
  consumeDevApiToken,
  createDevApiTokenLease,
  DEV_API_TOKEN_HEADER,
  devApiExpectedHost,
  devApiTokenPath,
  devRendererOrigin,
  isAllowedDevRendererRequest,
  parseDevPort,
  readBoundedBinary,
  readDevApiToken
} from './devApiSecurity';

describe('development API security', () => {
  it('parses only valid explicit ports', () => {
    expect(parseDevPort(undefined, 3099, 'PORT')).toBe(3099);
    expect(parseDevPort('5173', 3099, 'PORT')).toBe(5173);
    expect(() => parseDevPort('0', 3099, 'PORT')).toThrow(/between 1 and 65535/);
    expect(() => parseDevPort('12.5', 3099, 'PORT')).toThrow(/between 1 and 65535/);
    expect(() => parseDevPort('nope', 3099, 'PORT')).toThrow(/between 1 and 65535/);
  });

  it('keeps a rotating token outside the repository and removes only its own lease', async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const tokenPath = devApiTokenPath(port);
    expect(path.resolve(tokenPath).startsWith(path.resolve(os.tmpdir()))).toBe(true);

    const first = await createDevApiTokenLease(port);
    const second = await createDevApiTokenLease(port);
    try {
      expect(first.token).not.toBe(second.token);
      expect(readDevApiToken(port)).toBe(second.token);
      if (process.platform !== 'win32') {
        expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
      }

      await first.dispose();
      expect(readDevApiToken(port)).toBe(second.token);
    } finally {
      await second.dispose();
    }
    expect(readDevApiToken(port)).toBeUndefined();
  });

  it('consumes the filesystem rendezvous token into proxy memory exactly once', async () => {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    const lease = await createDevApiTokenLease(port);
    try {
      expect(consumeDevApiToken(port)).toBe(lease.token);
      expect(readDevApiToken(port)).toBeUndefined();
      expect(consumeDevApiToken(port)).toBeUndefined();
    } finally {
      await lease.dispose();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to proxy a token file whose permissions are no longer private',
    async () => {
      const port = 40_001 + Math.floor(Math.random() * 10_000);
      const lease = await createDevApiTokenLease(port);
      try {
        await fs.chmod(lease.tokenPath, 0o644);
        expect(readDevApiToken(port)).toBeUndefined();
        await fs.chmod(lease.tokenPath, 0o600);
        expect(readDevApiToken(port)).toBe(lease.token);
      } finally {
        await fs.chmod(lease.tokenPath, 0o600).catch(() => undefined);
        await lease.dispose();
      }
    }
  );

  it('requires the private token, proxy host, renderer origin, and same-origin fetch site', () => {
    const token = 'private-token';
    const expectedHost = devApiExpectedHost(3099);
    const expectedOrigin = devRendererOrigin(5173);
    const baseHeaders = {
      host: expectedHost,
      [DEV_API_TOKEN_HEADER]: token,
      origin: expectedOrigin,
      'sec-fetch-site': 'same-origin'
    };

    expect(
      authorizeDevApiRequest(
        { headers: { ...baseHeaders, [DEV_API_TOKEN_HEADER]: '' } },
        { token: '', expectedHost, expectedOrigin }
      )
    ).toBe('NOT_READY');

    expect(
      authorizeDevApiRequest({ headers: baseHeaders }, { token, expectedHost, expectedOrigin })
    ).toBeUndefined();
    expect(
      authorizeDevApiRequest(
        { headers: { ...baseHeaders, [DEV_API_TOKEN_HEADER]: 'wrong' } },
        { token, expectedHost, expectedOrigin }
      )
    ).toBe('UNAUTHORIZED');
    expect(
      authorizeDevApiRequest(
        { headers: { ...baseHeaders, host: 'evil.test' } },
        { token, expectedHost, expectedOrigin }
      )
    ).toBe('INVALID_HOST');
    expect(
      authorizeDevApiRequest(
        { headers: { ...baseHeaders, origin: 'https://evil.test' } },
        { token, expectedHost, expectedOrigin }
      )
    ).toBe('INVALID_ORIGIN');
    expect(
      authorizeDevApiRequest(
        { headers: { ...baseHeaders, 'sec-fetch-site': 'cross-site' } },
        { token, expectedHost, expectedOrigin }
      )
    ).toBe('INVALID_FETCH_SITE');
    const { 'sec-fetch-site': _fetchSite, ...headersWithoutFetchSite } = baseHeaders;
    expect(
      authorizeDevApiRequest(
        { headers: headersWithoutFetchSite },
        { token, expectedHost, expectedOrigin }
      )
    ).toBe('INVALID_FETCH_SITE');
  });

  it('lets the Vite guard reject hostile browser origins before proxying', () => {
    const expectedOrigin = devRendererOrigin(5173);
    expect(
      isAllowedDevRendererRequest(
        { origin: expectedOrigin, 'sec-fetch-site': 'same-origin' },
        expectedOrigin
      )
    ).toBe(true);
    expect(isAllowedDevRendererRequest({}, expectedOrigin)).toBe(false);
    expect(
      isAllowedDevRendererRequest(
        { origin: expectedOrigin },
        expectedOrigin
      )
    ).toBe(false);
    expect(
      isAllowedDevRendererRequest(
        { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
        expectedOrigin
      )
    ).toBe(false);
  });

  it('reads only bounded uncompressed binary attachment bodies', async () => {
    const accepted = requestBody(Buffer.from([1, 2, 3]), {
      'content-type': 'application/octet-stream',
      'content-length': '3'
    });
    await expect(readBoundedBinary(accepted, 3).then(Array.from)).resolves.toEqual([1, 2, 3]);

    await expect(
      readBoundedBinary(
        requestBody(Buffer.from([1]), { 'content-type': 'text/plain' }),
        3
      )
    ).rejects.toMatchObject({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(
      readBoundedBinary(
        requestBody(Buffer.from([1, 2, 3, 4]), {
          'content-type': 'application/octet-stream'
        }),
        3
      )
    ).rejects.toMatchObject({ statusCode: 413, code: 'REQUEST_BODY_TOO_LARGE' });
    await expect(
      readBoundedBinary(
        requestBody(Buffer.from([1]), {
          'content-type': 'application/octet-stream',
          'content-encoding': 'gzip'
        }),
        3
      )
    ).rejects.toMatchObject({ statusCode: 415, code: 'UNSUPPORTED_CONTENT_ENCODING' });
  });
});

function requestBody(
  bytes: Buffer,
  headers: http.IncomingHttpHeaders
): http.IncomingMessage {
  const request = Readable.from([bytes]) as http.IncomingMessage;
  Object.defineProperty(request, 'headers', { value: headers });
  return request;
}
