import { describe, expect, it } from 'vitest';
import type { ExternalToolProbeResult } from '../../shared/contracts';
import {
  areRequiredExternalToolsReady,
  buildExecutableTestRequest,
  selectExecutableDisplayStatus,
  shouldShowExecutablePathControls
} from './executableSettings';

describe('executable settings model', () => {
  it('builds Auto test requests without a custom executable override', () => {
    expect(buildExecutableTestRequest('codex', 'auto', '/draft/codex')).toEqual({
      tool: 'codex',
      executablePath: null
    });
  });

  it('builds Custom test requests from the trimmed draft path', () => {
    expect(buildExecutableTestRequest('codex', 'custom', '  /draft/codex  ')).toEqual({
      tool: 'codex',
      executablePath: '/draft/codex'
    });
  });

  it('shows the latest transient test result ahead of saved status', () => {
    const saved = toolResult({
      source: 'auto',
      executable: 'codex',
      resolvedPath: '/path/codex',
      version: 'codex-cli saved'
    });
    const tested = toolResult({
      source: 'override',
      executable: '/draft/codex',
      resolvedPath: '/draft/codex',
      version: 'codex-cli draft'
    });

    expect(selectExecutableDisplayStatus(saved, tested)).toBe(tested);
  });

  it('shows path controls when discovery fails or a custom path exists', () => {
    expect(
      shouldShowExecutablePathControls(
        toolResult({
          status: 'error',
          error: 'not found'
        }),
        null
      )
    ).toBe(true);
    expect(
      shouldShowExecutablePathControls(toolResult({ status: 'ok' }), '/usr/local/bin/codex')
    ).toBe(true);
    expect(shouldShowExecutablePathControls(toolResult({ status: 'ok' }), null)).toBe(false);
  });

  it('requires Git and Codex before setup can finish', () => {
    expect(
      areRequiredExternalToolsReady({
        refreshedAt: '2026-07-05T12:00:00.000Z',
        tools: {
          git: toolResult({ tool: 'git', label: 'Git', status: 'ok', required: true }),
          codex: toolResult({ tool: 'codex', label: 'Codex CLI', status: 'ok', required: true }),
          gh: toolResult({ tool: 'gh', label: 'GitHub CLI', status: 'error', required: false })
        }
      })
    ).toBe(true);
    expect(
      areRequiredExternalToolsReady({
        refreshedAt: '2026-07-05T12:00:00.000Z',
        tools: {
          git: toolResult({ tool: 'git', label: 'Git', status: 'ok', required: true }),
          codex: toolResult({
            tool: 'codex',
            label: 'Codex CLI',
            status: 'error',
            required: true
          }),
          gh: toolResult({ tool: 'gh', label: 'GitHub CLI', status: 'ok', required: false })
        }
      })
    ).toBe(false);
    expect(areRequiredExternalToolsReady(undefined)).toBe(false);
  });
});

function toolResult(
  overrides: Partial<ExternalToolProbeResult>
): ExternalToolProbeResult {
  return {
    tool: 'codex',
    label: 'Codex CLI',
    required: true,
    source: 'auto',
    configuredPath: null,
    executable: 'codex',
    resolvedPath: null,
    status: 'ok',
    version: null,
    error: null,
    ...overrides
  };
}
