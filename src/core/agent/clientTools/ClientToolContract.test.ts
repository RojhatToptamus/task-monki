import { describe, expect, it } from 'vitest';
import {
  CLIENT_TOOL_MAX_IMAGE_BYTES,
  CLIENT_TOOL_MAX_TEXT_BYTES,
  clientToolContent,
  safeClientToolFailure
} from './ClientToolContract';
import { clientToolSetForMode, DESIGN_CLIENT_TOOLS, PREVIEW_CLIENT_TOOLS } from './ClientToolSets';

describe('ClientToolContract', () => {
  it('maps bounded text and PNG bytes to native MCP content', () => {
    expect(
      clientToolContent({
        text: 'observed',
        image: { mimeType: 'image/png', bytes: Buffer.from('png'), width: 640, height: 480 }
      })
    ).toEqual([
      { type: 'text', text: 'observed' },
      { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }
    ]);
  });

  it('rejects oversized tool output and redacts path-bearing failures', () => {
    expect(() => clientToolContent({ text: 'x'.repeat(CLIENT_TOOL_MAX_TEXT_BYTES + 1) })).toThrow('text result is too large');
    expect(() =>
      clientToolContent({
        text: 'observed',
        image: { mimeType: 'image/png', bytes: Buffer.alloc(CLIENT_TOOL_MAX_IMAGE_BYTES + 1), width: 1, height: 1 }
      })
    ).toThrow('image result is invalid');
    expect(safeClientToolFailure(new Error('/private/tmp/evidence.png failed'))).toBe('The tool operation failed.');
    expect(safeClientToolFailure(new Error('Choose one supported operation.'))).toBe('Choose one supported operation.');
  });

  it('grants each agent mode only its own tool set', () => {
    expect(clientToolSetForMode('DESIGN')).toBe(DESIGN_CLIENT_TOOLS);
    expect(clientToolSetForMode('PREVIEW')).toBe(PREVIEW_CLIENT_TOOLS);
    expect(clientToolSetForMode('IMPLEMENTATION')).toBeUndefined();
    expect(PREVIEW_CLIENT_TOOLS.tools).toEqual(['inspect_preview', 'propose_preview_configuration']);
    expect(new Set([DESIGN_CLIENT_TOOLS.mcpServerName, PREVIEW_CLIENT_TOOLS.mcpServerName]).size).toBe(2);
  });
});
