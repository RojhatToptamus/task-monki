export const LAB_PARTICIPANT_CASE_SCHEMA_VERSION =
  'discourse-protocol-lab/participant-case-v1' as const;
export const LAB_ORACLE_CASE_SCHEMA_VERSION =
  'discourse-protocol-lab/oracle-case-v1' as const;
export const LAB_PUBLIC_OUTPUT_SCHEMA_VERSION =
  'discourse-protocol-lab/public-output-v2' as const;
/** Provider-facing alias for the sealed controlled-condition baseline. */
export const LAB_INITIAL_ARTIFACT_ID = 'INITIAL' as const;

export type LabCasePartition = 'DEVELOPMENT' | 'CONFIRMATION';

export type LabEvaluationKind =
  | 'OBJECTIVE'
  | 'MISSING_INFORMATION'
  | 'PLURALISTIC';

export type LabOutputStatus =
  | 'ANSWER'
  | 'UNCERTAIN'
  | 'ABSTAIN'
  | 'NEEDS_USER_INPUT'
  | 'MULTIPLE_DEFENSIBLE';

export type LabClaimStance = 'ACCEPT' | 'REJECT' | 'OPEN' | 'NOT_APPLICABLE';

export type LabEvidenceRelation = 'SUPPORTS' | 'CONTRADICTS' | 'LIMITS';

export type LabAssumptionStatus = 'REQUIRED' | 'UNCERTAIN' | 'TESTABLE';

export type LabIssueKind =
  | 'FACTUAL'
  | 'EVIDENCE'
  | 'ASSUMPTION'
  | 'LOGIC'
  | 'AMBIGUITY'
  | 'MISSING_INFORMATION'
  | 'TRADEOFF'
  | 'OTHER';

export type LabIssueSeverity = 'MATERIAL' | 'ADVISORY';

export type LabResponseDisposition = 'ACCEPT' | 'PARTIAL' | 'REJECT' | 'ABSTAIN';

export type LabDisagreementStatus =
  | 'RESOLVED'
  | 'UNRESOLVED'
  | 'COMPATIBLE_DIFFERENCE'
  | 'NEEDS_USER_INPUT';

export type LabResolutionStatus =
  | 'RESOLVED'
  | 'PARTIALLY_RESOLVED'
  | 'UNRESOLVED'
  | 'NEEDS_USER_INPUT'
  | 'NO_DISAGREEMENT';

export type LabResolutionBasis =
  | 'EVIDENCE'
  | 'ASSUMPTION'
  | 'PREFERENCE'
  | 'INSUFFICIENT_INFORMATION'
  | 'NO_MATERIAL_ISSUE';

/**
 * This is the entire case payload agents may receive. Evaluation labels and
 * truth live only in LabOracleCase, which is deliberately a separate type and
 * fixture.
 */
export interface LabParticipantCase {
  schemaVersion: typeof LAB_PARTICIPANT_CASE_SCHEMA_VERSION;
  caseId: string;
  question: string;
  evidence: LabCaseEvidence[];
  propositions: LabCaseProposition[];
  options: LabCaseOption[];
  topics: LabCaseTopic[];
}

export interface LabCaseEvidence {
  id: string;
  text: string;
}

export interface LabCaseProposition {
  id: string;
  topicId: string;
  text: string;
}

export interface LabCaseOption {
  id: string;
  text: string;
}

export interface LabCaseTopic {
  id: string;
  label: string;
}

/** Scorer-only data. This object must never be included in a participant prompt. */
export interface LabOracleCase {
  schemaVersion: typeof LAB_ORACLE_CASE_SCHEMA_VERSION;
  caseId: string;
  partition: LabCasePartition;
  domain: string;
  evaluationKind: LabEvaluationKind;
  mechanismTags: string[];
  acceptableStatuses: LabOutputStatus[];
  acceptedAnswerValueSets: string[][];
  acceptedAnswerOptionSets: string[][];
  propositionExpectations: LabPropositionExpectation[];
  validCritiques: LabValidCritique[];
  sharedErrorPropositionIds: string[];
  disagreementRequirements: LabDisagreementRequirement[];
  requiredUserQuestionCruxIds: string[];
}

export interface LabPropositionExpectation {
  propositionId: string;
  acceptableStances: LabClaimStance[];
  /**
   * A claim is evidentially supported when it cites every evidence id in at
   * least one of these alternative sets. An empty array means that evidential
   * support is not scored for this proposition.
   */
  requiredEvidenceSets: string[][];
}

export interface LabValidCritique {
  targetPropositionId: string;
  kinds: LabIssueKind[];
  severities: LabIssueSeverity[];
}

