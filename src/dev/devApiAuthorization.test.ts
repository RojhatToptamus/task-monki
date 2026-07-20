import { describe, expect, it } from 'vitest';
import { authorizeDevApiRequest, DEV_API_TOKEN_HEADER } from './devApiAuthorization';

const config = { token: 'seed-secret', rendererOrigin: 'http://127.0.0.1:5173' };

describe('authorizeDevApiRequest', () => {
  it('requires the server-side proxy token', () => {
    expect(authorizeDevApiRequest({}, config)).toEqual({
      authorized: false,
      reason: 'The development API token is missing or invalid.'
    });
    expect(authorizeDevApiRequest({ [DEV_API_TOKEN_HEADER]: 'wrong' }, config).authorized).toBe(
      false
    );
  });

  it('allows the configured renderer origin and local non-browser clients', () => {
    expect(
      authorizeDevApiRequest(
        { [DEV_API_TOKEN_HEADER]: config.token, origin: config.rendererOrigin },
        config
      ).authorized
    ).toBe(true);
    expect(
      authorizeDevApiRequest({ [DEV_API_TOKEN_HEADER]: config.token }, config).authorized
    ).toBe(true);
  });

  it('rejects a valid token presented by another browser origin', () => {
    expect(
      authorizeDevApiRequest(
        { [DEV_API_TOKEN_HEADER]: config.token, origin: 'http://127.0.0.1:43123' },
        config
      )
    ).toEqual({ authorized: false, reason: 'The browser origin is not authorized.' });
  });
});
