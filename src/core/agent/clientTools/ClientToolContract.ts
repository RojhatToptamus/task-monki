import type { AgentRunMode, AgentSessionRole } from '../../../shared/agent';
import type { AgentRuntimePurpose } from '../../../shared/agentRuntime';

export const CLIENT_TOOL_MAX_TEXT_BYTES = 32 * 1024;
export const CLIENT_TOOL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** One app-owned tool as the provider sees it: a name, a description, and a JSON schema for its input. */
export interface ClientToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool handler returns: bounded text and, for browser tools, one PNG. */
export interface ClientToolResult {
  text: string;
  image?: { mimeType: 'image/png'; bytes: Buffer; width: number; height: number };
}

export type ClientToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };

/**
 * The app-owned tools one kind of agent session may call. The orchestrator grants the set's
 * tool names to each run of that mode, and the bridge accepts a call only from a run that holds
 * the grant for the exact tool.
 */
export interface ClientToolSet {
  id: 'design' | 'preview';
  /** The product surface the set serves, for messages. */
  label: 'Design' | 'Preview';
  mode: AgentRunMode;
  purpose: AgentRuntimePurpose;
  sessionRole: AgentSessionRole;
  definitions: readonly ClientToolDefinition[];
  /** The definitions' names: what runs are granted and what the bridge admits. */
  tools: readonly string[];
  /** The MCP server name ACP agents register; provider tool titles derive from it. */
  mcpServerName: string;
  /** The MCP server name OpenCode registers; it allows only word characters. */
  openCodeServerName: string;
}

export function clientToolContent(result: ClientToolResult): ClientToolContent[] {
  if (Buffer.byteLength(result.text, 'utf8') > CLIENT_TOOL_MAX_TEXT_BYTES) {
    throw new Error('The tool text result is too large.');
  }
  if (!result.image) return [{ type: 'text', text: result.text }];
  if (
    result.image.mimeType !== 'image/png' ||
    result.image.bytes.byteLength > CLIENT_TOOL_MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(result.image.width) ||
    result.image.width <= 0 ||
    !Number.isSafeInteger(result.image.height) ||
    result.image.height <= 0
  ) {
    throw new Error('The tool image result is invalid.');
  }
  return [
    { type: 'text', text: result.text },
    { type: 'image', data: result.image.bytes.toString('base64'), mimeType: result.image.mimeType }
  ];
}

/** Tool failures reach the provider as text; paths and oversized messages never do. */
export function safeClientToolFailure(error: unknown, fallback = 'The tool operation failed.'): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message.length > 0 && message.length <= 1_000 && !message.includes('/') && !message.includes('\\')
    ? message
    : fallback;
}
