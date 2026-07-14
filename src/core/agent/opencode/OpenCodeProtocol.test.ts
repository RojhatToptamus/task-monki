import { describe, expect, it } from 'vitest';
import {
  mapOpenCodeModels,
  mapOpenCodeTodoSteps,
  normalizeOpenCodeEvent,
  parseOpenCodeProviderCatalog
} from './OpenCodeProtocol';

describe('OpenCodeProtocol', () => {
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
});
