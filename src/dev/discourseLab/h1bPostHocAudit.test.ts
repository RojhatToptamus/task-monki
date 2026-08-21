import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildH1bV3PostHocAudit } from './h1bPostHocAudit';

const archivedReportPath = path.resolve(
  'docs/private/discourse-lab-runs/2026-08-01/h1b-development/runs',
  'h1b-development-2026-08-01T18-11-48-735Z-e267456d/reports',
  'h1b-development-result.json'
);

describe('archived H1b v3 post-hoc engineering diagnostic', () => {
  it('decomposes the preserved outputs without rewriting the frozen causal result', async () => {
    const report = await buildH1bV3PostHocAudit({
      fixtureRoot: path.resolve('evaluation/discourse-lab'),
      archivedReportPath
    });

    expect(report).toMatchObject({
      classification: 'POST_HOC_ENGINEERING_DIAGNOSTIC_NOT_CAUSAL_EVIDENCE',
      source: {
        preservedFrozenInterpretation: {
          overall: 'SAFETY_BLOCK',
          derivable: { status: 'ASSAY_NOT_INFORMATIVE' },
          evidence: { status: 'INCONCLUSIVE' }
        }
      },
      v3Boundary: {
        archivedTerminalOutputs: 54,
        rejectedByV3Parser: 54,
        expectedSchemaVersionRejections: 54,
        causalResultsRewritten: false
      },
      decomposedDiagnostics: {
        statuses: { ANSWER: 52, UNCERTAIN: 2 },
        abstentions: 0,
        confidence: { minimum: 0.99, maximum: 1, atLeastPoint99: 54 },
        typedInformationRequestRepresentable: 0,
        evidenceBaseOutputs: 18,
        evidenceBaseExactUndeterminedAnswers: 18,
        evidenceBaseTargetOpen: 12,
        evidenceBaseTargetReject: 6,
        evidenceBaseUserQuestions: 0,
        critiqueOutputs: 9,
        critiqueArtifactOrIssueCitedInClaims: 9,
        critiqueArtifactOrIssueCitedInIssues: 8,
        critiqueArtifactOrIssueCitedInResponses: 7,
        critiqueArtifactOrIssueCitedInDisagreements: 2,
        frozenPotentiallyInventedSignatureMismatches: 5,
        semanticInventedCriticismConclusions: 'NOT_AVAILABLE_FROM_SIGNATURES',
        minorityPreservation: 'NOT_ESTIMABLE_NO_SOCIAL_MINORITY_EXPOSURE'
      }
    });
  });
});
