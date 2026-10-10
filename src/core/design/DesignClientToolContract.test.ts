import { describe, expect, it } from 'vitest';
import { INSPECT_DESIGN_TOOL_DEFINITION, safeDesignClientToolFailure } from './DesignClientToolContract';

describe('DesignClientToolContract', () => {
  it('keeps browser identity and connection authority out of the Design tool input', () => {
    expect(INSPECT_DESIGN_TOOL_DEFINITION).toMatchObject({
      name: 'inspect_design',
      inputSchema: {
        additionalProperties: false,
        required: ['operation']
      }
    });
    expect(
      JSON.stringify(INSPECT_DESIGN_TOOL_DEFINITION.inputSchema)
    ).not.toMatch(/"(?:url|taskId|runId|browserConfig)"/u);
  });

  it('replaces path-bearing failures with the Design fallback', () => {
    expect(safeDesignClientToolFailure(new Error('/private/tmp/evidence.png failed'))).toBe(
      'The Design browser operation failed. Correct the source or open a fresh candidate.'
    );
    expect(safeDesignClientToolFailure(new Error('Open a fresh candidate first.'))).toBe(
      'Open a fresh candidate first.'
    );
  });
});
