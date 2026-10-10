import type { AgentRunMode } from '../../../shared/agent';
import { INSPECT_DESIGN_TOOL_DEFINITION } from '../../design/DesignClientToolContract';
import {
  INSPECT_PREVIEW_TOOL_DEFINITION,
  PROPOSE_PREVIEW_CONFIGURATION_TOOL_DEFINITION
} from '../../preview/agent/PreviewClientToolContract';
import type { ClientToolSet } from './ClientToolContract';

/** The Design agent verifies its candidate in the app browser. */
export const DESIGN_CLIENT_TOOLS = defineClientToolSet({
  id: 'design',
  label: 'Design',
  mode: 'DESIGN',
  purpose: 'TASK_DESIGN',
  sessionRole: 'PRIMARY',
  definitions: [INSPECT_DESIGN_TOOL_DEFINITION],
  mcpServerName: 'task-monki-design-tools',
  openCodeServerName: 'task_monki_design'
});

/** The Preview agent reads preview state and submits configuration proposals for review. */
export const PREVIEW_CLIENT_TOOLS = defineClientToolSet({
  id: 'preview',
  label: 'Preview',
  mode: 'PREVIEW',
  purpose: 'TASK_PREVIEW',
  sessionRole: 'PREVIEW',
  definitions: [INSPECT_PREVIEW_TOOL_DEFINITION, PROPOSE_PREVIEW_CONFIGURATION_TOOL_DEFINITION],
  mcpServerName: 'task-monki-preview-tools',
  openCodeServerName: 'task_monki_preview'
});

export const CLIENT_TOOL_SETS = [DESIGN_CLIENT_TOOLS, PREVIEW_CLIENT_TOOLS] as const;

/** Which app-owned tools a run of this mode may call; most modes get none. */
export function clientToolSetForMode(mode: AgentRunMode): ClientToolSet | undefined {
  return CLIENT_TOOL_SETS.find((set) => set.mode === mode);
}

export function clientToolSet(id: ClientToolSet['id']): ClientToolSet {
  return CLIENT_TOOL_SETS.find((set) => set.id === id)!;
}

/** Whether any set defines a tool with this name; the adapters use it to recognize provider calls cheaply. */
export function isClientToolName(name: string): boolean {
  return CLIENT_TOOL_SETS.some((set) => set.tools.includes(name));
}

function defineClientToolSet(set: Omit<ClientToolSet, 'tools'>): ClientToolSet {
  return { ...set, tools: set.definitions.map((definition) => definition.name) };
}
