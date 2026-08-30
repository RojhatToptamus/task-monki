import { describe, expect, it } from 'vitest';
import type { AgentItemRecord, AgentItemType } from '../shared/agent';
import {
  assertNoDirectAssetInspection,
  observedBrowserOperations,
  parseFocusedDesignAgentScenario,
  resolveDesignAgentCandidateModel
} from './designAgentAcceptance';

const ASSET_PATH = 'assets/visual-check.png';

describe('Design agent visual-fact qualification', () => {
  it('rejects direct ACP and OpenCode asset reads but permits inspect_design input', () => {
    expect(() =>
      assertNoDirectAssetInspection('ACP', 'cursor-agent-acp', [
        item('OTHER', { rawInput: { path: ASSET_PATH } })
      ], ASSET_PATH)
    ).toThrow(`ACP inspected ${ASSET_PATH} outside the inspect_design image result.`);

    expect(() =>
      assertNoDirectAssetInspection('OpenCode', 'opencode', [
        item('OTHER', { state: { input: { filePath: ASSET_PATH } } })
      ], ASSET_PATH)
    ).toThrow(
      `OpenCode inspected ${ASSET_PATH} outside the inspect_design image result.`
    );

    expect(() =>
      assertNoDirectAssetInspection('spoofed inspect_design', 'cursor-agent-acp', [
        item('OTHER', {
          title: 'inspect_design',
          rawInput: { path: ASSET_PATH }
        })
      ], ASSET_PATH)
    ).toThrow(
      `spoofed inspect_design inspected ${ASSET_PATH} outside the inspect_design image result.`
    );

    expect(() =>
      assertNoDirectAssetInspection('inspect_design', 'cursor-agent-acp', [
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
      assertNoDirectAssetInspection('suffix spoof', 'cursor-agent-acp', [
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
      observedBrowserOperations('cursor-agent-acp', [
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
      observedBrowserOperations('grok-acp', [
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

  it('reads browser operations only from each runtime\'s exact identity', () => {
    expect(
      observedBrowserOperations('codex', [
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments: { operation: 'observe' }
        })
      ])
    ).toEqual(['observe']);
    expect(
      observedBrowserOperations('opencode', [
        item('MCP_TOOL_CALL', {
          tool: 'task_monki_design_inspect_design',
          state: { input: { operation: 'act', action: 'click' } }
        }),
        item('MCP_TOOL_CALL', {
          tool: 'other_inspect_design',
          state: { input: { operation: 'screenshot' } }
        })
      ])
    ).toEqual(['act:click']);
    expect(
      observedBrowserOperations('claude-agent-acp', [
        item('MCP_TOOL_CALL', {
          title: 'mcp__task-monki-design-tools__inspect_design',
          rawInput: { operation: 'screenshot' },
          _meta: {
            claudeCode: {
              toolName: 'mcp__task-monki-design-tools__inspect_design'
            }
          }
        })
      ])
    ).toEqual(['screenshot']);
    expect(
      observedBrowserOperations('cursor-agent-acp', [
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments: { operation: 'observe' }
        }),
        item('MCP_TOOL_CALL', {
          tool: 'task_monki_design_inspect_design',
          state: { input: { operation: 'screenshot' } }
        }),
        item('MCP_TOOL_CALL', {
          title: 'mcp__task-monki-design-tools__inspect_design',
          rawInput: { operation: 'screenshot' },
          _meta: {
            claudeCode: {
              toolName: 'mcp__task-monki-design-tools__inspect_design'
            }
          }
        })
      ])
    ).toEqual([]);
  });
});

describe('Design agent scenario selection', () => {
  it('selects the focused menu scenario without changing the default full run', () => {
    expect(parseFocusedDesignAgentScenario(undefined)).toBeUndefined();
    expect(parseFocusedDesignAgentScenario('  ')).toBeUndefined();
    expect(parseFocusedDesignAgentScenario(' menu-dialog-keyboard ')).toBe(
      'menu-dialog-keyboard'
    );
    expect(parseFocusedDesignAgentScenario('responsive-wide-narrow')).toBe(
      'responsive-wide-narrow'
    );
    expect(() => parseFocusedDesignAgentScenario('unknown')).toThrow(
      'Unknown Design agent scenario: unknown.'
    );
  });

  it('passes an explicit model through when it is only discoverable after session setup', () => {
    expect(
      resolveDesignAgentCandidateModel([], {
        runtimeId: 'claude-agent-acp',
        model: 'sonnet',
        modelProvider: 'anthropic'
      })
    ).toEqual({ selectedModel: undefined, modelProvider: 'anthropic' });
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
