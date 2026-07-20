import { describe, expect, it } from 'vitest';
import { parseDiscourseCorrection, parseDiscourseReview } from './DiscourseStructuredOutput';

describe('structured discourse output', () => {
  it('accepts an evidence-scoped material concern', () => {
    expect(parseDiscourseReview(JSON.stringify({
      outcome: 'CONCERNS',
      reviewedScope: 'Lead answer against repository context',
      limitations: [],
      requiredAccessAvailable: true,
      concerns: [{
        targetClaim: 'The migration is reversible.',
        category: 'storage',
        severity: 'MATERIAL',
        confidence: 'HIGH',
        evidenceStatus: 'OBSERVED_CONTEXT',
        reason: 'The schema reader rejects older records.',
        evidence: 'The version guard is one-way.',
        suggestedResolution: 'Describe the migration as one-way.'
      }]
    }))).toMatchObject({ outcome: 'CONCERNS', concerns: [{ severity: 'MATERIAL' }] });
  });

  it('requires complete access for no-concern and a limitation for abstention', () => {
    expect(() => parseDiscourseReview(JSON.stringify({
      outcome: 'NO_CONCERN_FOUND',
      reviewedScope: 'answer',
      limitations: [],
      requiredAccessAvailable: false,
      concerns: []
    }))).toThrow('complete access');
    expect(() => parseDiscourseReview(JSON.stringify({
      outcome: 'ABSTAINED',
      reviewedScope: 'answer',
      limitations: [],
      requiredAccessAvailable: false,
      concerns: []
    }))).toThrow('explicit limitation');
  });

  it('parses an attributable defended correction outcome', () => {
    expect(parseDiscourseCorrection(JSON.stringify({
      outcome: 'DEFENDED',
      body: 'The original conclusion stands because the cited guard runs before dispatch.',
      limitations: []
    }))).toMatchObject({ outcome: 'DEFENDED' });
  });
});
