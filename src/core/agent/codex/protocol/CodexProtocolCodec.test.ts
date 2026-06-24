import { describe, expect, it } from 'vitest';
import {
  CodexProtocolDecodeError,
  decodeCodexProtocolMessage
} from './CodexProtocolCodec';

describe('CodexProtocolCodec', () => {
  it('decodes valid responses and rejects invalid response envelopes', () => {
    expect(
      decodeCodexProtocolMessage(JSON.stringify({ id: 1, result: { ok: true } }))
    ).toEqual({
      kind: 'response',
      response: { id: 1, result: { ok: true } }
    });

    expect(() =>
      decodeCodexProtocolMessage(
        JSON.stringify({
          id: 1,
          error: { code: 'bad', message: 'nope' }
        })
      )
    ).toThrow(CodexProtocolDecodeError);

    expect(() =>
      decodeCodexProtocolMessage(JSON.stringify({ id: 1 }))
    ).toThrow('exactly one of result or error');
  });

  it('distinguishes known generated server requests from unknown server requests', () => {
    expect(
      decodeCodexProtocolMessage(
        JSON.stringify({
          method: 'item/tool/requestUserInput',
          id: 7,
          params: { threadId: 'thread-1' }
        })
      ).kind
    ).toBe('serverRequest');

    expect(
      decodeCodexProtocolMessage(
        JSON.stringify({
          method: 'future/serverRequest',
          id: 'future-1',
          params: { threadId: 'thread-1' }
        })
      )
    ).toEqual({
      kind: 'unsupportedServerRequest',
      request: {
        method: 'future/serverRequest',
        id: 'future-1',
        params: { threadId: 'thread-1' }
      }
    });
  });
});