export interface LabDisagreementRequirement {
  propositionIds: string[];
  acceptableStatuses: LabDisagreementStatus[];
  requiredCruxId?: string;
}

export interface LabEvidenceReference {
  evidenceId: string;
  relation: LabEvidenceRelation;
  note: string;
}

/**
 * Concise, public, auditable output. It intentionally has no analysis,
 * rationale, scratchpad, or chain-of-thought field.
 */
export interface LabPublicOutput {
  schemaVersion: typeof LAB_PUBLIC_OUTPUT_SCHEMA_VERSION;
  status: LabOutputStatus;
  answer: {
    summary: string;
    /** Short, directly scored values such as "21", "4%", or "May". */
    values: string[];
    selectedOptionIds: string[];
  };
  claims: LabPublicClaim[];
  assumptions: LabPublicAssumption[];
  issues: LabPublicIssue[];
  responses: LabPublicResponse[];
  disagreements: LabPublicDisagreement[];
  resolution: LabPublicResolution;
  userQuestions: LabPublicUserQuestion[];
  confidence: number;
}

export interface LabPublicClaim {
  id: string;
  propositionId: string;
  topicId: string;
  stance: LabClaimStance;
  statement: string;
  evidence: LabEvidenceReference[];
  assumptionIds: string[];
  confidence: number;
}

export interface LabPublicAssumption {
  id: string;
  statement: string;
  status: LabAssumptionStatus;
  affectsClaimIds: string[];
}

export interface LabPublicIssue {
  id: string;
  targetArtifactId: string;
  targetPropositionId: string;
  kind: LabIssueKind;
  severity: LabIssueSeverity;
  statement: string;
  evidence: LabEvidenceReference[];
  confidence: number;
}

export interface LabPublicResponse {
  id: string;
  targetArtifactId: string;
  targetIssueId: string;
  disposition: LabResponseDisposition;
  statement: string;
  evidence: LabEvidenceReference[];
  changedClaimIds: string[];
}

export interface LabPublicDisagreement {
  id: string;
  propositionIds: string[];
  participantArtifactIds: string[];
  status: LabDisagreementStatus;
  summary: string;
  evidence: LabEvidenceReference[];
  /** Null when evidence or assumptions, rather than a user-owned choice, form the crux. */
  cruxId: string | null;
}

export interface LabPublicResolution {
  status: LabResolutionStatus;
  basis: LabResolutionBasis;
  summary: string;
  resolvedIssueIds: string[];
  unresolvedIssueIds: string[];
}

export interface LabPublicUserQuestion {
  id: string;
  cruxId: string;
  question: string;
  propositionIds: string[];
}

export interface LabTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export type LabExecutionFailureKind =
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'TOKEN_ACCOUNTING_UNAVAILABLE'
  | 'TOOL_CONTEXT_VIOLATION'
  | 'SETTINGS_MISMATCH'
  | 'MODEL_REROUTED'
  | 'AMBIGUOUS_DELIVERY'
  | 'INTERRUPT_UNCONFIRMED'
  | 'CONTINUATION_UNAVAILABLE';

export type LabExecutionFailurePhase =
  | 'PRE_TURN'
  | 'THREAD_ATTESTATION'
  | 'TURN_EXECUTION'
  | 'UNKNOWN';

export interface LabExecutionFailure {
  kind: LabExecutionFailureKind;
  message: string;
  phase: LabExecutionFailurePhase;
  providerThreadId: string | null;
  providerTurnId: string | null;
}

export interface LabValidationError {
  path: string;
  code:
    | 'INVALID_JSON'
    | 'INVALID_TYPE'
    | 'MISSING_FIELD'
    | 'UNKNOWN_FIELD'
    | 'INVALID_VALUE'
    | 'OUT_OF_RANGE'
    | 'DUPLICATE_ID'
    | 'INVALID_REFERENCE';
  message: string;
  /** Stable machine-readable rule identity. Legacy validators may omit this. */
  ruleId?: string;
  /** Construct boundary affected by the rule. Legacy validators may omit this. */
  domain?:
    | 'CONTEXT_INTEGRITY'
    | 'CONTEXT_CONTRACT'
    | 'FACTUAL_PROVENANCE'
    | 'CONVERSATIONAL_PROVENANCE'
    | 'RESPONSE_PROVENANCE'
    | 'ISSUE_LIFECYCLE'
    | 'CASE_REFERENCE'
    | 'CROSS_FIELD';
  /** Whether the output failed or the harness made the measurement unavailable. */
  measurementEffect?: 'OUTPUT_INVALID' | 'MEASUREMENT_UNAVAILABLE';
}

