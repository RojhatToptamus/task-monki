import { describe, expect, it } from 'vitest';
import { parsePreviewRecipe } from '../PreviewRecipeLoader';
import { PREVIEW_FRAMEWORK_CAPABILITIES_VERSION } from './PreviewFrameworkCapabilities';
import {
  buildPreviewRecipeGenerationInstruction,
  PREVIEW_RECIPE_GENERATION_CONTRACT,
  PREVIEW_RECIPE_GENERATION_EXAMPLES,
  PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION
} from './PreviewRecipeGenerationSupport';

describe('Preview recipe generation support', () => {
  it('keeps every supplied example accepted by the authoritative parser', () => {
    for (const yaml of Object.values(PREVIEW_RECIPE_GENERATION_EXAMPLES)) {
      expect(() => parsePreviewRecipe(yaml)).not.toThrow();
    }
  });

  it('publishes a versioned machine-readable contract and a strict output instruction', () => {
    const instruction = buildPreviewRecipeGenerationInstruction({
      evidenceFileName: 'repository-evidence.json'
    });

    expect(PREVIEW_RECIPE_GENERATION_CONTRACT.schemaVersion).toBe(
      PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION
    );
    expect(instruction).toContain('repository-evidence.json');
    expect(instruction).toContain('Do not run the application');
    expect(instruction).toContain('Do not modify files');
    expect(instruction).toContain('Never reproduce or infer secret values');
    expect(instruction).toContain(PREVIEW_FRAMEWORK_CAPABILITIES_VERSION);
    expect(instruction).toContain('compatiblePreviewCommand');
    expect(instruction).toContain('copy those lines exactly');
    expect(instruction).toContain('Do not report the listed port, protocol, or hostname conflicts as unresolved');
    expect(instruction).toContain('insufficient-evidence');
    expect(instruction).toContain('Every evidence path must exist');
  });
});
