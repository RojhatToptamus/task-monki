import { describe, expect, it } from 'vitest';
import { parsePreviewSpec } from 'previewhost';
import { parse } from 'yaml';
import { PREVIEW_FRAMEWORK_CAPABILITIES_VERSION } from './PreviewFrameworkCapabilities';
import {
  buildPreviewRecipeGenerationInstruction,
  PREVIEW_RECIPE_GENERATION_EXAMPLES
} from './PreviewRecipeGenerationSupport';

describe('Preview recipe generation support', () => {
  it('keeps every supplied example accepted by the authoritative parser', () => {
    for (const yaml of Object.values(PREVIEW_RECIPE_GENERATION_EXAMPLES)) {
      expect(() => parsePreviewSpec(parse(yaml))).not.toThrow();
    }
  });

  it('publishes the structured read-only and output boundaries', () => {
    const instruction = buildPreviewRecipeGenerationInstruction({
      evidenceFileName: 'repository-evidence.json'
    });

    expect(instruction).toContain('repository-evidence.json');
    expect(instruction).toContain('Do not run the application');
    expect(instruction).toContain('Do not modify files');
    expect(instruction).toContain('Never reproduce or infer secret values');
    expect(instruction).toContain(PREVIEW_FRAMEWORK_CAPABILITIES_VERSION);
    expect(instruction).toContain('Do not include markdown, commentary, planning, progress');

  });
});
