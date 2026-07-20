import { describe, expect, it } from 'vitest';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
import {
  assessDiscourseJobBudget,
  type DiscourseJobBudgetInput
} from './DiscourseBudget';

describe('Discourse job budget', () => {
  it('accepts a representative eight-reference job within the whole-prompt envelope', () => {
    const assessment = assessDiscourseJobBudget(
      fixture({
        contextReferences: Array.from({ length: 8 }, (_, index) => ({
          referenceId: `reference-${index}`,
          filesystemRootId: `root-${index % 3}`,
          bytes: 48 * 1024,
          estimatedTokens: 4_000
        }))
      })
    );

    expect(assessment).toMatchObject({
      status: 'READY',
      sourceCount: 8,
      filesystemRootCount: 3,
      reservedOutputTokens: 16_000
    });
    expect(assessment.inputBytes).toBeLessThan(DISCOURSE_LIMITS.maxSnapshotBytes);
  });

  it('reports each selected source that exceeds the per-reference manifest limit', () => {
    const assessment = assessDiscourseJobBudget(
      fixture({
        contextReferences: [
          {
            referenceId: 'too-large',
            filesystemRootId: 'root-1',
            bytes: DISCOURSE_LIMITS.maxContextManifestBytesPerReference + 1,
            estimatedTokens: 1_000
          }
        ]
      })
    );

    expect(assessment.status).toBe('BLOCKED');
    expect(assessment.violations).toContainEqual({
      code: 'REFERENCE_MANIFEST_BYTES',
      actual: DISCOURSE_LIMITS.maxContextManifestBytesPerReference + 1,
      limit: DISCOURSE_LIMITS.maxContextManifestBytesPerReference,
      referenceId: 'too-large'
    });
  });

  it('blocks reference, root, transcript, summary, and wave-output limits explicitly', () => {
    const assessment = assessDiscourseJobBudget(
      fixture({
        contextReferences: Array.from({ length: 9 }, (_, index) => ({
          referenceId: `reference-${index}`,
          filesystemRootId: `root-${index % 4}`,
          bytes: 8 * 1024,
          estimatedTokens: 500
        })),
        transcript: {
          bytes: DISCOURSE_LIMITS.maxRecentTranscriptBytes + 1,
          estimatedTokens: DISCOURSE_LIMITS.maxRecentTranscriptTokens + 1,
          messageCount: DISCOURSE_LIMITS.maxRecentTranscriptMessages + 1
        },
        summary: {
          bytes: DISCOURSE_LIMITS.maxSummaryBytes + 1,
          estimatedTokens: 2_000
        },
        cumulativeWaveOutputBytes: DISCOURSE_LIMITS.maxWaveOutputBytes + 1
      })
    );

    expect(new Set(assessment.violations.map((violation) => violation.code))).toEqual(
      new Set([
        'CONTEXT_REFERENCE_COUNT',
        'FILESYSTEM_ROOT_COUNT',
        'TRANSCRIPT_MESSAGE_COUNT',
        'TRANSCRIPT_BYTES',
        'TRANSCRIPT_TOKENS',
        'SUMMARY_BYTES',
        'WAVE_OUTPUT_BYTES'
      ])
    );
  });

  it('reserves output before comparing input to the model safety ceiling', () => {
    const assessment = assessDiscourseJobBudget(
      fixture({
        modelContextTokens: 100_000,
        reservedOutputTokens: 20_000,
        transcript: { bytes: 64 * 1024, estimatedTokens: 59_000, messageCount: 40 }
      })
    );

    expect(assessment.promptTokenCeiling).toBe(60_000);
    expect(assessment.estimatedInputTokens).toBeGreaterThan(60_000);
    expect(assessment.violations).toContainEqual(
      expect.objectContaining({ code: 'PROMPT_TOKEN_BUDGET', limit: 60_000 })
    );
  });

  it('rejects malformed accounting instead of normalizing it', () => {
    expect(() =>
      assessDiscourseJobBudget(fixture({ humanMessage: { bytes: -1, estimatedTokens: 1 } }))
    ).toThrow('non-negative safe integers');
  });
});

function fixture(overrides: Partial<DiscourseJobBudgetInput> = {}): DiscourseJobBudgetInput {
  return {
    modelContextTokens: 200_000,
    systemAndRole: { bytes: 24 * 1024, estimatedTokens: 4_000 },
    humanMessage: { bytes: 8 * 1024, estimatedTokens: 2_000 },
    exactTargets: { bytes: 16 * 1024, estimatedTokens: 3_000 },
    contextReferences: [
      {
        referenceId: 'reference-1',
        filesystemRootId: 'root-1',
        bytes: 48 * 1024,
        estimatedTokens: 4_000
      }
    ],
    transcript: { bytes: 192 * 1024, estimatedTokens: 30_000, messageCount: 60 },
    summary: { bytes: 24 * 1024, estimatedTokens: 6_000 },
    phaseVisibleOutputs: { bytes: 64 * 1024, estimatedTokens: 12_000 },
    cumulativeWaveOutputBytes: 192 * 1024,
    ...overrides
  };
}
