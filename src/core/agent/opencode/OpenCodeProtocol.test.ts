import { describe, expect, it } from 'vitest';
import {
  mapOpenCodeModels,
  mapOpenCodeTodoSteps,
  normalizeOpenCodeEvent,
  openCodeErrorDiagnostic,
  parseOpenCodePermissionRules,
  parseOpenCodeProviderCatalog
} from './OpenCodeProtocol';

describe('OpenCodeProtocol', () => {
  it('strictly parses native session permission rules', () => {
    expect(parseOpenCodePermissionRules([
      { permission: 'edit', pattern: '*', action: 'ask' }
    ])).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }]);
    expect(() => parseOpenCodePermissionRules({ edit: 'ask' })).toThrow(
      'incompatible session permission policy'
    );
    expect(() => parseOpenCodePermissionRules([
      { permission: 'edit', pattern: '*', action: 'sometimes' }
    ])).toThrow('incompatible session permission policy');
    expect(() => parseOpenCodePermissionRules([
      { permission: 'edit', pattern: '*', action: 'ask', scope: 'unknown' }
    ])).toThrow('incompatible session permission policy');
  });

  it('preserves provider identity, variants, modalities, and native metadata', () => {
    const catalog = parseOpenCodeProviderCatalog({
      connected: ['anthropic', 'google'],
      default: { anthropic: 'claude-sonnet-4' },
      all: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4': {
              id: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              status: 'active',
              capabilities: {
                reasoning: true,
                input: { text: true, image: true, pdf: true }
              },
              variants: { low: {}, high: {} },
              limit: { context: 200_000 }
            }
          }
        },
        {
          id: 'google',
          name: 'Google',
          models: {
            gemini: {
              id: 'gemini',
              name: 'Gemini',
              status: 'deprecated',
              capabilities: { input: { text: true } }
            }
          }
        }
      ]
    });

    expect(mapOpenCodeModels(catalog)).toEqual([
      expect.objectContaining({
        id: 'opencode:anthropic/claude-sonnet-4',
        runtimeId: 'opencode',
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4',
        supportedReasoningEfforts: ['low', 'high'],
        inputModalities: ['text', 'image', 'pdf'],
        isDefault: true,
        native: expect.objectContaining({ limit: { context: 200_000 } })
      }),
      expect.objectContaining({
        id: 'opencode:google/gemini',
        hidden: true
      })
    ]);
  });

  it('fails closed when the provider catalog omits authoritative connection state', () => {
    expect(() =>
      parseOpenCodeProviderCatalog({
        all: [
          {
            id: 'anthropic',
            models: { claude: { id: 'claude' } }
          }
        ]
      })
    ).toThrow('missing authoritative connected-provider state');

    expect(() =>
      parseOpenCodeProviderCatalog({
        connected: ['anthropic', 42],
        all: [
          {
            id: 'anthropic',
            models: { claude: { id: 'claude' } }
          }
        ]
      })
    ).toThrow('missing authoritative connected-provider state');
  });

  it('unwraps global and durable event envelopes without losing the event id', () => {
    expect(
      normalizeOpenCodeEvent({
        directory: '/worktree',
        payload: {
          id: 'evt_1',
          type: 'session.status',
          properties: { sessionID: 'ses_1', status: { type: 'busy' } }
        }
      })
    ).toEqual({
      id: 'evt_1',
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'busy' } }
    });
    expect(
      normalizeOpenCodeEvent({
        id: 'evt_2',
        type: 'todo.updated',
        data: { sessionID: 'ses_1', todos: [] }
      })
    ).toEqual({
      id: 'evt_2',
      type: 'todo.updated',
      properties: { sessionID: 'ses_1', todos: [] }
    });
  });

  it('maps OpenCode todos to provider-neutral plan states', () => {
    expect(
      mapOpenCodeTodoSteps([
        { content: 'Inspect', status: 'completed' },
        { content: 'Implement', status: 'in_progress' },
        { content: 'Verify', status: 'pending' }
      ])
    ).toEqual([
      { step: 'Inspect', status: 'COMPLETED' },
      { step: 'Implement', status: 'IN_PROGRESS' },
      { step: 'Verify', status: 'PENDING' }
    ]);
  });

  it('extracts allowlisted provider-error fields without exposing response internals', () => {
    const diagnostic = openCodeErrorDiagnostic({
      name: 'APIError',
      data: {
        message: 'token expired or incorrect',
        statusCode: 401,
        isRetryable: false,
        responseHeaders: { authorization: 'Bearer provider-secret' },
        responseBody: '{"credential":"provider-secret"}',
        metadata: { url: 'https://provider.example/?api_key=provider-secret' }
      }
    });

    expect(diagnostic).toBe(
      'APIError: token expired or incorrect (status 401; not retryable)'
    );
    expect(diagnostic).not.toMatch(/provider-secret|response|metadata|provider\.example/iu);
  });

  it('redacts and bounds provider error diagnostics before durable use', () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const diagnostic = openCodeErrorDiagnostic(
      {
        name: 'APIError',
        data: {
          message: `Provider rejected credential ${opaque}. ${'🧪'.repeat(8_000)}`,
          statusCode: 500,
          isRetryable: true
        }
      },
      [opaque]
    );

    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(4 * 1024);
    expect(diagnostic).toContain('credential [REDACTED]');
    expect(diagnostic).toContain('[OpenCode diagnostic truncated]');
    expect(diagnostic).not.toContain(opaque);
  });

  it('preserves explicit abort diagnostics without assigning workflow meaning to them', () => {
    expect(
      openCodeErrorDiagnostic({
        name: 'MessageAbortedError',
        data: { message: 'Aborted' }
      })
    ).toBe('MessageAbortedError: Aborted');
  });
});
