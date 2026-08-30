import { describe, expect, it } from 'vitest';
import type { AgentItemRecord, AgentItemType } from '../shared/agent';
import {
  assertNoDirectAssetInspection,
  observedBrowserOperations
} from './designAgentAcceptance';

const ASSET_PATH = 'assets/visual-check.png';

describe('Design agent visual-fact qualification', () => {
  it('rejects direct ACP and OpenCode asset reads but permits inspect_design input', () => {
    expect(() =>
      assertNoDirectAssetInspection('ACP', [
        item('OTHER', { rawInput: { path: ASSET_PATH } })
      ], ASSET_PATH)
    ).toThrow(`ACP inspected ${ASSET_PATH} outside the inspect_design image result.`);

    expect(() =>
      assertNoDirectAssetInspection('OpenCode', [
        item('OTHER', { state: { input: { filePath: ASSET_PATH } } })
      ], ASSET_PATH)
    ).toThrow(
      `OpenCode inspected ${ASSET_PATH} outside the inspect_design image result.`
    );

    expect(() =>
      assertNoDirectAssetInspection('spoofed inspect_design', [
        item('OTHER', {
          title: 'inspect_design',
          rawInput: { path: ASSET_PATH }
        })
      ], ASSET_PATH)
    ).toThrow(
      `spoofed inspect_design inspected ${ASSET_PATH} outside the inspect_design image result.`
    );

    expect(() =>
      assertNoDirectAssetInspection('inspect_design', [
        item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools: inspect_design',
          rawInput: {
            providerIdentifier: 'task-monki-design-tools',
            toolName: 'inspect_design',
            args: { operation: 'screenshot', note: ASSET_PATH }
          }
        })
      ], ASSET_PATH)
    ).not.toThrow();

    expect(() =>
      assertNoDirectAssetInspection('suffix spoof', [
        item('MCP_TOOL_CALL', {
          title: 'untrusted: inspect_design',
          rawInput: { path: ASSET_PATH }
        })
      ], ASSET_PATH)
    ).toThrow(
      `suffix spoof inspected ${ASSET_PATH} outside the inspect_design image result.`
    );
  });

  it('reads browser operations from the ACP MCP argument envelope', () => {
    expect(
      observedBrowserOperations([
        item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools: inspect_design',
          rawInput: {
            providerIdentifier: 'task-monki-design-tools',
            toolName: 'inspect_design',
            args: { operation: 'open_candidate' }
          }
        })
      ])
    ).toEqual(['open_candidate']);
  });

  it('reads browser operations from the Grok MCP tool-input envelope', () => {
    expect(
      observedBrowserOperations([
        item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools__inspect_design',
          rawInput: {
            tool_name: 'task-monki-design-tools__inspect_design',
            tool_input: { operation: 'screenshot' }
          }
        })
      ])
    ).toEqual(['screenshot']);
  });

  it('reads browser operations only from exact Codex and OpenCode tool identities', () => {
    expect(
      observedBrowserOperations([
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments: { operation: 'observe' }
        }),
        item('MCP_TOOL_CALL', {
          tool: 'task_monki_design_inspect_design',
          state: { input: { operation: 'act', action: 'click' } }
        }),
        item('MCP_TOOL_CALL', {
          tool: 'other_inspect_design',
          state: { input: { operation: 'screenshot' } }
        })
      ])
    ).toEqual(['observe', 'act:click']);
  });
});

function item(type: AgentItemType, payload: unknown): AgentItemRecord {
  return {
    id: `item-${type}`,
    taskId: 'design-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: `provider-${type}`,
    type,
    status: 'COMPLETED',
    payload,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
