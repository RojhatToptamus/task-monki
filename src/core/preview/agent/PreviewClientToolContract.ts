import type { ClientToolDefinition } from '../../agent/clientTools/ClientToolContract';

import { INSPECT_PREVIEW_TOOL_NAME, PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME } from '../../../shared/clientTools';

export { INSPECT_PREVIEW_TOOL_NAME, PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME };
export const PREVIEW_TOOL_NAMES = [INSPECT_PREVIEW_TOOL_NAME, PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME] as const;

const MAX_LOG_LINES = 400;
const MAX_PROPOSAL_BYTES = 65_536;
const MAX_SUMMARY_LENGTH = 1_200;
const MAX_NOTES = 20;

export const INSPECT_PREVIEW_TOOL_DEFINITION: ClientToolDefinition = {
  name: INSPECT_PREVIEW_TOOL_NAME,
  description:
    'Read the current Preview state, registered repository checkouts, required secret references and their services, failure diagnosis, and bounded logs with secrets concealed. Read-only; listing a repository does not grant file access.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['what'],
    properties: {
      what: {
        type: 'string',
        enum: ['status', 'logs'],
        description: '"status" returns configuration, runs, services, requirements and diagnosis. "logs" returns the latest run’s output.'
      },
      source: {
        type: 'string',
        maxLength: 64,
        description: 'For logs: one service or step name. Omit for the whole run.'
      },
      lines: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LOG_LINES,
        description: `For logs: how many final lines to return (default 120, at most ${MAX_LOG_LINES}).`
      }
    }
  }
};

export const PROPOSE_PREVIEW_CONFIGURATION_TOOL_DEFINITION: ClientToolDefinition = {
  name: PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME,
  description:
    'Submit a complete preview.yaml for the user to review. Task Monki validates it against the Preview contract and returns the exact problems if it is rejected, so correct and resubmit. A valid proposal opens in the Configuration tab; the user saves, starts and approves. Nothing runs when you call this.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['yaml', 'summary'],
    properties: {
      yaml: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_PROPOSAL_BYTES,
        description: 'The full file content. YAML 1.2, no aliases, merge keys or tags, relative paths, never secret values.'
      },
      summary: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_SUMMARY_LENGTH,
        description: 'One to four sentences on what runs and why, written for the person reviewing the file.'
      },
      notes: {
        type: 'array',
        maxItems: MAX_NOTES,
        items: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_LENGTH },
        description: 'Facts the proposal rests on, assumptions the user should confirm, and what was deliberately left out.'
      }
    }
  }
};

export type InspectPreviewArguments =
  | { what: 'status' }
  | { what: 'logs'; source?: string; lines: number };

export interface ProposePreviewConfigurationArguments {
  yaml: string;
  summary: string;
  notes: string[];
}

export function parseInspectPreviewArguments(value: unknown): InspectPreviewArguments {
  const record = asRecord(value, INSPECT_PREVIEW_TOOL_NAME);
  if (record.what === 'status') {
    assertOnlyKeys(record, ['what'], INSPECT_PREVIEW_TOOL_NAME);
    return { what: 'status' };
  }
  if (record.what === 'logs') {
    assertOnlyKeys(record, ['what', 'source', 'lines'], INSPECT_PREVIEW_TOOL_NAME);
    const source = record.source === undefined ? undefined : requireString(record.source, 'source', 64);
    const lines = record.lines === undefined ? 120 : record.lines;
    if (!Number.isInteger(lines) || (lines as number) < 1 || (lines as number) > MAX_LOG_LINES) {
      throw new Error(`inspect_preview lines must be an integer from 1 to ${MAX_LOG_LINES}.`);
    }
    return { what: 'logs', source, lines: lines as number };
  }
  throw new Error('inspect_preview requires what: "status" or "logs".');
}

export function parseProposePreviewConfigurationArguments(value: unknown): ProposePreviewConfigurationArguments {
  const record = asRecord(value, PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME);
  assertOnlyKeys(record, ['yaml', 'summary', 'notes'], PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME);
  const yaml = requireString(record.yaml, 'yaml', MAX_PROPOSAL_BYTES);
  const summary = requireString(record.summary, 'summary', MAX_SUMMARY_LENGTH);
  const notes = record.notes === undefined ? [] : record.notes;
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) {
    throw new Error(`propose_preview_configuration notes must be a list of at most ${MAX_NOTES} strings.`);
  }
  return {
    yaml,
    summary,
    notes: notes.map((note, index) => requireString(note, `notes[${index}]`, MAX_SUMMARY_LENGTH))
  };
}

function asRecord(value: unknown, tool: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tool} requires an object argument.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${tool} does not accept ${unknown.join(', ')}.`);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  if (value.length > maxLength) throw new Error(`${field} is longer than ${maxLength} characters.`);
  return value;
}
