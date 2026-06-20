export interface ParsedJsonLine {
  ok: true;
  eventType: string;
  raw: Record<string, unknown>;
  isTerminal: boolean;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  messageText?: string;
}

export interface FailedJsonLine {
  ok: false;
  line: string;
  error: string;
}

export type JsonLineParseResult = ParsedJsonLine | FailedJsonLine;

const TERMINAL_COMPLETED_TYPES = new Set(['turn.completed', 'thread.completed', 'completed']);
const TERMINAL_FAILED_TYPES = new Set(['turn.failed', 'thread.failed', 'error']);
const TERMINAL_INTERRUPTED_TYPES = new Set(['turn.interrupted', 'interrupted']);

export function parseCodexJsonLine(line: string): JsonLineParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ok: false, line, error: 'Empty JSONL line.' };
  }

  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const eventType = getEventType(raw);
    const terminalStatus = getTerminalStatus(eventType, raw);

    return {
      ok: true,
      eventType,
      raw,
      isTerminal: terminalStatus !== undefined,
      terminalStatus,
      messageText: extractText(raw)
    };
  } catch (error) {
    return {
      ok: false,
      line,
      error: error instanceof Error ? error.message : 'Unknown JSON parse error.'
    };
  }
}

export function getEventType(raw: Record<string, unknown>): string {
  const candidates = [raw.type, raw.event, raw.name, raw.kind];
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return found ? String(found) : 'unknown';
}

function getTerminalStatus(
  eventType: string,
  raw: Record<string, unknown>
): ParsedJsonLine['terminalStatus'] {
  const explicitStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : undefined;

  if (TERMINAL_COMPLETED_TYPES.has(eventType) || explicitStatus === 'completed') {
    return 'completed';
  }

  if (TERMINAL_FAILED_TYPES.has(eventType) || explicitStatus === 'failed') {
    return 'failed';
  }

  if (TERMINAL_INTERRUPTED_TYPES.has(eventType) || explicitStatus === 'interrupted') {
    return 'interrupted';
  }

  return undefined;
}

export function extractText(raw: unknown): string | undefined {
  const visited = new Set<unknown>();
  const textParts: string[] = [];

  const visit = (value: unknown, keyHint?: string) => {
    if (value === null || value === undefined || visited.has(value)) {
      return;
    }

    if (typeof value === 'string') {
      if (shouldKeepText(keyHint, value)) {
        textParts.push(value);
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, keyHint);
      }
      return;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      visit(entry, key);
    }
  };

  visit(raw);

  const deduped = [...new Set(textParts.map((part) => part.trim()).filter(Boolean))];
  return deduped.length > 0 ? deduped.join('\n') : undefined;
}

function shouldKeepText(keyHint: string | undefined, value: string): boolean {
  if (!keyHint) {
    return false;
  }

  const normalized = keyHint.toLowerCase();
  if (!['text', 'content', 'message', 'summary', 'final_message'].includes(normalized)) {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return false;
  }

  return true;
}
