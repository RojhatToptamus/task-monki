import { describe, expect, it } from 'vitest';
import {
  DESIGN_TOOL_MAX_IMAGE_BYTES,
  DESIGN_TOOL_MAX_TEXT_BYTES,
  designClientToolContent,
  INSPECT_DESIGN_TOOL_DEFINITION,
  safeDesignClientToolFailure
} from './DesignClientToolContract';

describe('DesignClientToolContract', () => {
  it('defines the one path-free Design browser tool', () => {
    expect(INSPECT_DESIGN_TOOL_DEFINITION).toMatchObject({
      name: 'inspect_design',
      inputSchema: {
        additionalProperties: false,
        required: ['operation']
      }
    });
    expect(
      JSON.stringify(INSPECT_DESIGN_TOOL_DEFINITION.inputSchema)
    ).not.toMatch(/"(?:path|url|taskId|runId|browserConfig)"/u);
  });

  it('maps bounded text and PNG bytes to native MCP content', () => {
    expect(
      designClientToolContent({
        text: 'observed',
        image: {
          mimeType: 'image/png',
          bytes: Buffer.from('png'),
          width: 640,
          height: 480
        }
      })
    ).toEqual([
      { type: 'text', text: 'observed' },
      {
        type: 'image',
        data: Buffer.from('png').toString('base64'),
        mimeType: 'image/png'
      }
    ]);
  });

  it('rejects oversized tool output and redacts path-bearing failures', () => {
    expect(() =>
      designClientToolContent({ text: 'x'.repeat(DESIGN_TOOL_MAX_TEXT_BYTES + 1) })
    ).toThrow('text result is too large');
    expect(() =>
      designClientToolContent({
        text: 'observed',
        image: {
          mimeType: 'image/png',
          bytes: Buffer.alloc(DESIGN_TOOL_MAX_IMAGE_BYTES + 1),
          width: 1,
          height: 1
        }
      })
    ).toThrow('image result is invalid');
    expect(safeDesignClientToolFailure(new Error('/private/tmp/evidence.png failed'))).toBe(
      'The Design browser operation failed. Correct the source or open a fresh candidate.'
    );
  });
});
