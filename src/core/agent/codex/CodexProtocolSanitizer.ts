import { DesignToolProtocolSanitizer } from '../journal/AgentProtocolRedaction';
import { CODEX_ATTACHMENT_PROMPT_MARKER } from './CodexAttachmentDelivery';

const ATTACHMENT_INPUT_OMITTED = '[Task Monki attachment input omitted]';
const ATTACHMENT_PATH_OMITTED = '[Task Monki managed attachment path omitted]';
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
    } else {
      result[sanitizedKey] = sanitizeAttachmentValue(entry);
    }
  }
  return result;
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
