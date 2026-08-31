import { DesignToolProtocolSanitizer } from '../journal/AgentProtocolRedaction';
import { CODEX_ATTACHMENT_PROMPT_MARKER } from './CodexAttachmentDelivery';

const ATTACHMENT_INPUT_OMITTED = '[Task Monki attachment input omitted]';
const ATTACHMENT_PATH_OMITTED = '[Task Monki managed attachment path omitted]';
const MCP_TRANSPORT_OMITTED = '[Task Monki MCP transport omitted]';
const MANAGED_ATTACHMENT_PATH =
  /[\\/]attachments[\\/](?:tasks|staging|drafts)[\\/]/u;

export class CodexProtocolSanitizer {
  private readonly designTools = new DesignToolProtocolSanitizer();

  sanitizeRaw(raw: string, direction: 'INBOUND' | 'OUTBOUND'): string {
    const designSanitized = this.designTools.sanitizeRaw(raw, direction);
    try {
      return JSON.stringify(this.sanitizeValue(JSON.parse(designSanitized)));
    } catch {
      return sanitizeString(designSanitized);
    }
  }

  sanitizeValue<T>(value: T): T {
    return sanitizeAttachmentValue(this.designTools.sanitizeValue(value)) as T;
  }
}

function sanitizeAttachmentValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAttachmentValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const sanitizedKey = MANAGED_ATTACHMENT_PATH.test(key) ? ATTACHMENT_PATH_OMITTED : key;
    if (record.type === 'localImage' && key === 'path') {
      result[sanitizedKey] = ATTACHMENT_PATH_OMITTED;
    } else if (key === 'mcp_servers' && entry && typeof entry === 'object') {
      result[sanitizedKey] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([name, config]) => [
          name,
          sanitizeMcpTransport(config)
        ])
      );
    } else if (key.startsWith('mcp_servers.')) {
      result[sanitizedKey] = sanitizeMcpTransport(entry);
    } else {
      result[sanitizedKey] = sanitizeAttachmentValue(entry);
    }
  }
  return result;
}

function sanitizeMcpTransport(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return sanitizeAttachmentValue(value);
  }
  const config = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(config).map(([key, entry]) => [
      key,
      ['url', 'command', 'args', 'cwd'].includes(key)
        ? MCP_TRANSPORT_OMITTED
        : sanitizeAttachmentValue(entry)
    ])
  );
}

function sanitizeString(value: string): string {
  const markerIndex = value.indexOf(CODEX_ATTACHMENT_PROMPT_MARKER);
  const withoutAttachmentInput =
    markerIndex >= 0
      ? `${value.slice(0, markerIndex)}\n\n${ATTACHMENT_INPUT_OMITTED}`
      : value;
  return MANAGED_ATTACHMENT_PATH.test(withoutAttachmentInput)
    ? ATTACHMENT_PATH_OMITTED
    : withoutAttachmentInput;
}