export interface LabRawOutputAttempt {
  attemptNumber: 1 | 2;
  purpose: 'PRIMARY' | 'SCHEMA_REPAIR';
  callId: string;
  /** Raw provider text is retained even when parsing or validation fails. */
  rawText: string;
  /**
   * Whether this attempt consumed the harness hard-call allowance. This is not
   * evidence that a provider billed a model turn; runner accounting records
   * that separately.
   */
  charged: boolean;
  usage?: LabTokenUsage;
  latencyMs?: number;
  executionFailure?: LabExecutionFailure;
  validationErrors: LabValidationError[];
  output?: LabPublicOutput;
}

export interface LabOutputRecord {
  attempts: LabRawOutputAttempt[];
  acceptedAttemptNumber: 1 | 2 | null;
  chargedCalls: number;
  repairAttempted: boolean;
  status: 'VALID' | 'INVALID';
}

export interface LabOutputAttemptInput {
  callId: string;
  rawText: string;
  /** Defaults to true for dispatched attempts; false only for sealed fixtures. */
  charged?: boolean;
  usage?: LabTokenUsage;
  latencyMs?: number;
  executionFailure?: LabExecutionFailure;
}

export interface LabArtifactRecord {
  artifactId: string;
  actorId: string;
  stage: string;
  parentArtifactIds: string[];
  output: LabOutputRecord;
  /** Provider and immutable-ledger linkage for this public artifact. */
  call?: LabArtifactCallProvenance;
}

export type LabCallPurpose = 'PRIMARY' | 'SCHEMA_REPAIR';

export type LabThreadStartStatus =
  | 'NOT_REQUIRED'
  | 'NOT_STARTED'
  | 'ATTESTED'
  | 'CREATED_UNATTESTED'
  | 'UNKNOWN';

export type LabAccountingStatus = 'YES' | 'NO' | 'UNKNOWN';

/** Explicit driver evidence; session existence alone is not attestation. */
export type LabSessionAttestationStatus =
  | 'NOT_PRESENT'
  | 'ATTESTED'
  | 'UNATTESTED'
  | 'UNKNOWN';

export interface LabArtifactCallProvenance {
  assignedCallId: string;
  primaryCallKey: string;
  repairCallKey: string | null;
  promptArtifactSha256: string;
  repairPromptArtifactSha256: string | null;
  primaryTransitionArtifactSha256?: string;
  providerThreadId: string | null;
  providerTurnIds: string[];
  failures: Array<{
    attempt: LabCallPurpose;
    kind: LabExecutionFailureKind;
    message: string;
    phase: LabExecutionFailurePhase;
  }>;
}

export interface LabTransitionLink {
  fromArtifactId: string;
  toArtifactId: string;
  propositionIds?: string[];
}

export interface LabTrajectoryForScoring {
  participantCase: LabParticipantCase;
  oracleCase: LabOracleCase;
  artifacts: LabArtifactRecord[];
  initialArtifactIds: string[];
  /** Terminal public artifacts; a protocol is not required to elect one winner. */
  terminalArtifactIds: string[];
  transitionLinks: LabTransitionLink[];
}

export interface LabRatioMetric {
  count: number;
  opportunities: number;
  rate: number | null;
}

export interface LabOutputScore {
  artifactId: string;
  validOutput: boolean;
  answerCorrect: boolean | null;
  statusAccepted: boolean | null;
  claimCorrectness: LabRatioMetric;
  evidentialSupport: LabRatioMetric;
  inventedCriticism: LabRatioMetric;
  disagreementPreservation: LabRatioMetric;
  requiredUserQuestionCoverage: LabRatioMetric;
  abstained: boolean | null;
  uncertaintyExpressed: boolean | null;
  drift: LabRatioMetric;
  duplicateIssueCount: number;
  failureCount: number;
  invalidAttemptCount: number;
  repairAttempted: boolean;
  repairSucceeded: boolean;
}

export interface LabTrajectoryScore {
  outputs: LabOutputScore[];
  wrongToRightCorrection: LabRatioMetric;
  rightToWrongContamination: LabRatioMetric;
  sharedErrorDiscovery: LabRatioMetric;
  correctMinorityPreservation: LabRatioMetric;
  terminalDisagreementPreservation: LabRatioMetric;
  repeatedCriticism: LabRatioMetric;
  totalChargedCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalReasoningTokens: number | null;
  totalTokens: number | null;
  totalLatencyMs: number | null;
  failureCount: number;
}
