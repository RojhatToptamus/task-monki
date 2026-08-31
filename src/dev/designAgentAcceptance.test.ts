import { describe, expect, it } from 'vitest';
import type { AgentItemRecord, AgentItemType } from '../shared/agent';
import {
  assertDisclosureEnterToggle,
  assertNoDirectAssetInspection,
  isInFlightInspectDesignWait,
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

  it('accepts a status-less active Grok wait call as cancellation admission evidence', () => {
    expect(
      isInFlightInspectDesignWait('grok-acp', {
        ...item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools__inspect_design',
          rawInput: {
            tool_name: 'task-monki-design-tools__inspect_design',
            tool_input: {
              operation: 'act',
              action: 'wait',
              milliseconds: 2_000
            }
          }
        }),
        status: 'UNKNOWN'
      })
    ).toBe(true);
  });

  it('does not treat a status-less Grok wait result as an in-flight call', () => {
    expect(
      isInFlightInspectDesignWait('grok-acp', {
        ...item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools__inspect_design',
          rawInput: {
            tool_name: 'task-monki-design-tools__inspect_design',
            tool_input: {
              operation: 'act',
              action: 'wait',
              milliseconds: 2_000
            }
          },
          rawOutput: { type: 'MCP' }
        }),
        status: 'UNKNOWN'
      })
    ).toBe(false);
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

  it('records the exact media scheme and motion setting used for Design verification', () => {
    expect(
      observedBrowserOperations('codex', [
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments: {
            operation: 'set_media',
            colorScheme: 'light',
            reducedMotion: false
          }
        }),
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments: {
            operation: 'set_media',
            colorScheme: 'dark',
            reducedMotion: true
          }
        })
      ])
    ).toEqual(['set_media:light:standard', 'set_media:dark:reduced']);
  });

  it.each([
    {
      runtimeId: 'codex',
      make: (action: 'focus' | 'key', output: string) =>
        item('DYNAMIC_TOOL_CALL', {
          type: 'dynamicToolCall',
          tool: 'inspect_design',
          arguments:
            action === 'focus'
              ? { operation: 'act', action, ref: 'e1' }
              : { operation: 'act', action, value: 'Enter' },
          contentItems: [{ type: 'inputText', text: output }]
        })
    },
    {
      runtimeId: 'opencode',
      make: (action: 'focus' | 'key', output: string) =>
        item('MCP_TOOL_CALL', {
          tool: 'task_monki_design_inspect_design',
          state: {
            input:
              action === 'focus'
                ? { operation: 'act', action, ref: 'e1' }
                : { operation: 'act', action, value: 'Enter' },
            output
          }
        })
    },
    {
      runtimeId: 'cursor-agent-acp',
      make: (action: 'focus' | 'key', output: string) =>
        item('MCP_TOOL_CALL', {
          title: 'task-monki-design-tools: inspect_design',
          rawInput: {
            providerIdentifier: 'task-monki-design-tools',
            toolName: 'inspect_design',
            args:
              action === 'focus'
                ? { operation: 'act', action, ref: '@e1' }
                : { operation: 'act', action, value: 'Enter' }
          },
          rawOutput: { content: [{ type: 'text', text: output }] }
        })
    }
  ])('proves the focused disclosure changes after Enter for $runtimeId', ({ runtimeId, make }) => {
    expect(() =>
      assertDisclosureEnterToggle('disclosure', runtimeId, [
        make('focus', 'button "Details" [expanded=false, ref=e1]'),
        make('key', 'button "Details" [expanded=true, ref=e1]')
      ])
    ).not.toThrow();
  });

  it('rejects weak or out-of-order disclosure interaction evidence', () => {
    const call = (
      action: 'focus' | 'key' | 'click',
      output: string,
      value?: string
    ) =>
      item('DYNAMIC_TOOL_CALL', {
        type: 'dynamicToolCall',
        tool: 'inspect_design',
        arguments: {
          operation: 'act',
          action,
          ...(action === 'focus' ? { ref: 'e1' } : {}),
          ...(value ? { value } : {})
        },
        contentItems: [{ type: 'inputText', text: output }]
      });
    const collapsed = 'button "Details" [expanded=false, ref=e1]';
    const expanded = 'button "Details" [expanded=true, ref=e1]';

    for (const items of [
      [call('key', expanded, 'Enter'), call('focus', collapsed)],
      [call('focus', collapsed), call('key', expanded, 'Space')],
      [call('focus', collapsed), call('click', expanded), call('key', collapsed, 'Enter')],
      [call('focus', collapsed), call('key', collapsed, 'Enter')]
    ]) {
      expect(() => assertDisclosureEnterToggle('disclosure', 'codex', items)).toThrow();
    }
  });

  it('accepts a later valid focus pair and does not confuse reference prefixes', () => {
    const call = (action: 'focus' | 'key', ref: string, output: string) =>
      item('DYNAMIC_TOOL_CALL', {
        type: 'dynamicToolCall',
        tool: 'inspect_design',
        arguments: {
          operation: 'act',
          action,
          ...(action === 'focus' ? { ref } : { value: 'Enter' })
        },
        contentItems: [{ type: 'inputText', text: output }]
      });

    expect(() =>
      assertDisclosureEnterToggle('disclosure', 'codex', [
        call('focus', 'unrelated', 'button "Other" [expanded=false, ref=unrelated]'),
        call('focus', 'e1', 'button "Details" [expanded=false, ref=e1]'),
        call('key', 'e1', 'button "Details" [expanded=true, ref=e1]')
      ])
    ).not.toThrow();
    expect(() =>
      assertDisclosureEnterToggle('disclosure', 'codex', [
        call('focus', 'e1', 'button "Other" [expanded=false, ref=e10]'),
        call('key', 'e1', 'button "Other" [expanded=true, ref=e10]')
      ])
    ).toThrow();
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
    expect(parseFocusedDesignAgentScenario('theme-errors-interaction')).toBe(
      'theme-errors-interaction'
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
