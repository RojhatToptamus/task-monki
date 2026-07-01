import { describe, expect, it } from 'vitest';
import type { ExternalToolProbeResult } from '../../shared/contracts';
import {
  buildExecutableTestRequest,
  selectExecutableDisplayStatus
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
