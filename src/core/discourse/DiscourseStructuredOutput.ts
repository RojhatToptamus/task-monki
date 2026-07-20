import type {
  DiscourseConcernConfidence,
  DiscourseConcernEvidenceStatus,
  DiscourseConcernSeverity,
  DiscourseCorrectionOutcome,
  DiscourseReviewOutcome
} from '../../shared/discourse';

export interface ParsedDiscourseConcern {
  targetClaim: string;
  category: string;
  severity: DiscourseConcernSeverity;
  confidence: DiscourseConcernConfidence;
  evidenceStatus: DiscourseConcernEvidenceStatus;
  reason: string;
  evidence: string;
  suggestedResolution: string;
}

export interface ParsedDiscourseReview {
  outcome: DiscourseReviewOutcome;
  reviewedScope: string;
  limitations: string[];
  requiredAccessAvailable: boolean;
  concerns: ParsedDiscourseConcern[];
}

export interface ParsedDiscourseCorrection {
  outcome: DiscourseCorrectionOutcome;
  body: string;
  limitations: string[];
}

export function parseDiscourseReview(value: string): ParsedDiscourseReview {
  const record = parseRecord(value, 'review');
  const outcome = requireEnum(record.outcome, [
    'CONCERNS',
    'NO_CONCERN_FOUND',
    'ABSTAINED'
  ] as const, 'review outcome');
  const reviewedScope = requireText(record.reviewedScope, 'reviewed scope', 2_000);
  const limitations = requireTextArray(record.limitations, 'review limitations', 8, 1_000);
  if (typeof record.requiredAccessAvailable !== 'boolean') {
    throw new Error('Discourse review required-access result is invalid.');
  }
  const rawConcerns = Array.isArray(record.concerns) ? record.concerns : [];
  if (rawConcerns.length > 8) throw new Error('Discourse review has too many concerns.');
  const concerns = rawConcerns.map((candidate): ParsedDiscourseConcern => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Discourse review concern is invalid.');
    }
    const concern = candidate as Record<string, unknown>;
    return {
      targetClaim: requireText(concern.targetClaim, 'target claim', 2_000),
      category: requireText(concern.category, 'concern category', 120),
      severity: requireEnum(concern.severity, ['ADVISORY', 'MATERIAL', 'BLOCKING'] as const, 'concern severity'),
      confidence: requireEnum(concern.confidence, ['LOW', 'MEDIUM', 'HIGH'] as const, 'concern confidence'),
      evidenceStatus: requireEnum(concern.evidenceStatus, ['OBSERVED_CONTEXT', 'CITED_SOURCE', 'LOGICAL_CONTRADICTION', 'SPECULATIVE'] as const, 'concern evidence status'),
      reason: requireText(concern.reason, 'concern reason', 4_000),
      evidence: requireText(concern.evidence, 'concern evidence', 4_000),
      suggestedResolution: requireText(concern.suggestedResolution, 'suggested resolution', 2_000)
    };
  });
  if (outcome === 'CONCERNS' && concerns.length === 0) {
    throw new Error('A concerns review requires at least one structured concern.');
  }
  if (outcome !== 'CONCERNS' && concerns.length > 0) {
    throw new Error('A no-concern or abstained review cannot carry concerns.');
  }
  if (outcome === 'NO_CONCERN_FOUND' && !record.requiredAccessAvailable) {
    throw new Error('No-concern requires complete access to the reviewed scope.');
  }
  if (!record.requiredAccessAvailable && outcome !== 'ABSTAINED') {
    throw new Error('A review without required access must abstain.');
  }
  if (outcome === 'ABSTAINED' && limitations.length === 0) {
    throw new Error('An abstained review requires an explicit limitation.');
  }
  return {
    outcome,
    reviewedScope,
    limitations,
    requiredAccessAvailable: record.requiredAccessAvailable,
    concerns
  };
}

export function parseDiscourseCorrection(value: string): ParsedDiscourseCorrection {
  const record = parseRecord(value, 'correction');
  const outcome = requireEnum(record.outcome, [
    'REVISED',
    'DEFENDED',
    'PARTIALLY_REVISED',
    'ACKNOWLEDGED_UNRESOLVED',
    'ABSTAINED'
  ] as const, 'correction outcome');
  const body = outcome === 'ABSTAINED'
    ? optionalText(record.body, 'correction body', 64 * 1024)
    : requireText(record.body, 'correction body', 64 * 1024);
  const limitations = requireTextArray(record.limitations, 'correction limitations', 8, 1_000);
  if (outcome === 'ABSTAINED' && limitations.length === 0) {
    throw new Error('An abstained correction requires an explicit limitation.');
  }
  return { outcome, body, limitations };
}

function optionalText(value: unknown, label: string, maxBytes: number): string {
  if (value === undefined || value === null || value === '') return '';
  return requireText(value, label, maxBytes);
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Discourse ${label} output is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Discourse ${label} output must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return value.trim();
}

function requireTextArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemBytes: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Discourse ${label} are invalid.`);
  }
  return value.map((item) => requireText(item, label, maxItemBytes));
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return value as T[number];
}
