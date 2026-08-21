import { describe, expect, it } from 'vitest';
import { sanitizeLabProtocolRecord } from './LabProviderRuntimeStore';

describe('sanitizeLabProtocolRecord', () => {
  it('removes completed reasoning while retaining public agent messages', () => {
    const reasoning = sanitizeLabProtocolRecord(JSON.stringify({
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reason-1', summary: ['secret'], content: ['private'] }
      }
    }));
    expect(JSON.parse(reasoning)).toMatchObject({
      params: { item: { type: 'reasoning', id: 'reason-1', summary: [], content: [] } }
    });

    const publicMessage = JSON.stringify({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'answer-1', text: '{"status":"ANSWER"}' } }
    });
    expect(sanitizeLabProtocolRecord(publicMessage)).toBe(publicMessage);
  });

  it('removes private reasoning nested in thread fork responses', () => {
    const sanitized = sanitizeLabProtocolRecord(JSON.stringify({
      id: 17,
      result: {
        thread: {
          id: 'fork-1',
          turns: [{
            id: 'turn-1',
            items: [
              {
                type: 'reasoning',
                id: 'reason-1',
                summary: ['private summary'],
                content: ['private reasoning']
              },
              {
                type: 'agentMessage',
                id: 'answer-1',
                text: '{"answer":"public"}'
              }
            ]
          }]
        }
      }
    }));

    expect(JSON.parse(sanitized)).toMatchObject({
      result: {
        thread: {
          turns: [{
            items: [
              {
                type: 'reasoning',
                id: 'reason-1',
                summary: [],
                content: []
              },
              {
                type: 'agentMessage',
                id: 'answer-1',
                text: '{"answer":"public"}'
              }
            ]
          }]
        }
      }
    });
    expect(sanitized).not.toContain('private summary');
    expect(sanitized).not.toContain('private reasoning');
  });

  it('leaves thread responses without reasoning byte-for-byte unchanged', () => {
    const raw = JSON.stringify({
      id: 18,
      result: {
        thread: {
          id: 'fork-2',
          turns: [{
            id: 'turn-2',
            items: [{ type: 'agentMessage', id: 'answer-2', text: 'public' }]
          }]
        }
      }
    });

    expect(sanitizeLabProtocolRecord(raw)).toBe(raw);
  });
});
