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

  it('publishes the structured read-only and output boundaries', () => {
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
    expect(instruction).toContain('Do not include markdown, commentary, planning, progress');
    expect(PREVIEW_RECIPE_GENERATION_CONTRACT.output.requiredFields).toContain('yaml');
    expect(PREVIEW_RECIPE_GENERATION_CONTRACT.output.format).toContain(
      'Exactly one JSON object'
    );
    expect(PREVIEW_RECIPE_GENERATION_CONTRACT.safety).toContain(
      'Never emit credentials, tokens, passwords, private keys, connection strings containing credentials, or values from secret-bearing files.'
    );
    expect(PREVIEW_RECIPE_GENERATION_CONTRACT.evidencePaths.allowed).toEqual([
      'files[].path',
      'frameworkCapabilities.analyses[].dependencyPreparation.lockfilePath',
      'publicEnvironment.templates[].path'
    ]);
  });
});
