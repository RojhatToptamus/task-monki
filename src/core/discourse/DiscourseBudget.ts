import { DISCOURSE_LIMITS } from '../../shared/discourse';

export const DISCOURSE_BUDGET_POLICY_VERSION = 1 as const;

export interface DiscourseBudgetMeasure {
  bytes: number;
  estimatedTokens: number;
}

export interface DiscourseReferenceBudgetMeasure extends DiscourseBudgetMeasure {
  referenceId: string;
  filesystemRootId?: string;
}

export interface DiscourseJobBudgetInput {
  modelContextTokens: number;
  reservedOutputTokens?: number;
  systemAndRole: DiscourseBudgetMeasure;
  humanMessage: DiscourseBudgetMeasure;
  exactTargets: DiscourseBudgetMeasure;
  contextReferences: DiscourseReferenceBudgetMeasure[];
  transcript: DiscourseBudgetMeasure & { messageCount: number };
  summary: DiscourseBudgetMeasure;
  phaseVisibleOutputs: DiscourseBudgetMeasure;
  cumulativeWaveOutputBytes: number;
}

export type DiscourseBudgetViolationCode =
  | 'HUMAN_MESSAGE_BYTES'
  | 'CONTEXT_REFERENCE_COUNT'
  | 'FILESYSTEM_ROOT_COUNT'
  | 'REFERENCE_MANIFEST_BYTES'
  | 'CONTEXT_MANIFEST_BYTES'
  | 'TRANSCRIPT_MESSAGE_COUNT'
  | 'TRANSCRIPT_BYTES'
  | 'TRANSCRIPT_TOKENS'
  | 'SUMMARY_BYTES'
  | 'WAVE_OUTPUT_BYTES'
  | 'PROMPT_TOKEN_BUDGET';

export interface DiscourseBudgetViolation {
  code: DiscourseBudgetViolationCode;
  actual: number;
  limit: number;
  referenceId?: string;
}

export interface DiscourseJobBudgetAssessment {
  policyVersion: typeof DISCOURSE_BUDGET_POLICY_VERSION;
  status: 'READY' | 'BLOCKED';
  inputBytes: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  modelContextTokens: number;
  promptTokenCeiling: number;
  sourceCount: number;
  filesystemRootCount: number;
  violations: DiscourseBudgetViolation[];
}

/**
 * Deterministic whole-job budget accounting. This function reports every hard
 * violation; it never chooses context to omit or silently shrinks a required
 * source. Token counts are estimates supplied by the versioned prompt builder.
 */
export function assessDiscourseJobBudget(
  input: DiscourseJobBudgetInput
): DiscourseJobBudgetAssessment {
  validateInput(input);
  const reservedOutputTokens =
    input.reservedOutputTokens ?? DISCOURSE_LIMITS.defaultReservedOutputTokens;
  const promptTokenCeiling = Math.max(
    0,
    Math.floor(
      (input.modelContextTokens * DISCOURSE_LIMITS.promptContextSafetyPermille) / 1_000
    ) - reservedOutputTokens
  );
  const referenceBytes = sum(input.contextReferences.map((reference) => reference.bytes));
  const referenceTokens = sum(
    input.contextReferences.map((reference) => reference.estimatedTokens)
  );
  const measures = [
    input.systemAndRole,
    input.humanMessage,
    input.exactTargets,
    input.transcript,
    input.summary,
    input.phaseVisibleOutputs
  ];
  const inputBytes = sum(measures.map((measure) => measure.bytes)) + referenceBytes;
  const estimatedInputTokens =
    sum(measures.map((measure) => measure.estimatedTokens)) + referenceTokens;
  const filesystemRootCount = new Set(
    input.contextReferences.flatMap((reference) =>
      reference.filesystemRootId ? [reference.filesystemRootId] : []
    )
  ).size;
  const violations: DiscourseBudgetViolation[] = [];
  addViolation(
    violations,
    'HUMAN_MESSAGE_BYTES',
    input.humanMessage.bytes,
    DISCOURSE_LIMITS.maxHumanMessageBytes
  );
  addViolation(
    violations,
    'CONTEXT_REFERENCE_COUNT',
    input.contextReferences.length,
    DISCOURSE_LIMITS.maxContextReferencesPerWave
  );
  addViolation(
    violations,
    'FILESYSTEM_ROOT_COUNT',
    filesystemRootCount,
    DISCOURSE_LIMITS.maxFilesystemRootsPerWave
  );
  for (const reference of input.contextReferences) {
    addViolation(
      violations,
      'REFERENCE_MANIFEST_BYTES',
      reference.bytes,
      DISCOURSE_LIMITS.maxContextManifestBytesPerReference,
      reference.referenceId
    );
  }
  addViolation(
    violations,
    'CONTEXT_MANIFEST_BYTES',
    referenceBytes,
    DISCOURSE_LIMITS.maxContextManifestBytesPerWave
  );
  addViolation(
    violations,
    'TRANSCRIPT_MESSAGE_COUNT',
    input.transcript.messageCount,
    DISCOURSE_LIMITS.maxRecentTranscriptMessages
  );
  addViolation(
    violations,
    'TRANSCRIPT_BYTES',
    input.transcript.bytes,
    DISCOURSE_LIMITS.maxRecentTranscriptBytes
  );
  addViolation(
    violations,
    'TRANSCRIPT_TOKENS',
    input.transcript.estimatedTokens,
    DISCOURSE_LIMITS.maxRecentTranscriptTokens
  );
  addViolation(
    violations,
    'SUMMARY_BYTES',
    input.summary.bytes,
    DISCOURSE_LIMITS.maxSummaryBytes
  );
  addViolation(
    violations,
    'WAVE_OUTPUT_BYTES',
    input.cumulativeWaveOutputBytes,
    DISCOURSE_LIMITS.maxWaveOutputBytes
  );
  addViolation(
    violations,
    'PROMPT_TOKEN_BUDGET',
    estimatedInputTokens,
    promptTokenCeiling
  );

  return {
    policyVersion: DISCOURSE_BUDGET_POLICY_VERSION,
    status: violations.length === 0 ? 'READY' : 'BLOCKED',
    inputBytes,
    estimatedInputTokens,
    reservedOutputTokens,
    modelContextTokens: input.modelContextTokens,
    promptTokenCeiling,
    sourceCount: input.contextReferences.length,
    filesystemRootCount,
    violations
  };
}

function validateInput(input: DiscourseJobBudgetInput): void {
  const values = [
    input.modelContextTokens,
    input.reservedOutputTokens ?? DISCOURSE_LIMITS.defaultReservedOutputTokens,
    input.cumulativeWaveOutputBytes,
    input.transcript.messageCount,
    ...[
      input.systemAndRole,
      input.humanMessage,
      input.exactTargets,
      ...input.contextReferences,
      input.transcript,
      input.summary,
      input.phaseVisibleOutputs
    ].flatMap((measure) => [measure.bytes, measure.estimatedTokens])
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Discourse budget inputs must be non-negative safe integers.');
  }
  if (input.modelContextTokens < 1) {
    throw new Error('Discourse budget requires a positive model context window.');
  }
  for (const reference of input.contextReferences) {
    if (!reference.referenceId.trim()) {
      throw new Error('Discourse reference budget requires an id.');
    }
  }
}

function addViolation(
  violations: DiscourseBudgetViolation[],
  code: DiscourseBudgetViolationCode,
  actual: number,
  limit: number,
  referenceId?: string
): void {
  if (actual > limit) {
    violations.push({ code, actual, limit, ...(referenceId ? { referenceId } : {}) });
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
