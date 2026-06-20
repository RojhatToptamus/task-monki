import { describe, expect, it } from 'vitest';
import { parseCodexJsonLine } from './jsonlParser';

describe('parseCodexJsonLine', () => {
  it('parses a normal Codex event', () => {
    const parsed = parseCodexJsonLine('{"type":"turn.started","message":"hello"}');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.eventType).toBe('turn.started');
      expect(parsed.isTerminal).toBe(false);
      expect(parsed.messageText).toBe('hello');
    }
  });

  it('detects terminal completion events', () => {
    const parsed = parseCodexJsonLine('{"type":"turn.completed","status":"completed"}');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.isTerminal).toBe(true);
      expect(parsed.terminalStatus).toBe('completed');
    }
  });

  it('returns a structured error for malformed lines', () => {
    const parsed = parseCodexJsonLine('{not-json');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('Expected');
    }
  });

  it('keeps unknown events without failing', () => {
    const parsed = parseCodexJsonLine('{"custom":"value"}');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.eventType).toBe('unknown');
    }
  });
});
