import fs from 'node:fs/promises';
import path from 'node:path';
import {
  H1C_CORPUS_VERSION,
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus,
  type H1cConditionId,
  type H1cOracleCorpus,
  type H1cOracleProfile,
  type H1cOracleRecord,
  type H1cParticipantCorpus,
  type H1cParticipantRecord
} from './h1cCorpus';
import {
  H1C_SCHEDULE_VERSION,
  scheduleH1cAssignments,
  type H1cAssignment,
  type H1cH0Receipt
} from './h1cPlan';
import {
  H1C_DRAFT_ARTIFACT_ID,
  H1C_PROMPT_VERSION,
  buildH1cPrompt,
  type H1cPreparedPrompt
} from './h1cPrompts';
import {
  H1C_SCORING_VERSION,
  interpretH1c,
  scoreH1cOutput,
  scoreResolutionConsistency,
  scoreSelfCorrectionRepresentation,
  type H1cScoredObservation
} from './h1cScoring';
import {
  H1C_PREREGISTRATION_VERSION,
  H1C_PROTOCOL_VERSION,
  H1C_SEAL_VERSION,
  type H1cValidationReport
} from './h1cValidation';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  LabArtifactLedger,
  sha256File,
  sha256Text,
  stableJson,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  validateLabPublicOutputV4ContextDefinition,
  validateLabPublicOutputV4,
  visibleIssueIdsFromLabContextV4,
  type LabPublicOutputV4,
  type LabPublicOutputV4ValidationContext,
  type LabVisibleInterventionArtifactV4
} from './outputV4';
import type { LabValidationError } from './contracts';

export const H1C_HARNESS_VALIDATION_SCHEMA_VERSION =
  'task-monki/discourse-lab-h1c-h0@v3' as const;
export const H1C_HARNESS_VALIDATION_VERSION = 'h1c-h0-validation@v3' as const;

export interface H1cH0PromptSummary {
  assignmentId: string;
  blockId: string;
  caseId: string;
  repetition: 1 | 2;
  serialPosition: number;
  conditionId: H1cConditionId;
  threadMode: H1cAssignment['threadMode'];
  continuationFromAssignmentId: string | null;
  visibleArtifactKinds: LabVisibleInterventionArtifactV4['artifactKind'][];
  visibleDraftIssueIds: string[];
  promptSha256: string;
  estimatedPromptTokens: number;
}

export interface H1cH0ContractFixtureResult {
  fixtureId: string;
  interactionStage: LabPublicOutputV4ValidationContext['interactionStage'];
  concern:
    | 'ANSWER_AUTHORITY'
    | 'CASE_PROMPT_TARGETING'
    | 'SELF_CORRECTION'
    | 'CRITIQUE_PROVENANCE'
    | 'RESOLUTION_ACCOUNTING'
    | 'EVIDENCE_REQUIREMENT_ALLOWANCE'
    | 'REQUEST_ABSTENTION'
    | 'TYPED_FAILURE_CLASSIFICATION'
    | 'DENOMINATOR_ACCOUNTING';
  expected: {
    contractAccepted: boolean;
    validationFailure: H1cH0TypedValidationFailure | null;
    semanticCheckId: string | null;
    semanticCheckPassed: boolean | null;
  };
  observed: {
    contractAccepted: boolean;
    validationFailure: H1cH0TypedValidationFailure | null;
    semanticCheckId: string | null;
    semanticCheckPassed: boolean | null;
  };
  status: 'PASSED';
}

export interface H1cH0TypedValidationFailure {
  ruleId: string;
  domain: NonNullable<LabValidationError['domain']>;
  measurementEffect: NonNullable<LabValidationError['measurementEffect']>;
}

export interface H1cHarnessValidationReport {
  schemaVersion: typeof H1C_HARNESS_VALIDATION_SCHEMA_VERSION;
  validationVersion: typeof H1C_HARNESS_VALIDATION_VERSION;
  hypothesisId: 'H0-H1C';
  status: 'PASSED';
  componentLocks: LabComponentLock;
  scheduleVersion: typeof H1C_SCHEDULE_VERSION;
  scheduleSha256: string;
  promptTemplateSetSha256: string;
  maximumEstimatedPromptTokens: number;
  materializedCallCount: 28;
  blockCount: 8;
  providerCallCount: 0;
  topology: {
    freshCalls: 20;
    continuationCalls: 8;
  };
  prompts: H1cH0PromptSummary[];
  contractFixtures: H1cH0ContractFixtureResult[];
  checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
}

export interface RunH1cHarnessValidationInput {
  fixtureRoot: string;
  validation: H1cValidationReport;
  ledger?: LabArtifactLedger;
}

export interface H1cHarnessValidationReceipt extends Omit<H1cH0Receipt, 'report'> {
  report: H1cHarnessValidationReport;
}

interface MaterializedH1cH0Prompt extends H1cH0PromptSummary {
  prompt: string;
  context: H1cPreparedPrompt['context'];
}

const MAXIMUM_PREPARED_PROMPT_TOKENS = 7_000;
const REQUIRED_CHECK_IDS = [
  'SEALED_COMPONENT_LOCKS',
  'EIGHT_BLOCK_28_CALL_SCHEDULE',
  'RESPONSE_ORDER_COUNTERBALANCE',
  'SYNTHETIC_V4_DRAFT_MATERIALIZATION',
  'NEUTRAL_CRITIQUE_FRAMING',
  'TREATMENT_ISOLATION',
  'SCORER_TRUTH_FIREWALL',
  'FRESH_CASE_NON_REUSE',
  'STAGE_SPECIFIC_V4_BOUNDARIES',
  'CASE_PROMPT_AND_ANSWER_AUTHORITY',
  'SELF_CORRECTION_BOUNDARY',
  'TYPED_DRAFT_ISSUE_LIFECYCLE',
  'TYPED_FAILURE_CLASSIFICATION',
  'CRITIQUE_PROVENANCE_AND_RESOLUTION',
  'EVIDENCE_REQUIREMENT_ALLOWANCE',
  'REQUEST_AND_ABSTENTION_BOUNDARY',
  'USER_DOCUMENT_INSTRUCTION_IDENTITY',
  'CONTINUATION_FRESH_TOPOLOGY',
  'PREPARED_PROMPT_CEILING',
  'ZERO_PROVIDER_BEHAVIOR'
] as const;
const EXPOSED_DEVELOPMENT_QUESTION_SHA256S = new Set([
  '8712438b3839b4daead68e72046afb0e2ac1060867140898b6fbc8a2948a6577',
  '92bad902f4ce857b0e8a7fc46338b88f24ef3473d4e49348daf3dd964e63f92e',
  '90e5a9076317ea775a4d66fb3c9904734dd91f9a7490b18f4dfcf0bda8bb107c',
  '15891a9cfd50240356e3d8cdb25656acf8db5668078cfd1ef85c8c500b872117',
  'afd7b99f360e49b6021ab49781627a6e894d79ddf8ad064ea905fad3f0854efe',
  '7697f04908495bc39f6fd0248f22ec6bb86d09f42b896792bcdb132d4efef6d5',
  '64ba3c32b596fc5a03b2dcc9b40e7e147bd106aae058707b1fc589d326204446',
  '7f3cc97b8b0d9654496efbaa6104f25ef3a1b0561c6eeeb126d1757924c7b361',
  'c999260a823cb35a06a996d0f25cef41ff07aa36fa5128d9703dc5c0ee5c9c64',
  '25188cfae1aeb62abd5e6e91633ea003e84a9529bb76d1204480ba47169b73f1',
  '32e470f7b15b6202652d11253668037931971a0aa8a06055236f4f9238c1a1fb',
  '78caae509a8f4e5b1bde8fd3ef3dc78306e59dabc4e8ffdfc94197853f759ad8',
  '7a4bd7e26514eb653c612f3a0247c233f822cc615581dac2a16c3c59bb5be583',
  '3f188d7a772a8731fc5ffffd1b0f65c5fca5977f9082ea35a245cfba03884793',
  'ebfb0d499d8b152a7f3f4a2464870ef62706cbe9c17bf6ba6ea5081c7a526f32',
  '3c2fe138d0abcc4778d3cb9f6b4b8bbc3f386223a0f41c8cf5d1c30862843c56',
  '7d51648524c0b3c9c76ff8c7c3d7db08b366420943f1434602e2ac42f3a6d04a',
  '65f39a657f785dbc4ec0701cb3e462040fc8df6fa24437db093870e7f5941762',
  '84fe0b615b819d6f7227deb71598bec7277c3263baf98ba7e9bc27c20bcff4c8',
  '99279487185bc8616ab53f4c9658265c99faaa2d5c9ce2cbc467e66dcd54fe2d',
  '4847287e79426337889e23638b55721439b84df670b700c0d926c8c2e5ee838a',
  '74ff6c6eefb1e89c8abf918405f04db3576ce1d86ffcc7ad34fd26ca35d81487',
  '8ce93ee16137cadd504e3728ac076509cf79091c1aaf7c33e6a52738b42e5be8',
  'c16750f0a6014d581a50c66fafe3181ede8a5c738ba6d1ec656190ae5d5bbcdd',
  '484ee63ddad071bc3309bc1dbb3b9ce81430161440cb1c32c4eb7ff06e11fa7c',
  '654eebb5504cbc41d0b3da2a4fd5b8c8d4f74055141c0882b68960f95397615d',
  'b867b65de65c90dbaef907b6de06f4c3a8bd8d64f7601d2f2a700d713b87b5f6',
  'b2d5b6a77a2a314b891beb11a827224c8ca83513bcfa17527872a467dce868cb',
  '50559f3b634dae6d1fdd6fb8497e889e9bf0c1421d15ea1388c76ada47735c8c',
  'ca307e14c5d689d438177a2bf791a58c750ecb08aae33627e27ab670aae2f60d'
]);
const REQUIRED_CONTRACT_FIXTURE_IDS = [
  'INITIAL_CASE_TARGET_PROMPT_SOURCE_ACCEPTED',
  'INITIAL_PROMPT_AS_ISSUE_TARGET_REJECTED',
  'INITIAL_SELECTED_OPTIONS_AUTHORITATIVE',
  'INITIAL_LEGACY_ANSWER_VALUES_REJECTED',
  'INITIAL_DIRECTIONAL_EVIDENCE_OMISSION_SCORE_FAILURE',
  'SELF_REVIEW_NO_CHANGE_ACCEPTED',
  'SELF_REVIEW_DECLARED_CORRECTION_ACCEPTED',
  'SELF_REVIEW_DECLARATION_MISMATCH_SCORE_FAILURE',
  'SELF_REVIEW_DRAFT_ISSUE_RETAINED_STABLE_IDENTITY',
  'SELF_REVIEW_DRAFT_ISSUE_RESOLVED_WITHOUT_REEMISSION',
  'SELF_REVIEW_DRAFT_ISSUE_IDENTITY_MUTATION_REJECTED',
  'SELF_REVIEW_UNKNOWN_ISSUE_OUTPUT_INVALID',
  'SELF_REVIEW_CONTEXT_FAULT_MEASUREMENT_UNAVAILABLE',
  'SELF_REVIEW_LEXICAL_PROVENANCE_WORDS_DO_NOT_CLASSIFY',
  'CRITIQUE_EXTERNAL_RESPONSE_ACCEPTED',
  'CRITIQUE_SELF_FOUND_RESPONSE_REJECTED',
  'CRITIQUE_MISSING_RESPONDS_TO_REJECTED',
  'CRITIQUE_MISMATCHED_RESPONDS_TO_REJECTED',
  'CRITIQUE_AS_FACTUAL_SOURCE_REJECTED',
  'CRITIQUE_REJECTION_NO_DISAGREEMENT_ACCEPTED',
  'CRITIQUE_REJECTION_RESOLVED_ACCEPTED',
  'CRITIQUE_REJECTION_FACTUAL_EVIDENCE_ACCEPTED',
  'CRITIQUE_ACCEPT_NO_MATERIAL_ISSUE_SCORE_FAILURE',
  'CRITIQUE_PARTIAL_NO_MATERIAL_ISSUE_SCORE_FAILURE',
  'RESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_ACCEPTED',
  'UNRESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_SCORE_FAILURE',
  'CRITIQUE_OMITTED_ACCOUNTING_SCORE_FAILURE',
  'CRITIQUE_VISIBLE_ISSUE_DISAPPEARS_SCORE_FAILURE',
  'EVIDENCE_REQUIRED_PLUS_ALLOWED_ACCEPTED',
  'EVIDENCE_ALLOWED_WITHOUT_REQUIRED_SCORE_FAILURE',
  'EVIDENCE_DISALLOWED_REFERENCE_SCORE_FAILURE',
  'EVIDENCE_NULL_ALLOWANCE_UNADJUDICATED_ACCEPTED',
  'EVIDENCE_ARTIFACT_REFERENCE_NOT_FACTUAL_SUPPORT',
  'REQUEST_BLOCKING_USER_ACCEPTED',
  'REQUEST_BLOCKING_DOCUMENT_ACCEPTED',
  'REQUEST_REQUIRED_SUBSET_ALLOWED_SUPERSET_ACCEPTED',
  'REQUEST_MISSING_REQUIRED_TARGET_SCORE_FAILURE',
  'REQUEST_DISALLOWED_EXTRA_TARGET_SCORE_FAILURE',
  'REQUEST_WRONG_OWNER_SCORE_FAILURE',
  'REQUEST_ESCALATION_INDEPENDENT_OF_TARGETING',
  'ABSTENTION_EXPLICIT_ACCEPTED',
  'ABSTENTION_MISSING_OBJECT_REJECTED',
  'EXPLICIT_COHORT_DENOMINATOR_ACCOUNTING'
] as const;
const REQUIRED_BOUNDARY_SOURCE_FILES = [
  'src/dev/discourseLab/CodexTextDriver.ts',
  'src/core/agent/codex/CodexAppServerSupervisor.ts',
  'src/core/agent/codex/CodexRpcClient.ts',
  'src/core/agent/codex/CodexPermissionProfile.ts',
  'src/core/discourse/DiscourseWorkspace.ts'
] as const;

/**
 * Performs H1c's H0 entirely in local deterministic code. It deliberately has
 * no driver argument and imports no provider implementation.
 */
export async function runH1cHarnessValidation(
  input: RunH1cHarnessValidationInput
): Promise<H1cHarnessValidationReport> {
  assertComponentLocks(input.validation);
  input.ledger?.assertRunContext('HARNESS_VALIDATION', input.validation.locks);
  await input.ledger?.append({
    eventType: 'H1C_H0_STARTED',
    occurredAt: new Date().toISOString()
  });

  const participants = await loadH1cParticipantCorpus(input.fixtureRoot);
  assertFreshH1cParticipantQuestions(participants.records);
  const { schedule, assignments } = scheduleH1cAssignments(participants.records);
  assertSchedule(assignments, schedule.blockIds);

  const prompts = materializePromptMatrix(participants, assignments);
  assertPromptSerialization(prompts, participants);
  assertNeutralCritiqueFraming(prompts, participants);
  assertTreatmentIsolation(prompts, participants);
  assertUserAndDocumentInstructions(prompts, participants);
  assertThreadTopology(prompts, schedule.blockIds);

  const maximumEstimatedPromptTokens = Math.max(
    ...prompts.map((item) => item.estimatedPromptTokens)
  );
  if (maximumEstimatedPromptTokens > MAXIMUM_PREPARED_PROMPT_TOKENS) {
    throw new Error(
      `H1c H0 prepared prompt estimate ${maximumEstimatedPromptTokens} exceeds 7000 tokens.`
    );
  }

  const promptArtifact = {
    kind: 'H1C_H0_MATERIALIZED_PROMPT_TEMPLATE_SET',
    promptVersion: H1C_PROMPT_VERSION,
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    scheduleVersion: schedule.version,
    scheduleSha256: schedule.scheduleSha256,
    prompts: prompts.map(({ context, ...item }) => ({
      ...item,
      context
    }))
  } as const;
  const promptTemplateSetSha256 = sha256Text(`${stableJson(promptArtifact)}\n`);
  const storedPromptSet = await input.ledger?.putArtifact(promptArtifact);
  if (storedPromptSet && storedPromptSet.sha256 !== promptTemplateSetSha256) {
    throw new Error('H1c H0 ledger changed the materialized prompt-template-set digest.');
  }

  // Scorer-only data is not opened until the entire participant prompt set is materialized.
  const oracles = await loadH1cOracleCorpus(input.fixtureRoot, participants);
  assertTruthFirewall(prompts, oracles);
  const contractFixtures = assertStageSpecificV4Boundaries(participants, oracles, prompts);

  const summaries: H1cH0PromptSummary[] = prompts.map(({ prompt: _prompt, context: _context, ...item }) =>
    structuredClone(item)
  );
  const freshCalls = summaries.filter((item) => item.threadMode === 'FRESH').length;
  const continuationCalls = summaries.filter(
    (item) => item.threadMode === 'CONTINUE_INITIAL'
  ).length;
  if (freshCalls !== 20 || continuationCalls !== 8) {
    throw new Error('H1c H0 topology does not contain exactly 20 fresh and 8 continuation calls.');
  }

  const report: H1cHarnessValidationReport = {
    schemaVersion: H1C_HARNESS_VALIDATION_SCHEMA_VERSION,
    validationVersion: H1C_HARNESS_VALIDATION_VERSION,
    hypothesisId: 'H0-H1C',
    status: 'PASSED',
    componentLocks: structuredClone(input.validation.locks),
    scheduleVersion: schedule.version,
    scheduleSha256: schedule.scheduleSha256,
    promptTemplateSetSha256,
    maximumEstimatedPromptTokens,
    materializedCallCount: 28,
    blockCount: 8,
    providerCallCount: 0,
    topology: { freshCalls: 20, continuationCalls: 8 },
    prompts: summaries,
    contractFixtures,
    checks: [
      {
        checkId: 'SEALED_COMPONENT_LOCKS',
        status: 'PASSED',
        detail: 'Corpus, prompt, public-output-v4, scoring, protocol, preregistration, sealed-file, and source-lock digests match the validated H1c component set.'
      },
      {
        checkId: 'EIGHT_BLOCK_28_CALL_SCHEDULE',
        status: 'PASSED',
        detail: 'Four cases repeated twice produce eight complete live-draft blocks and exactly 28 unique assignments.'
      },
      {
        checkId: 'RESPONSE_ORDER_COUNTERBALANCE',
        status: 'PASSED',
        detail: 'Both evidence response conditions occupy each response position twice; each critique response condition is distributed 1/1/2 across the three response positions.'
      },
      {
        checkId: 'SYNTHETIC_V4_DRAFT_MATERIALIZATION',
        status: 'PASSED',
        detail: 'Every non-initial template was materialized with the same context-valid synthetic public-output-v4 draft within its block; every serialized CASE and PUBLIC ARTIFACTS section matches its validation context.'
      },
      {
        checkId: 'NEUTRAL_CRITIQUE_FRAMING',
        status: 'PASSED',
        detail: 'Valid and placebo notes share anonymous, non-factual framing and normalized stage instructions; no condition, placebo, treatment, or oracle-truth label is exposed.'
      },
      {
        checkId: 'TREATMENT_ISOLATION',
        status: 'PASSED',
        detail: 'Initial calls receive no artifact, self-review receives only DRAFT, each critique arm receives only DRAFT plus its own typed critique, and evidence receives only DRAFT plus its own factual packet.'
      },
      {
        checkId: 'SCORER_TRUTH_FIREWALL',
        status: 'PASSED',
        detail: 'Oracle profiles, rationales, audits, target/guard labels, issue truth labels, condition ids, and mechanism strata are absent from all participant prompts.'
      },
      {
        checkId: 'FRESH_CASE_NON_REUSE',
        status: 'PASSED',
        detail: 'Normalized question fingerprints for all four v3 cases are distinct from every exposed development question in v1, H1b, frozen H1c-v1, and frozen H1c-v2; confirmation files were not opened.'
      },
      {
        checkId: 'STAGE_SPECIFIC_V4_BOUNDARIES',
        status: 'PASSED',
        detail: `${contractFixtures.length} deterministic adversarial fixtures exercised INITIAL, SELF_REVIEW, CRITIQUE_RESPONSE, and EVIDENCE_RESPONSE with expected and observed contract/scorer outcomes recorded separately.`
      },
      {
        checkId: 'CASE_PROMPT_AND_ANSWER_AUTHORITY',
        status: 'PASSED',
        detail: 'CASE is accepted as an issue target, PROMPT is accepted only as factual provenance, selectedOptionIds remains the structured answer authority, answer.summary remains unadjudicated prose, and the removed values field is rejected.'
      },
      {
        checkId: 'SELF_CORRECTION_BOUNDARY',
        status: 'PASSED',
        detail: 'No-change self-review and a correctly declared DRAFT correction pass; declared-versus-observed change mismatch remains parseable and fails only the self-correction score.'
      },
      {
        checkId: 'TYPED_DRAFT_ISSUE_LIFECYCLE',
        status: 'PASSED',
        detail: 'Every response-stage POSITION carries an issue-bearing typed publicOutput; stable retention and resolution without re-emission pass, while identity mutation and unknown issue references are typed output failures.'
      },
      {
        checkId: 'TYPED_FAILURE_CLASSIFICATION',
        status: 'PASSED',
        detail: 'Harness context faults are MEASUREMENT_UNAVAILABLE and model-output faults are OUTPUT_INVALID through typed rule metadata; participant wording and error-message vocabulary never determine classification.'
      },
      {
        checkId: 'CRITIQUE_PROVENANCE_AND_RESOLUTION',
        status: 'PASSED',
        detail: 'Only an externally visible CRITIQUE artifact/issue with RESPONDS_TO provenance is a response target; equivalent rejected-critique resolution encodings pass, while omitted issue accounting remains parseable and fails the resolution score.'
      },
      {
        checkId: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
        status: 'PASSED',
        detail: 'Directional evidence omissions, missing required evidence, and semantically disallowed references remain parseable observations; required and allowed reference sets produce distinct score outcomes.'
      },
      {
        checkId: 'REQUEST_AND_ABSTENTION_BOUNDARY',
        status: 'PASSED',
        detail: 'Blocking USER and DOCUMENT requests retain distinct completion semantics, and ABSTAIN is accepted if and only if its explicit abstention object is present.'
      },
      {
        checkId: 'USER_DOCUMENT_INSTRUCTION_IDENTITY',
        status: 'PASSED',
        detail: 'Each case serializes one byte-identical participant case across initial, self-review, and treatment calls; E5 USER and E6 DOCUMENT ownership instructions therefore do not vary by condition.'
      },
      {
        checkId: 'CONTINUATION_FRESH_TOPOLOGY',
        status: 'PASSED',
        detail: 'Only each block’s ACTIVE_SELF_REVIEW continues its exact STRONG_INITIAL assignment; all 20 other calls require fresh threads.'
      },
      {
        checkId: 'PREPARED_PROMPT_CEILING',
        status: 'PASSED',
        detail: `All 28 prompt templates remain within the 7,000-token UTF-8/4 estimate; maximum ${maximumEstimatedPromptTokens}.`
      },
      {
        checkId: 'ZERO_PROVIDER_BEHAVIOR',
        status: 'PASSED',
        detail: 'H0 loaded sealed fixtures, materialized and validated prompts, and hashed local values only; it has no driver parameter and dispatched zero provider calls.'
      }
    ]
  };
  if (input.ledger) {
    await input.ledger.writeReport('h1c-h0-validation', report);
    await input.ledger.append({
      eventType: 'H1C_H0_PASSED',
      occurredAt: new Date().toISOString(),
      artifactSha256: promptTemplateSetSha256,
      detail: {
        assignments: 28,
        blocks: 8,
        promptTemplateSetSha256
      }
    });
  }
  return report;
}

export function assertFreshH1cParticipantQuestions(
  records: readonly H1cParticipantRecord[]
): void {
  const current = new Set<string>();
  for (const record of records) {
    const digest = sha256Text(normalizeQuestion(record.participantCase.question));
    if (EXPOSED_DEVELOPMENT_QUESTION_SHA256S.has(digest)) {
      throw new Error(`H1c fresh-case gate rejected an exposed question: ${record.caseId}.`);
    }
    if (current.has(digest)) {
      throw new Error(`H1c fresh-case gate rejected a duplicate v3 question: ${record.caseId}.`);
    }
    current.add(digest);
  }
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function buildH1cHarnessValidationManifest(
  runId: string,
  locks: LabComponentLock,
  createdAt = new Date().toISOString()
): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt,
    driver: {
      id: 'h1c-h0-local-no-provider',
      model: 'none',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: false
    },
    locks: structuredClone(locks),
    caseIds: ['H1C-D5', 'H1C-D6', 'H1C-E5', 'H1C-E6'],
    conditionIds: [
      'STRONG_INITIAL',
      'ACTIVE_SELF_REVIEW',
      'VALID_CRITIQUE',
      'PLACEBO_CRITIQUE',
      'DECISIVE_EVIDENCE'
    ],
    budgets: {
      maximumCalls: 0,
      maximumRounds: 0,
      maximumOutputTokens: 0,
      maximumOutputTokenSafetyCeiling: 0,
      maximumObservedTotalTokens: 0,
      maximumCallMs: 0,
      maximumExperimentMs: 30_000
    },
    providerUsageExplicitlyAuthorized: false
  };
}

export async function loadH1cH0ValidationReceipt(
  ledgerRoot: string,
  runId: string,
  activeLocks: LabComponentLock
): Promise<H1cHarnessValidationReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === '..') {
    throw new Error('H1c H0 receipt has an unsafe run id.');
  }
  const runDirectory = path.join(ledgerRoot, 'runs', runId);
  await assertRealDirectory(runDirectory);
  const runEntries = (await fs.readdir(runDirectory)).sort();
  if (stableJson(runEntries) !== stableJson([
    'artifacts',
    'events',
    'manifest.json',
    'reports'
  ])) {
    throw new Error('H1c H0 receipt contains an unexpected archive entry or provider runtime.');
  }
  const eventsDirectory = path.join(runDirectory, 'events');
  const artifactsDirectory = path.join(runDirectory, 'artifacts');
  const reportsDirectory = path.join(runDirectory, 'reports');
  await Promise.all([
    assertRealDirectory(eventsDirectory),
    assertRealDirectory(artifactsDirectory),
    assertRealDirectory(reportsDirectory)
  ]);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(runDirectory, 'reports', 'h1c-h0-validation.json');
  await Promise.all([assertRealFile(manifestPath), assertRealFile(reportPath)]);
  const [manifestText, reportText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8')
  ]);
  let manifest: LabRunManifest;
  let report: H1cHarnessValidationReport;
  try {
    manifest = JSON.parse(manifestText) as LabRunManifest;
    report = JSON.parse(reportText) as H1cHarnessValidationReport;
  } catch {
    throw new Error('H1c H0 receipt contains invalid JSON.');
  }
  const problems: string[] = [];
  if (
    manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION ||
    manifest.runId !== runId ||
    manifest.phase !== 'HARNESS_VALIDATION' ||
    manifest.status !== 'PLANNED' ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    manifest.providerUsageExplicitlyAuthorized ||
    manifest.budgets.maximumCalls !== 0 ||
    manifest.budgets.maximumRounds !== 0 ||
    manifest.budgets.maximumOutputTokens !== 0 ||
    manifest.budgets.maximumOutputTokenSafetyCeiling !== 0 ||
    manifest.budgets.maximumObservedTotalTokens !== 0 ||
    manifest.budgets.maximumCallMs !== 0 ||
    manifest.budgets.maximumExperimentMs !== 30_000 ||
    stableJson(manifest.caseIds) !== stableJson(['H1C-D5', 'H1C-D6', 'H1C-E5', 'H1C-E6']) ||
    stableJson(manifest.conditionIds) !== stableJson([
      'STRONG_INITIAL',
      'ACTIVE_SELF_REVIEW',
      'VALID_CRITIQUE',
      'PLACEBO_CRITIQUE',
      'DECISIVE_EVIDENCE'
    ]) ||
    stableJson(manifest.driver) !== stableJson({
      id: 'h1c-h0-local-no-provider',
      model: 'none',
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: true,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'PROVIDER_ENFORCED',
      boundaryClass: 'PROVIDER_ENFORCED_STRICT',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: false,
      providerReportedTokenUsage: false
    })
  ) {
    problems.push('manifest');
  }
  if (stableJson(manifest.locks) !== stableJson(activeLocks)) problems.push('manifestLocks');
  if (
    report.schemaVersion !== H1C_HARNESS_VALIDATION_SCHEMA_VERSION ||
    report.validationVersion !== H1C_HARNESS_VALIDATION_VERSION ||
    report.hypothesisId !== 'H0-H1C' ||
    report.status !== 'PASSED' ||
    report.scheduleVersion !== H1C_SCHEDULE_VERSION ||
    report.materializedCallCount !== 28 ||
    report.blockCount !== 8 ||
    report.providerCallCount !== 0 ||
    report.topology?.freshCalls !== 20 ||
    report.topology?.continuationCalls !== 8 ||
    report.maximumEstimatedPromptTokens <= 0 ||
    report.maximumEstimatedPromptTokens > MAXIMUM_PREPARED_PROMPT_TOKENS ||
    !Array.isArray(report.prompts) ||
    report.prompts.length !== 28 ||
    new Set(report.prompts.map((item) => item.assignmentId)).size !== 28 ||
    report.prompts.some(
      (item) =>
        !/^[a-f0-9]{64}$/u.test(item.promptSha256) ||
        item.estimatedPromptTokens <= 0 ||
        item.estimatedPromptTokens > MAXIMUM_PREPARED_PROMPT_TOKENS ||
        !Array.isArray(item.visibleDraftIssueIds) ||
        (item.conditionId === 'STRONG_INITIAL'
          ? item.visibleDraftIssueIds.length !== 0
          : item.visibleDraftIssueIds.length === 0)
    ) ||
    !Array.isArray(report.contractFixtures) ||
    report.contractFixtures.length !== REQUIRED_CONTRACT_FIXTURE_IDS.length ||
    new Set(report.contractFixtures.map((fixture) => fixture.fixtureId)).size !==
      REQUIRED_CONTRACT_FIXTURE_IDS.length ||
    REQUIRED_CONTRACT_FIXTURE_IDS.some(
      (fixtureId) =>
        !report.contractFixtures.some(
          (fixture) =>
            fixture.fixtureId === fixtureId &&
            fixture.status === 'PASSED' &&
            stableJson(fixture.expected) === stableJson(fixture.observed)
        )
    ) ||
    !Array.isArray(report.checks) ||
    report.checks.length !== REQUIRED_CHECK_IDS.length ||
    report.checks.some((check) => check.status !== 'PASSED') ||
    REQUIRED_CHECK_IDS.some(
      (checkId) => !report.checks.some((check) => check.checkId === checkId)
    )
  ) {
    problems.push('report');
  }
  if (stableJson(report.componentLocks) !== stableJson(activeLocks)) {
    problems.push('reportLocks');
  }
  if (!/^[a-f0-9]{64}$/u.test(report.scheduleSha256 ?? '')) problems.push('scheduleSha256');
  if (!/^[a-f0-9]{64}$/u.test(report.promptTemplateSetSha256 ?? '')) {
    problems.push('promptTemplateSetSha256');
  }
  const promptSetPath = path.join(
    runDirectory,
    'artifacts',
    `${report.promptTemplateSetSha256}.json`
  );
  await assertRealFile(promptSetPath).catch(() => problems.push('promptTemplateSetArtifact'));
  if (!problems.includes('promptTemplateSetArtifact')) {
    if (await sha256File(promptSetPath) !== report.promptTemplateSetSha256) {
      problems.push('promptTemplateSetArtifactHash');
    } else {
      const promptSet = await readRealJson<{
        kind?: string;
        promptVersion?: string;
        outputSchemaVersion?: string;
        scheduleVersion?: string;
        scheduleSha256?: string;
        prompts?: Array<{
          assignmentId?: string;
          prompt?: string;
          promptSha256?: string;
          context?: LabPublicOutputV4ValidationContext;
        }>;
      }>(promptSetPath, 'prompt-template artifact');
      if (
        promptSet.kind !== 'H1C_H0_MATERIALIZED_PROMPT_TEMPLATE_SET' ||
        promptSet.promptVersion !== H1C_PROMPT_VERSION ||
        promptSet.outputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION ||
        promptSet.scheduleVersion !== H1C_SCHEDULE_VERSION ||
        promptSet.scheduleSha256 !== report.scheduleSha256 ||
        !Array.isArray(promptSet.prompts) ||
        promptSet.prompts.length !== 28 ||
        promptSet.prompts.some((prompt) =>
          typeof prompt.prompt !== 'string' ||
          prompt.promptSha256 !== sha256Text(prompt.prompt) ||
          !prompt.context ||
          validateLabPublicOutputV4ContextDefinition(prompt.context).length > 0
        )
      ) {
        problems.push('promptTemplateSetArtifactContent');
      } else {
        const materialized = promptSet.prompts as Array<
          H1cH0PromptSummary & {
            prompt: string;
            context: LabPublicOutputV4ValidationContext;
          }
        >;
        const summaries = materialized.map(({ prompt: _prompt, context: _context, ...summary }) =>
          summary
        );
        if (stableJson(summaries) !== stableJson(report.prompts)) {
          problems.push('promptTemplateSetReportMismatch');
        }
      }
    }
  }
  const [eventEntries, artifactEntries, reportEntries] = await Promise.all([
    fs.readdir(eventsDirectory),
    fs.readdir(artifactsDirectory),
    fs.readdir(reportsDirectory)
  ]);
  if (stableJson(eventEntries.sort()) !== stableJson([
    '000001-h1c_h0_started.json',
    '000002-h1c_h0_passed.json'
  ])) problems.push('eventSet');
  if (stableJson(artifactEntries.sort()) !== stableJson([
    `${report.promptTemplateSetSha256}.json`
  ])) problems.push('artifactSet');
  if (stableJson(reportEntries.sort()) !== stableJson(['h1c-h0-validation.json'])) {
    problems.push('reportSet');
  }
  if (!problems.includes('eventSet')) {
    const [started, passed] = await Promise.all([
      readRealJson<Record<string, unknown>>(
        path.join(eventsDirectory, '000001-h1c_h0_started.json'),
        'H0 started event'
      ),
      readRealJson<Record<string, unknown>>(
        path.join(eventsDirectory, '000002-h1c_h0_passed.json'),
        'H0 passed event'
      )
    ]);
    if (
      stableJson(Object.keys(started).sort()) !== stableJson([
        'eventType',
        'occurredAt',
        'schemaVersion',
        'sequence'
      ]) ||
      stableJson(Object.keys(passed).sort()) !== stableJson([
        'artifactSha256',
        'detail',
        'eventType',
        'occurredAt',
        'schemaVersion',
        'sequence'
      ]) ||
      started.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION ||
      started.sequence !== 1 ||
      started.eventType !== 'H1C_H0_STARTED' ||
      typeof started.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(started.occurredAt)) ||
      passed.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION ||
      passed.sequence !== 2 ||
      passed.eventType !== 'H1C_H0_PASSED' ||
      typeof passed.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(passed.occurredAt)) ||
      passed.artifactSha256 !== report.promptTemplateSetSha256 ||
      stableJson(passed.detail) !== stableJson({
        assignments: 28,
        blocks: 8,
        promptTemplateSetSha256: report.promptTemplateSetSha256
      })
    ) {
      problems.push('events');
    }
  }
  if (problems.length > 0) {
    throw new Error(`H1c H0 receipt validation failed: ${problems.join(', ')}.`);
  }
  return {
    runId,
    manifestSha256: sha256Text(manifestText),
    reportSha256: sha256Text(reportText),
    report: structuredClone(report)
  };
}

function materializePromptMatrix(
  participants: H1cParticipantCorpus,
  assignments: readonly H1cAssignment[]
): MaterializedH1cH0Prompt[] {
  const byCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const syntheticDrafts = new Map(
    participants.records.map((record) => [record.caseId, syntheticDraft(record)])
  );
  return assignments.map((assignment) => {
    const record = byCase.get(assignment.caseId);
    if (!record) throw new Error(`H1c H0 cannot resolve participant case ${assignment.caseId}.`);
    const draft = syntheticDrafts.get(assignment.caseId)!;
    const prepared = buildH1cPrompt({
      record,
      conditionId: assignment.conditionId,
      ...(assignment.conditionId === 'STRONG_INITIAL' ? {} : { draft })
    });
    const contextErrors = validateLabPublicOutputV4ContextDefinition(prepared.context);
    if (contextErrors.length > 0) {
      throw new Error(
        `H1c H0 prompt context is unavailable for ${assignment.assignmentId}: ${contextErrors[0]?.ruleId}`
      );
    }
    const candidate = validateLabPublicOutputV4(draft, prepared.context);
    if (!candidate.ok) {
      throw new Error(
        `H1c H0 synthetic v4 output is invalid for ${assignment.assignmentId}: ${candidate.errors[0]?.path} ${candidate.errors[0]?.message}`
      );
    }
    return {
      ...assignment,
      continuationFromAssignmentId:
        assignment.threadMode === 'CONTINUE_INITIAL'
          ? `${assignment.blockId}:STRONG_INITIAL`
          : null,
      visibleArtifactKinds: prepared.context.visibleInterventionArtifacts.map(
        (artifact) => artifact.artifactKind
      ),
      visibleDraftIssueIds: prepared.context.visibleInterventionArtifacts.flatMap(
        (artifact) => artifact.artifactKind === 'POSITION'
          ? artifact.publicOutput.issues.map((issue) => issue.id)
          : []
      ).sort(),
      promptSha256: sha256Text(prepared.prompt),
      estimatedPromptTokens: estimatePromptTokens(prepared.prompt),
      prompt: prepared.prompt,
      context: prepared.context
    };
  });
}

function syntheticDraft(record: H1cParticipantRecord): LabPublicOutputV4 {
  const issue = syntheticDraftIssue(record);
  const output: LabPublicOutputV4 = {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: 'COMPLETE',
    answer: {
      summary: 'Synthetic H0 draft used only to materialize and validate the prompt template.',
      selectedOptionIds: [],
      epistemicState: 'RESOLVED',
      assessmentConfidence: 0.5
    },
    propositionAssessments: record.participantCase.propositions.map((proposition, index) => ({
      id: `synthetic-assessment-${index + 1}`,
      propositionId: proposition.id,
      topicId: proposition.topicId,
      assessment: 'NOT_APPLICABLE',
      statement: 'Synthetic schema-valid assessment; no experimental answer is implied.',
      factualEvidence: [],
      artifactReferences: [],
      assumptionIds: [],
      assessmentConfidence: 0.5
    })),
    assumptions: [],
    issues: [issue],
    responses: [],
    selfCorrections: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'Synthetic schema materialization has no discussion to resolve.',
      resolvedIssueIds: [issue.id],
      unresolvedIssueIds: []
    },
    informationRequests: [],
    abstention: null
  };
  const validation = validateLabPublicOutputV4(output, {
    participantCase: record.participantCase,
    visibleInterventionArtifacts: [],
    interactionStage: 'INITIAL'
  });
  if (!validation.ok) {
    throw new Error(
      `H1c H0 could not construct a valid synthetic draft for ${record.caseId}: ${validation.errors[0]?.message}`
    );
  }
  return output;
}

function syntheticDraftIssue(
  record: H1cParticipantRecord
): LabPublicOutputV4['issues'][number] {
  return {
    id: `h0-${record.caseId.toLowerCase()}-draft-visible-issue`,
    targetArtifactId: 'CASE',
    targetPropositionId: record.participantCase.propositions[0]!.id,
    kind: 'OTHER',
    severity: 'ADVISORY',
    statement: 'Synthetic issue retained so every response-stage H0 context exercises typed DRAFT issue visibility.',
    factualEvidence: [],
    artifactReferences: [{
      artifactId: 'CASE',
      relation: 'MENTIONS',
      note: 'The issue concerns the participant case.'
    }],
    assessmentConfidence: 0.5
  };
}

function assertStageSpecificV4Boundaries(
  participants: H1cParticipantCorpus,
  oracles: H1cOracleCorpus,
  prompts: readonly MaterializedH1cH0Prompt[]
): H1cH0ContractFixtureResult[] {
  const participantById = new Map(
    participants.records.map((record) => [record.caseId, record])
  );
  const oracleById = new Map(oracles.records.map((record) => [record.caseId, record]));
  const record = requiredMapValue(participantById, 'H1C-D5', 'participant');
  const oracle = requiredMapValue(oracleById, 'H1C-D5', 'oracle');
  const evidenceRecord = requiredMapValue(participantById, 'H1C-E5', 'participant');
  const evidenceOracle = requiredMapValue(oracleById, 'H1C-E5', 'oracle');
  const documentRecord = requiredMapValue(participantById, 'H1C-E6', 'participant');
  const documentOracle = requiredMapValue(oracleById, 'H1C-E6', 'oracle');
  const contextFor = (
    caseId: string,
    conditionId: H1cConditionId
  ): LabPublicOutputV4ValidationContext => {
    const match = prompts.find(
      (item) =>
        item.caseId === caseId &&
        item.repetition === 1 &&
        item.conditionId === conditionId
    );
    if (!match) throw new Error(`H1c H0 contract fixture lacks ${caseId}:${conditionId}.`);
    return structuredClone(match.context);
  };
  const initialContext = contextFor(record.caseId, 'STRONG_INITIAL');
  const selfReviewContext = contextFor(record.caseId, 'ACTIVE_SELF_REVIEW');
  const validCritiqueContext = contextFor(record.caseId, 'VALID_CRITIQUE');
  const placeboCritiqueContext = contextFor(record.caseId, 'PLACEBO_CRITIQUE');
  const evidenceContext = contextFor(evidenceRecord.caseId, 'DECISIVE_EVIDENCE');
  const userRequestContext = contextFor(evidenceRecord.caseId, 'STRONG_INITIAL');
  const documentRequestContext = contextFor(documentRecord.caseId, 'STRONG_INITIAL');

  const caseTarget = oracleOutput(record, oracle, oracle.baseProfile);
  caseTarget.issues = [casePromptIssue(record, 'CASE')];
  caseTarget.resolution.resolvedIssueIds = [caseTarget.issues[0]!.id];
  const promptTarget = structuredClone(caseTarget) as LabPublicOutputV4;
  promptTarget.issues[0]!.targetArtifactId = 'PROMPT';

  const authoritativeAnswer = oracleOutput(record, oracle, oracle.baseProfile);
  authoritativeAnswer.answer.summary =
    'Intentionally inaccurate prose: the structured option is still the only scored answer.';
  const legacyValues = structuredClone(authoritativeAnswer) as unknown as {
    answer: Record<string, unknown>;
  };
  legacyValues.answer.values = ['obsolete duplicate'];
  const missingDirectionalEvidence = structuredClone(authoritativeAnswer);
  missingDirectionalEvidence.propositionAssessments[0]!.factualEvidence = [];

  const noChangeSelfReview = typedDraftFromContext(selfReviewContext);
  const declaredSelfCorrection = structuredClone(noChangeSelfReview);
  declaredSelfCorrection.answer.selectedOptionIds = [record.participantCase.options[0]!.id];
  const declaredCorrectionIssue = selfReviewIssue(record);
  declaredSelfCorrection.issues.push(declaredCorrectionIssue);
  declaredSelfCorrection.selfCorrections = [{
    id: 'h0-self-correction',
    targetArtifactId: H1C_DRAFT_ARTIFACT_ID,
    targetIssueId: declaredCorrectionIssue.id,
    disposition: 'CORRECTED',
    statement: 'Corrected the selected structured option after reviewing the draft.',
    changedPublicFields: ['SELECTED_OPTION_IDS'],
    changedPropositionIds: []
  }];
  declaredSelfCorrection.resolution.resolvedIssueIds = declaredSelfCorrection.issues.map(
    (issue) => issue.id
  );
  const mismatchedSelfCorrection = structuredClone(declaredSelfCorrection);
  mismatchedSelfCorrection.selfCorrections[0]!.changedPublicFields = ['ANSWER_SUMMARY'];

  const visibleDraftIssueId = visibleIssueIdsFromLabContextV4(selfReviewContext)[0]!;
  const retainedDraftIssue = structuredClone(noChangeSelfReview);
  const resolvedDraftIssueWithoutReemission = structuredClone(noChangeSelfReview);
  resolvedDraftIssueWithoutReemission.issues = [];
  resolvedDraftIssueWithoutReemission.resolution.resolvedIssueIds = [visibleDraftIssueId];
  const mutatedDraftIssue = structuredClone(noChangeSelfReview);
  mutatedDraftIssue.issues[0]!.kind = 'LOGIC';
  const unknownIssue = structuredClone(resolvedDraftIssueWithoutReemission);
  unknownIssue.resolution.resolvedIssueIds.push('h0-unknown-visible-provenance-issue');
  const lexicalUnknownIssue = structuredClone(unknownIssue);
  lexicalUnknownIssue.answer.summary =
    'The words visible and provenance appear here but cannot classify this typed failure.';
  const malformedContext = structuredClone(selfReviewContext);
  const malformedPosition = malformedContext.visibleInterventionArtifacts.find(
    (artifact) => artifact.artifactKind === 'POSITION'
  );
  if (!malformedPosition || malformedPosition.artifactKind !== 'POSITION') {
    throw new Error('H1c H0 self-review fixture lacks its typed POSITION.');
  }
  malformedPosition.propositionIds = malformedPosition.propositionIds.slice(1);

  const acceptedCritique = critiqueResponseOutput(
    record,
    oracle,
    validCritiqueContext,
    'ACCEPT',
    'RESOLVED'
  );
  const selfFoundResponse = structuredClone(acceptedCritique);
  selfFoundResponse.issues.push(selfReviewIssue(record));
  selfFoundResponse.responses[0]!.targetArtifactId = H1C_DRAFT_ARTIFACT_ID;
  selfFoundResponse.responses[0]!.targetIssueId = selfReviewIssue(record).id;
  selfFoundResponse.responses[0]!.artifactReferences = [{
    artifactId: H1C_DRAFT_ARTIFACT_ID,
    relation: 'RESPONDS_TO',
    note: 'Invalidly treats a self-found issue as an external critique response.'
  }];
  selfFoundResponse.resolution.resolvedIssueIds.push(selfReviewIssue(record).id);
  const missingRespondsTo = structuredClone(acceptedCritique);
  missingRespondsTo.responses[0]!.artifactReferences = [{
    artifactId: critiqueFromPromptContext(validCritiqueContext).artifactId,
    relation: 'MENTIONS',
    note: 'Names the critique without the required direct RESPONDS_TO relation.'
  }];
  const mismatchedRespondsTo = structuredClone(acceptedCritique);
  mismatchedRespondsTo.responses[0]!.artifactReferences.push({
    artifactId: H1C_DRAFT_ARTIFACT_ID,
    relation: 'RESPONDS_TO',
    note: 'A second RESPONDS_TO incorrectly names the position instead of the response target.'
  });
  const critiqueAsFactualSource = structuredClone(acceptedCritique);
  const visibleCritique = critiqueFromPromptContext(validCritiqueContext);
  critiqueAsFactualSource.responses[0]!.factualEvidence = [{
    sourceId: visibleCritique.artifactId,
    relation: 'SUPPORTS',
    note: 'A critique is conversational provenance, not factual evidence.'
  }];
  const rejectedNoDisagreement = critiqueResponseOutput(
    record,
    oracle,
    placeboCritiqueContext,
    'REJECT',
    'NO_DISAGREEMENT'
  );
  const rejectedResolved = critiqueResponseOutput(
    record,
    oracle,
    placeboCritiqueContext,
    'REJECT',
    'RESOLVED'
  );
  const rejectedWithFactualEvidence = structuredClone(rejectedResolved);
  rejectedWithFactualEvidence.responses[0]!.factualEvidence = [{
    sourceId: 'PROMPT',
    relation: 'SUPPORTS',
    note: 'The case text supports retaining the draft despite the unsound review note.'
  }];
  rejectedWithFactualEvidence.resolution.basis = 'FACTUAL_EVIDENCE';
  const acceptedNoMaterialIssue = structuredClone(acceptedCritique);
  acceptedNoMaterialIssue.resolution.basis = 'NO_MATERIAL_ISSUE';
  const partialNoMaterialIssue = structuredClone(acceptedCritique);
  partialNoMaterialIssue.responses[0]!.disposition = 'PARTIAL';
  partialNoMaterialIssue.resolution.status = 'PARTIALLY_RESOLVED';
  partialNoMaterialIssue.resolution.basis = 'NO_MATERIAL_ISSUE';
  partialNoMaterialIssue.resolution.resolvedIssueIds =
    partialNoMaterialIssue.resolution.resolvedIssueIds.filter(
      (issueId) => issueId !== visibleCritique.issueId
    );
  partialNoMaterialIssue.resolution.unresolvedIssueIds = [visibleCritique.issueId];
  const resolvedDisagreement = structuredClone(rejectedResolved);
  resolvedDisagreement.disagreements = [discussionDisagreement(record, 'RESOLVED')];
  const unresolvedDisagreement = structuredClone(resolvedDisagreement);
  unresolvedDisagreement.disagreements[0]!.status = 'UNRESOLVED';
  const omittedCritiqueAccounting = structuredClone(rejectedNoDisagreement);
  omittedCritiqueAccounting.resolution.resolvedIssueIds = [];
  const disappearedCritique = structuredClone(rejectedNoDisagreement);
  disappearedCritique.responses = [];
  disappearedCritique.resolution.resolvedIssueIds = visibleIssueIdsFromLabContextV4(
    placeboCritiqueContext
  ).filter((issueId) => issueId !== record.placeboCritique!.issueId);

  const exhaustiveEvidenceOracle = structuredClone(evidenceOracle);
  const exhaustiveTarget = exhaustiveEvidenceOracle.treatmentProfile.claims.find(
    (claim) => claim.propositionId === exhaustiveEvidenceOracle.targetPropositionIds[0]
  );
  if (!exhaustiveTarget || !evidenceRecord.decisiveEvidence) {
    throw new Error('H1c H0 evidence fixture lacks its target expectation.');
  }
  exhaustiveTarget.allowedEvidenceReferences = [
    ...exhaustiveTarget.requiredEvidenceAlternatives[0]!,
    { evidenceId: 'PROMPT', relation: 'LIMITS' }
  ];
  const requiredPlusAllowed = accountVisibleIssues(oracleOutput(
    evidenceRecord,
    exhaustiveEvidenceOracle,
    exhaustiveEvidenceOracle.treatmentProfile
  ), evidenceContext);
  requiredPlusAllowed.propositionAssessments[0]!.factualEvidence.push({
    sourceId: 'PROMPT',
    relation: 'LIMITS',
    note: 'The prompt also identifies the original missing-information boundary.'
  });
  const allowedWithoutRequired = structuredClone(requiredPlusAllowed);
  allowedWithoutRequired.propositionAssessments[0]!.factualEvidence = [{
    sourceId: 'PROMPT',
    relation: 'SUPPORTS',
    note: 'Allowed context alone does not supply the required missing birth date.'
  }];
  const disallowedEvidence = structuredClone(requiredPlusAllowed);
  disallowedEvidence.propositionAssessments[0]!.factualEvidence.push({
    sourceId: 'PROMPT',
    relation: 'CONTRADICTS',
    note: 'Known source and direction, but not an oracle-allowed pair for this claim.'
  });
  const nullAllowanceEvidence = accountVisibleIssues(oracleOutput(
    evidenceRecord,
    evidenceOracle,
    evidenceOracle.treatmentProfile
  ), evidenceContext);
  nullAllowanceEvidence.propositionAssessments[0]!.factualEvidence.push({
    sourceId: 'PROMPT',
    relation: 'LIMITS',
    note: 'Semantically plausible extra support whose relevance is deliberately unadjudicated.'
  });
  const factualPacketAsConversation = structuredClone(nullAllowanceEvidence);
  factualPacketAsConversation.propositionAssessments[0]!.factualEvidence = [{
    sourceId: 'PROMPT',
    relation: 'SUPPORTS',
    note: 'The prompt supplies the rule but not the missing treatment fact.'
  }];
  factualPacketAsConversation.propositionAssessments[0]!.artifactReferences.push({
    artifactId: evidenceRecord.decisiveEvidence.artifactId,
    relation: 'MENTIONS',
    note: 'A factual packet is not a conversational artifact.'
  });

  const blockingUserRequest = oracleOutput(
    evidenceRecord,
    evidenceOracle,
    evidenceOracle.baseProfile
  );
  const blockingDocumentRequest = oracleOutput(
    documentRecord,
    documentOracle,
    documentOracle.baseProfile
  );
  const requestSupersetOracle = structuredClone(evidenceOracle);
  requestSupersetOracle.baseProfile.informationRequest!.allowedPropositionIds = [
    evidenceOracle.baseProfile.informationRequest!.requiredPropositionIds[0]!,
    evidenceRecord.participantCase.propositions[1]!.id
  ];
  const allowedSupersetRequest = oracleOutput(
    evidenceRecord,
    requestSupersetOracle,
    requestSupersetOracle.baseProfile
  );
  allowedSupersetRequest.informationRequests[0]!.propositionIds.push(
    evidenceRecord.participantCase.propositions[1]!.id
  );
  const missingRequiredTargetRequest = structuredClone(allowedSupersetRequest);
  missingRequiredTargetRequest.informationRequests[0]!.propositionIds = [
    evidenceRecord.participantCase.propositions[1]!.id
  ];
  const disallowedExtraTargetRequest = structuredClone(blockingUserRequest);
  disallowedExtraTargetRequest.informationRequests[0]!.propositionIds.push(
    evidenceRecord.participantCase.propositions[2]!.id
  );
  const wrongOwnerRequest = structuredClone(blockingDocumentRequest);
  wrongOwnerRequest.informationRequests[0]!.source = 'USER';
  wrongOwnerRequest.completionDisposition = 'NEEDS_USER_ACTION';
  wrongOwnerRequest.resolution.status = 'NEEDS_USER_ACTION';
  const independentEscalation = structuredClone(disallowedExtraTargetRequest);
  const explicitAbstention = syntheticDraft(record);
  explicitAbstention.completionDisposition = 'ABSTAIN';
  explicitAbstention.abstention = {
    reason: 'OUTSIDE_CAPABILITY',
    summary: 'The actor explicitly abstains from performing the evaluation.',
    propositionIds: [record.participantCase.propositions[0]!.id],
    whatWouldResolve: null
  };
  const missingAbstention = structuredClone(explicitAbstention);
  missingAbstention.abstention = null;

  const fixtures: H1cH0ContractFixtureResult[] = [
    evaluateContractFixture({
      fixtureId: 'INITIAL_CASE_TARGET_PROMPT_SOURCE_ACCEPTED',
      concern: 'CASE_PROMPT_TARGETING',
      context: initialContext,
      output: caseTarget,
      expectedContractAccepted: true,
      semanticCheckId: 'RESOLUTION_ACCOUNTING_CONSISTENT',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(output)
    }),
    evaluateContractFixture({
      fixtureId: 'INITIAL_PROMPT_AS_ISSUE_TARGET_REJECTED',
      concern: 'CASE_PROMPT_TARGETING',
      context: initialContext,
      output: promptTarget,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.issue.target-artifact',
        'CONVERSATIONAL_PROVENANCE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'INITIAL_SELECTED_OPTIONS_AUTHORITATIVE',
      concern: 'ANSWER_AUTHORITY',
      context: initialContext,
      output: authoritativeAnswer,
      expectedContractAccepted: true,
      semanticCheckId: 'STRUCTURED_ANSWER_IGNORES_SUMMARY_TEXT',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle,
          output
        });
        return score.structuredAnswerCorrect === true &&
          score.answerTextQualityStatus === 'UNADJUDICATED_SUMMARY_ONLY';
      }
    }),
    evaluateContractFixture({
      fixtureId: 'INITIAL_LEGACY_ANSWER_VALUES_REJECTED',
      concern: 'ANSWER_AUTHORITY',
      context: initialContext,
      output: legacyValues,
      expectedContractAccepted: false
    }),
    evaluateContractFixture({
      fixtureId: 'INITIAL_DIRECTIONAL_EVIDENCE_OMISSION_SCORE_FAILURE',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: initialContext,
      output: missingDirectionalEvidence,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUIRED_DIRECTIONAL_EVIDENCE_PRESENT',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) =>
        scoreH1cOutput({ conditionId: 'STRONG_INITIAL', oracle, output })
          .evidentialSupport.rate === 1
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_NO_CHANGE_ACCEPTED',
      concern: 'SELF_CORRECTION',
      context: selfReviewContext,
      output: noChangeSelfReview,
      expectedContractAccepted: true,
      semanticCheckId: 'SELF_CORRECTION_REPRESENTATION',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) =>
        scoreSelfCorrectionRepresentation(
          'ACTIVE_SELF_REVIEW',
          output,
          typedDraftFromContext(selfReviewContext)
        ) === true
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_DECLARED_CORRECTION_ACCEPTED',
      concern: 'SELF_CORRECTION',
      context: selfReviewContext,
      output: declaredSelfCorrection,
      expectedContractAccepted: true,
      semanticCheckId: 'SELF_CORRECTION_REPRESENTATION',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) =>
        scoreSelfCorrectionRepresentation(
          'ACTIVE_SELF_REVIEW',
          output,
          typedDraftFromContext(selfReviewContext)
        ) === true && scoreResolutionConsistency(
          output,
          visibleIssueIdsFromLabContextV4(selfReviewContext)
        )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_DECLARATION_MISMATCH_SCORE_FAILURE',
      concern: 'SELF_CORRECTION',
      context: selfReviewContext,
      output: mismatchedSelfCorrection,
      expectedContractAccepted: true,
      semanticCheckId: 'SELF_CORRECTION_REPRESENTATION',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) =>
        scoreSelfCorrectionRepresentation(
          'ACTIVE_SELF_REVIEW',
          output,
          typedDraftFromContext(selfReviewContext)
        ) === true
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_DRAFT_ISSUE_RETAINED_STABLE_IDENTITY',
      concern: 'RESOLUTION_ACCOUNTING',
      context: selfReviewContext,
      output: retainedDraftIssue,
      expectedContractAccepted: true,
      semanticCheckId: 'DRAFT_ISSUE_STABLE_IDENTITY_AND_ACCOUNTING',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(selfReviewContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_DRAFT_ISSUE_RESOLVED_WITHOUT_REEMISSION',
      concern: 'RESOLUTION_ACCOUNTING',
      context: selfReviewContext,
      output: resolvedDraftIssueWithoutReemission,
      expectedContractAccepted: true,
      semanticCheckId: 'DRAFT_ISSUE_RESOLUTION_WITHOUT_DUPLICATION',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(selfReviewContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_DRAFT_ISSUE_IDENTITY_MUTATION_REJECTED',
      concern: 'TYPED_FAILURE_CLASSIFICATION',
      context: selfReviewContext,
      output: mutatedDraftIssue,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.issue.draft-identity-retention',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_UNKNOWN_ISSUE_OUTPUT_INVALID',
      concern: 'TYPED_FAILURE_CLASSIFICATION',
      context: selfReviewContext,
      output: unknownIssue,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.resolution.issue-reference',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_CONTEXT_FAULT_MEASUREMENT_UNAVAILABLE',
      concern: 'TYPED_FAILURE_CLASSIFICATION',
      context: malformedContext,
      output: noChangeSelfReview,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.context.position-case-propositions',
        'CONTEXT_INTEGRITY',
        'MEASUREMENT_UNAVAILABLE'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'SELF_REVIEW_LEXICAL_PROVENANCE_WORDS_DO_NOT_CLASSIFY',
      concern: 'TYPED_FAILURE_CLASSIFICATION',
      context: selfReviewContext,
      output: lexicalUnknownIssue,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.resolution.issue-reference',
        'ISSUE_LIFECYCLE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_EXTERNAL_RESPONSE_ACCEPTED',
      concern: 'CRITIQUE_PROVENANCE',
      context: validCritiqueContext,
      output: acceptedCritique,
      expectedContractAccepted: true,
      semanticCheckId: 'DIRECT_VALID_CRITIQUE_RESPONSE',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'VALID_CRITIQUE',
          oracle,
          output,
          draftOutput: typedDraftFromContext(validCritiqueContext),
          visibleIssueIds: visibleIssueIdsFromLabContextV4(validCritiqueContext)
        });
        return score.directCritiqueResponse === true &&
          score.critiqueDispositionAppropriate === true &&
          score.critiqueChangedTargetWhenRequired === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_SELF_FOUND_RESPONSE_REJECTED',
      concern: 'CRITIQUE_PROVENANCE',
      context: validCritiqueContext,
      output: selfFoundResponse,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.response.critique-target',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_MISSING_RESPONDS_TO_REJECTED',
      concern: 'CRITIQUE_PROVENANCE',
      context: validCritiqueContext,
      output: missingRespondsTo,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.response.responds-to-required',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_MISMATCHED_RESPONDS_TO_REJECTED',
      concern: 'CRITIQUE_PROVENANCE',
      context: validCritiqueContext,
      output: mismatchedRespondsTo,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.response.responds-to-exact-target',
        'RESPONSE_PROVENANCE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_AS_FACTUAL_SOURCE_REJECTED',
      concern: 'CRITIQUE_PROVENANCE',
      context: validCritiqueContext,
      output: critiqueAsFactualSource,
      expectedContractAccepted: false,
      expectedValidationFailure: typedFailure(
        'v4.provenance.factual-source',
        'FACTUAL_PROVENANCE',
        'OUTPUT_INVALID'
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_REJECTION_NO_DISAGREEMENT_ACCEPTED',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: rejectedNoDisagreement,
      expectedContractAccepted: true,
      semanticCheckId: 'RESOLUTION_CONSISTENCY',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_REJECTION_RESOLVED_ACCEPTED',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: rejectedResolved,
      expectedContractAccepted: true,
      semanticCheckId: 'RESOLUTION_CONSISTENCY',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_REJECTION_FACTUAL_EVIDENCE_ACCEPTED',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: rejectedWithFactualEvidence,
      expectedContractAccepted: true,
      semanticCheckId: 'REJECTED_CRITIQUE_FACTUAL_BASIS',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_ACCEPT_NO_MATERIAL_ISSUE_SCORE_FAILURE',
      concern: 'RESOLUTION_ACCOUNTING',
      context: validCritiqueContext,
      output: acceptedNoMaterialIssue,
      expectedContractAccepted: true,
      semanticCheckId: 'ACCEPTED_CRITIQUE_REQUIRES_MATERIAL_BASIS',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(validCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_PARTIAL_NO_MATERIAL_ISSUE_SCORE_FAILURE',
      concern: 'RESOLUTION_ACCOUNTING',
      context: validCritiqueContext,
      output: partialNoMaterialIssue,
      expectedContractAccepted: true,
      semanticCheckId: 'PARTIAL_CRITIQUE_REQUIRES_MATERIAL_BASIS',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(validCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'RESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_ACCEPTED',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: resolvedDisagreement,
      expectedContractAccepted: true,
      semanticCheckId: 'RESOLVED_DISAGREEMENT_COMPATIBLE_WITH_GLOBAL_RESOLVED',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'UNRESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_SCORE_FAILURE',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: unresolvedDisagreement,
      expectedContractAccepted: true,
      semanticCheckId: 'UNRESOLVED_DISAGREEMENT_BLOCKS_GLOBAL_RESOLVED',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_OMITTED_ACCOUNTING_SCORE_FAILURE',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: omittedCritiqueAccounting,
      expectedContractAccepted: true,
      semanticCheckId: 'RESOLUTION_CONSISTENCY',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'CRITIQUE_VISIBLE_ISSUE_DISAPPEARS_SCORE_FAILURE',
      concern: 'RESOLUTION_ACCOUNTING',
      context: placeboCritiqueContext,
      output: disappearedCritique,
      expectedContractAccepted: true,
      semanticCheckId: 'VISIBLE_ISSUE_ACCOUNTED',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreResolutionConsistency(
        output,
        visibleIssueIdsFromLabContextV4(placeboCritiqueContext)
      )
    }),
    evaluateContractFixture({
      fixtureId: 'EVIDENCE_REQUIRED_PLUS_ALLOWED_ACCEPTED',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: evidenceContext,
      output: requiredPlusAllowed,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUIRED_PRESENT_AND_NO_UNEXPECTED_EVIDENCE',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'DECISIVE_EVIDENCE',
          oracle: exhaustiveEvidenceOracle,
          output,
          visibleIssueIds: visibleIssueIdsFromLabContextV4(evidenceContext)
        });
        return score.evidentialSupport.rate === 1 &&
          score.disallowedFactualEvidenceReferenceCount === 0 &&
          score.requiredTreatmentEvidencePresent === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'EVIDENCE_ALLOWED_WITHOUT_REQUIRED_SCORE_FAILURE',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: evidenceContext,
      output: allowedWithoutRequired,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUIRED_PRESENT_AND_NO_UNEXPECTED_EVIDENCE',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'DECISIVE_EVIDENCE',
          oracle: exhaustiveEvidenceOracle,
          output,
          visibleIssueIds: visibleIssueIdsFromLabContextV4(evidenceContext)
        });
        return score.evidentialSupport.rate === 1 &&
          score.disallowedFactualEvidenceReferenceCount === 0 &&
          score.requiredTreatmentEvidencePresent === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'EVIDENCE_DISALLOWED_REFERENCE_SCORE_FAILURE',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: evidenceContext,
      output: disallowedEvidence,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUIRED_PRESENT_AND_NO_UNEXPECTED_EVIDENCE',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'DECISIVE_EVIDENCE',
          oracle: exhaustiveEvidenceOracle,
          output,
          visibleIssueIds: visibleIssueIdsFromLabContextV4(evidenceContext)
        });
        return score.evidentialSupport.rate === 1 &&
          score.disallowedFactualEvidenceReferenceCount === 0 &&
          score.requiredTreatmentEvidencePresent === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'EVIDENCE_NULL_ALLOWANCE_UNADJUDICATED_ACCEPTED',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: evidenceContext,
      output: nullAllowanceEvidence,
      expectedContractAccepted: true,
      semanticCheckId: 'UNADJUDICATED_EXTRA_IS_NOT_DISALLOWED',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'DECISIVE_EVIDENCE',
          oracle: evidenceOracle,
          output,
          visibleIssueIds: visibleIssueIdsFromLabContextV4(evidenceContext)
        });
        return score.evidenceAllowanceStatus === 'PARTIALLY_ADJUDICATED' &&
          score.disallowedFactualEvidenceReferenceCount === 0 &&
          score.unadjudicatedFactualEvidenceReferenceCount === 1 &&
          score.requiredTreatmentEvidencePresent === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'EVIDENCE_ARTIFACT_REFERENCE_NOT_FACTUAL_SUPPORT',
      concern: 'EVIDENCE_REQUIREMENT_ALLOWANCE',
      context: evidenceContext,
      output: factualPacketAsConversation,
      expectedContractAccepted: true,
      semanticCheckId: 'CONVERSATIONAL_REFERENCE_DOES_NOT_SATISFY_FACTUAL_SUPPORT',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'DECISIVE_EVIDENCE',
          oracle: evidenceOracle,
          output,
          visibleIssueIds: visibleIssueIdsFromLabContextV4(evidenceContext)
        });
        return score.evidentialSupport.rate === 1 &&
          score.requiredTreatmentEvidencePresent === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_BLOCKING_USER_ACCEPTED',
      concern: 'REQUEST_ABSTENTION',
      context: userRequestContext,
      output: blockingUserRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_SOURCE_AND_COMPLETION',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle: evidenceOracle,
          output
        });
        return score.informationRequestStructureCorrect === true &&
          score.informationRequestTargetingCorrect === true &&
          score.userEscalationCorrect === true &&
          output.completionDisposition === 'NEEDS_USER_ACTION';
      }
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_BLOCKING_DOCUMENT_ACCEPTED',
      concern: 'REQUEST_ABSTENTION',
      context: documentRequestContext,
      output: blockingDocumentRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_SOURCE_AND_COMPLETION',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle: documentOracle,
          output
        });
        return score.informationRequestStructureCorrect === true &&
          score.informationRequestTargetingCorrect === true &&
          score.userEscalationCorrect === true &&
          output.completionDisposition === 'COMPLETE';
      }
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_REQUIRED_SUBSET_ALLOWED_SUPERSET_ACCEPTED',
      concern: 'REQUEST_ABSTENTION',
      context: userRequestContext,
      output: allowedSupersetRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_REQUIRED_SUBSET_ALLOWED_SUPERSET',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle: requestSupersetOracle,
          output
        });
        return score.informationRequestStructureCorrect === true &&
          score.informationRequestTargetingCorrect === true &&
          score.userEscalationCorrect === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_MISSING_REQUIRED_TARGET_SCORE_FAILURE',
      concern: 'REQUEST_ABSTENTION',
      context: userRequestContext,
      output: missingRequiredTargetRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_MISSING_REQUIRED_TARGET',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreH1cOutput({
        conditionId: 'STRONG_INITIAL',
        oracle: requestSupersetOracle,
        output
      }).informationRequestTargetingCorrect === true
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_DISALLOWED_EXTRA_TARGET_SCORE_FAILURE',
      concern: 'REQUEST_ABSTENTION',
      context: userRequestContext,
      output: disallowedExtraTargetRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_DISALLOWED_EXTRA_TARGET',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => scoreH1cOutput({
        conditionId: 'STRONG_INITIAL',
        oracle: evidenceOracle,
        output
      }).informationRequestTargetingCorrect === true
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_WRONG_OWNER_SCORE_FAILURE',
      concern: 'REQUEST_ABSTENTION',
      context: documentRequestContext,
      output: wrongOwnerRequest,
      expectedContractAccepted: true,
      semanticCheckId: 'REQUEST_OWNER_AND_COMPLETION',
      expectedSemanticCheckPassed: false,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle: documentOracle,
          output
        });
        return score.informationRequestStructureCorrect === true &&
          score.userEscalationCorrect === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'REQUEST_ESCALATION_INDEPENDENT_OF_TARGETING',
      concern: 'REQUEST_ABSTENTION',
      context: userRequestContext,
      output: independentEscalation,
      expectedContractAccepted: true,
      semanticCheckId: 'USER_ESCALATION_SEPARATE_FROM_TARGETING',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) => {
        const score = scoreH1cOutput({
          conditionId: 'STRONG_INITIAL',
          oracle: evidenceOracle,
          output
        });
        return score.informationRequestStructureCorrect === true &&
          score.informationRequestTargetingCorrect === false &&
          score.userEscalationCorrect === true;
      }
    }),
    evaluateContractFixture({
      fixtureId: 'ABSTENTION_EXPLICIT_ACCEPTED',
      concern: 'REQUEST_ABSTENTION',
      context: initialContext,
      output: explicitAbstention,
      expectedContractAccepted: true,
      semanticCheckId: 'ABSTENTION_ROUND_TRIP',
      expectedSemanticCheckPassed: true,
      semanticCheck: (output) =>
        output.completionDisposition === 'ABSTAIN' && output.abstention !== null
    }),
    evaluateContractFixture({
      fixtureId: 'ABSTENTION_MISSING_OBJECT_REJECTED',
      concern: 'REQUEST_ABSTENTION',
      context: initialContext,
      output: missingAbstention,
      expectedContractAccepted: false
    }),
    evaluateContractFixture({
      fixtureId: 'EXPLICIT_COHORT_DENOMINATOR_ACCOUNTING',
      concern: 'DENOMINATOR_ACCOUNTING',
      context: initialContext,
      output: authoritativeAnswer,
      expectedContractAccepted: true,
      semanticCheckId: 'COHORT_COUNTS_EXCLUDE_INVALID_UNAVAILABLE_UNSTARTED',
      expectedSemanticCheckPassed: true,
      semanticCheck: () => assertExplicitCohortDenominators(
        evidenceRecord,
        evidenceOracle,
        documentRecord,
        documentOracle
      )
    })
  ];
  if (
    stableJson(fixtures.map((fixture) => fixture.fixtureId)) !==
      stableJson(REQUIRED_CONTRACT_FIXTURE_IDS)
  ) {
    throw new Error('H1c H0 contract fixture matrix is incomplete or reordered.');
  }
  return fixtures;
}

function evaluateContractFixture(input: {
  fixtureId: string;
  concern: H1cH0ContractFixtureResult['concern'];
  context: LabPublicOutputV4ValidationContext;
  output: unknown;
  expectedContractAccepted: boolean;
  expectedValidationFailure?: H1cH0TypedValidationFailure;
  semanticCheckId?: string;
  expectedSemanticCheckPassed?: boolean;
  semanticCheck?: (output: LabPublicOutputV4) => boolean;
}): H1cH0ContractFixtureResult {
  const validation = validateLabPublicOutputV4(input.output, input.context);
  const contractAccepted = validation.ok;
  const validationFailure = validation.ok
    ? null
    : firstTypedValidationFailure(validation.errors);
  const semanticCheckId = input.semanticCheckId ?? null;
  const semanticCheckPassed = validation.ok && input.semanticCheck
    ? input.semanticCheck(validation.value)
    : null;
  const expected = {
    contractAccepted: input.expectedContractAccepted,
    validationFailure: input.expectedValidationFailure ?? null,
    semanticCheckId,
    semanticCheckPassed: input.expectedSemanticCheckPassed ?? null
  };
  const observed = {
    contractAccepted,
    validationFailure,
    semanticCheckId,
    semanticCheckPassed
  };
  if (stableJson(expected) !== stableJson(observed)) {
    const validationDetail = validation.ok
      ? ''
      : ` ${validation.errors.map((error) => `${error.path}:${error.code}`).join(', ')}`;
    throw new Error(
      `H1c H0 contract fixture ${input.fixtureId} diverged: expected ${stableJson(expected)}, observed ${stableJson(observed)}.${validationDetail}`
    );
  }
  return {
    fixtureId: input.fixtureId,
    interactionStage: input.context.interactionStage,
    concern: input.concern,
    expected,
    observed,
    status: 'PASSED'
  };
}

function typedFailure(
  ruleId: string,
  domain: H1cH0TypedValidationFailure['domain'],
  measurementEffect: H1cH0TypedValidationFailure['measurementEffect']
): H1cH0TypedValidationFailure {
  return { ruleId, domain, measurementEffect };
}

function firstTypedValidationFailure(
  errors: readonly LabValidationError[]
): H1cH0TypedValidationFailure | null {
  const error = errors.find((candidate) =>
    Boolean(candidate.ruleId && candidate.domain && candidate.measurementEffect)
  );
  return error?.ruleId && error.domain && error.measurementEffect
    ? typedFailure(error.ruleId, error.domain, error.measurementEffect)
    : null;
}

function typedDraftFromContext(
  context: LabPublicOutputV4ValidationContext
): LabPublicOutputV4 {
  const position = context.visibleInterventionArtifacts.find(
    (artifact) => artifact.artifactKind === 'POSITION'
  );
  if (!position || position.artifactKind !== 'POSITION') {
    throw new Error(`H1c H0 ${context.interactionStage} context lacks a typed POSITION.`);
  }
  return structuredClone(position.publicOutput);
}

function accountVisibleIssues(
  output: LabPublicOutputV4,
  context: LabPublicOutputV4ValidationContext
): LabPublicOutputV4 {
  const copy = structuredClone(output);
  copy.resolution.resolvedIssueIds = [
    ...new Set([
      ...copy.resolution.resolvedIssueIds,
      ...visibleIssueIdsFromLabContextV4(context)
    ])
  ];
  return copy;
}

function critiqueFromPromptContext(
  context: LabPublicOutputV4ValidationContext
): Extract<LabVisibleInterventionArtifactV4, { artifactKind: 'CRITIQUE' }> {
  const critique = context.visibleInterventionArtifacts.find(
    (artifact) => artifact.artifactKind === 'CRITIQUE'
  );
  if (!critique || critique.artifactKind !== 'CRITIQUE') {
    throw new Error('H1c H0 critique context lacks a typed CRITIQUE.');
  }
  return critique;
}

function discussionDisagreement(
  record: H1cParticipantRecord,
  status: 'RESOLVED' | 'UNRESOLVED'
): LabPublicOutputV4['disagreements'][number] {
  return {
    id: `h0-${record.caseId.toLowerCase()}-${status.toLowerCase()}-disagreement`,
    propositionIds: [record.participantCase.propositions[0]!.id],
    participantArtifactIds: ['CASE'],
    status,
    summary: status === 'RESOLVED'
      ? 'The public disagreement was resolved without erasing that it existed.'
      : 'The public disagreement remains unresolved.',
    factualEvidence: [],
    artifactReferences: [{
      artifactId: 'CASE',
      relation: 'MENTIONS',
      note: 'The disagreement concerns the case.'
    }],
    informationRequestId: null
  };
}

function assertExplicitCohortDenominators(
  evidenceRecord: H1cParticipantRecord,
  evidenceOracle: H1cOracleRecord,
  documentRecord: H1cParticipantRecord,
  documentOracle: H1cOracleRecord
): boolean {
  const e5Base = oracleOutput(evidenceRecord, evidenceOracle, evidenceOracle.baseProfile);
  const e6Base = oracleOutput(documentRecord, documentOracle, documentOracle.baseProfile);
  const e6SelfFailure = structuredClone(e6Base);
  e6SelfFailure.answer.selectedOptionIds = [];
  const observations: H1cScoredObservation[] = [
    scoredObservation('H1C-E5:r1', evidenceRecord, 1, 'STRONG_INITIAL', evidenceOracle, e5Base),
    missingObservation('H1C-E6:r1', documentRecord, 1, 'STRONG_INITIAL', documentOracle, 'INVALID'),
    missingObservation('H1C-E5:r2', evidenceRecord, 2, 'STRONG_INITIAL', evidenceOracle, 'UNAVAILABLE'),
    scoredObservation(
      'H1C-E5:r1',
      evidenceRecord,
      1,
      'ACTIVE_SELF_REVIEW',
      evidenceOracle,
      e5Base,
      e5Base
    ),
    scoredObservation(
      'H1C-E6:r1',
      documentRecord,
      1,
      'ACTIVE_SELF_REVIEW',
      documentOracle,
      e6SelfFailure,
      e6Base
    ),
    missingObservation(
      'H1C-E5:r2',
      evidenceRecord,
      2,
      'ACTIVE_SELF_REVIEW',
      evidenceOracle,
      'INVALID'
    ),
    missingObservation(
      'H1C-E6:r2',
      documentRecord,
      2,
      'ACTIVE_SELF_REVIEW',
      documentOracle,
      'UNAVAILABLE'
    )
  ];
  const interpretation = interpretH1c(observations);
  return stableJson(interpretation.newEvidence.baseContextCorrect) === stableJson({
    planned: 4,
    observed: 3,
    valid: 1,
    eligible: 1,
    passed: 1,
    failed: 0,
    invalid: 1,
    unavailable: 1,
    unstarted: 1,
    rate: 1
  }) && stableJson(interpretation.newEvidence.selfReviewContextCorrect) === stableJson({
    planned: 4,
    observed: 4,
    valid: 2,
    eligible: 2,
    passed: 1,
    failed: 1,
    invalid: 1,
    unavailable: 1,
    unstarted: 0,
    rate: 0.5
  }) && stableJson(interpretation.newEvidence.evidenceContextCorrect) === stableJson({
    planned: 4,
    observed: 0,
    valid: 0,
    eligible: 0,
    passed: 0,
    failed: 0,
    invalid: 0,
    unavailable: 0,
    unstarted: 4,
    rate: null
  });
}

function scoredObservation(
  blockId: string,
  record: H1cParticipantRecord,
  repetition: 1 | 2,
  conditionId: H1cConditionId,
  oracle: H1cOracleRecord,
  output: LabPublicOutputV4,
  draftOutput: LabPublicOutputV4 | null = null
): H1cScoredObservation {
  return {
    blockId,
    caseId: record.caseId,
    repetition,
    conditionId,
    score: scoreH1cOutput({ conditionId, oracle, output, draftOutput }),
    output,
    draftOutput,
    measurementStatus: 'VALID'
  };
}

function missingObservation(
  blockId: string,
  record: H1cParticipantRecord,
  repetition: 1 | 2,
  conditionId: H1cConditionId,
  oracle: H1cOracleRecord,
  measurementStatus: 'INVALID' | 'UNAVAILABLE'
): H1cScoredObservation {
  return {
    blockId,
    caseId: record.caseId,
    repetition,
    conditionId,
    score: scoreH1cOutput({ conditionId, oracle, output: null }),
    output: null,
    draftOutput: null,
    measurementStatus
  };
}

function oracleOutput(
  record: H1cParticipantRecord,
  oracle: H1cOracleRecord,
  profile: H1cOracleProfile
): LabPublicOutputV4 {
  const propositions = new Map(
    record.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const informationRequests = profile.informationRequest
    ? [{
        id: `h0-request-${record.caseId.toLowerCase()}`,
        kind: profile.informationRequest.kind,
        needed: 'The missing source-owned fact identified by the case.',
        question: 'Provide the missing fact needed to resolve the target proposition.',
        source: profile.informationRequest.source,
        blocking: profile.informationRequest.blocking,
        propositionIds: [...profile.informationRequest.requiredPropositionIds]
      }]
    : [];
  const underdetermined = profile.epistemicState === 'UNDERDETERMINED';
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    completionDisposition: profile.completionDisposition,
    answer: {
      summary: 'Deterministic H0 output built from scorer-only expectations.',
      selectedOptionIds: [...profile.selectedOptionIds],
      epistemicState: profile.epistemicState,
      assessmentConfidence: 0.8
    },
    propositionAssessments: profile.claims.map((claim, index) => {
      const proposition = propositions.get(claim.propositionId);
      if (!proposition) {
        throw new Error(`H1c H0 oracle references unknown proposition ${claim.propositionId}.`);
      }
      return {
        id: `h0-${record.caseId.toLowerCase()}-assessment-${index + 1}`,
        propositionId: claim.propositionId,
        topicId: proposition.topicId,
        assessment: claim.assessment,
        statement: 'Deterministic assessment for contract/scorer boundary validation.',
        factualEvidence: (claim.requiredEvidenceAlternatives[0] ?? []).map((reference) => ({
          sourceId: reference.evidenceId,
          relation: reference.relation,
          note: 'Required directional evidence selected by the sealed oracle fixture.'
        })),
        artifactReferences: [],
        assumptionIds: [],
        assessmentConfidence: 0.8
      };
    }),
    assumptions: [],
    issues: [],
    responses: [],
    selfCorrections: [],
    disagreements: [],
    resolution: {
      status: profile.completionDisposition === 'NEEDS_USER_ACTION'
        ? 'NEEDS_USER_ACTION'
        : underdetermined
          ? 'UNRESOLVED'
          : 'RESOLVED',
      basis: underdetermined ? 'INSUFFICIENT_INFORMATION' : 'FACTUAL_EVIDENCE',
      summary: underdetermined
        ? 'The identified source-owned fact is still missing.'
        : 'The available factual evidence resolves the answer.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    informationRequests,
    abstention: profile.completionDisposition === 'ABSTAIN'
      ? {
          reason: 'OUTSIDE_CAPABILITY',
          summary: 'The actor cannot perform the requested evaluation.',
          propositionIds: oracle.targetPropositionIds,
          whatWouldResolve: null
        }
      : null
  };
}

function casePromptIssue(
  record: H1cParticipantRecord,
  targetArtifactId: 'CASE' | 'PROMPT'
): LabPublicOutputV4['issues'][number] {
  return {
    id: 'h0-case-prompt-issue',
    targetArtifactId,
    targetPropositionId: record.participantCase.propositions[0]!.id,
    kind: 'MISSING_INFORMATION',
    severity: 'ADVISORY',
    statement: 'The case framing is the issue target; the prompt text is factual provenance.',
    factualEvidence: [{
      sourceId: 'PROMPT',
      relation: 'LIMITS',
      note: 'The case text bounds what can be inferred.'
    }],
    artifactReferences: [{
      artifactId: 'CASE',
      relation: 'MENTIONS',
      note: 'Identifies the case as the conversational target.'
    }],
    assessmentConfidence: 0.8
  };
}

function selfReviewIssue(
  record: H1cParticipantRecord
): LabPublicOutputV4['issues'][number] {
  return {
    id: 'h0-self-review-issue',
    targetArtifactId: H1C_DRAFT_ARTIFACT_ID,
    targetPropositionId: record.participantCase.propositions[0]!.id,
    kind: 'OTHER',
    severity: 'ADVISORY',
    statement: 'The selected structured option in the draft needs correction.',
    factualEvidence: [],
    artifactReferences: [{
      artifactId: H1C_DRAFT_ARTIFACT_ID,
      relation: 'MENTIONS',
      note: 'Identifies the self-reviewed draft.'
    }],
    assessmentConfidence: 0.8
  };
}

function critiqueResponseOutput(
  record: H1cParticipantRecord,
  oracle: H1cOracleRecord,
  context: LabPublicOutputV4ValidationContext,
  disposition: 'ACCEPT' | 'REJECT',
  resolutionStatus: 'RESOLVED' | 'NO_DISAGREEMENT'
): LabPublicOutputV4 {
  const output = oracleOutput(record, oracle, oracle.baseProfile);
  const critique = context.visibleInterventionArtifacts.find(
    (artifact) => artifact.artifactKind === 'CRITIQUE'
  );
  if (!critique || critique.artifactKind !== 'CRITIQUE') {
    throw new Error('H1c H0 critique fixture has no visible critique.');
  }
  const targetAssessment = output.propositionAssessments.find(
    (assessment) => assessment.propositionId === critique.targetPropositionId
  );
  output.responses = [{
    id: `h0-${disposition.toLowerCase()}-response`,
    targetArtifactId: critique.artifactId,
    targetIssueId: critique.issueId,
    disposition,
    statement: disposition === 'ACCEPT'
      ? 'The review identifies a real issue and the target assessment is corrected.'
      : 'The review is unsound and the target assessment is retained.',
    factualEvidence: [],
    artifactReferences: [{
      artifactId: critique.artifactId,
      relation: 'RESPONDS_TO',
      note: 'Direct response to the exact visible critique artifact.'
    }],
    changedAssessmentIds: disposition === 'ACCEPT' && targetAssessment
      ? [targetAssessment.id]
      : []
  }];
  output.resolution = {
    status: resolutionStatus,
    basis: disposition === 'ACCEPT' ? 'FACTUAL_EVIDENCE' : 'NO_MATERIAL_ISSUE',
    summary: disposition === 'ACCEPT'
      ? 'The material critique is accepted and resolved.'
      : 'The unsound critique is rejected without creating a disagreement.',
    resolvedIssueIds: [...new Set([
      ...visibleIssueIdsFromLabContextV4(context),
      critique.issueId
    ])],
    unresolvedIssueIds: []
  };
  return output;
}

function requiredMapValue<T>(map: ReadonlyMap<string, T>, id: string, kind: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`H1c H0 lacks ${kind} fixture ${id}.`);
  return value;
}

function assertSchedule(assignments: H1cAssignment[], blockIds: string[]): void {
  if (
    blockIds.length !== 8 ||
    new Set(blockIds).size !== 8 ||
    assignments.length !== 28 ||
    new Set(assignments.map((item) => item.assignmentId)).size !== 28 ||
    new Set(assignments.map((item) => item.caseId)).size !== 4
  ) {
    throw new Error('H1c H0 schedule is not the exact 8-block/28-call matrix.');
  }
  const orderedStrata = blockIds.map(
    (blockId) => assignments.find((item) => item.blockId === blockId)!.stratum
  );
  if (orderedStrata.some((stratum, index) => index > 0 && stratum === orderedStrata[index - 1])) {
    throw new Error('H1c H0 schedule does not interleave its two mechanism strata.');
  }
  for (const caseId of new Set(assignments.map((item) => item.caseId))) {
    const caseAssignments = assignments.filter((item) => item.caseId === caseId);
    if (
      new Set(caseAssignments.map((item) => item.repetition)).size !== 2 ||
      caseAssignments.filter((item) => item.conditionId === 'STRONG_INITIAL').length !== 2
    ) {
      throw new Error(`H1c H0 case is not repeated exactly twice: ${caseId}.`);
    }
  }
  for (const blockId of blockIds) {
    const block = assignments.filter((item) => item.blockId === blockId);
    const derivable = block[0]?.stratum === 'DERIVABLE_CRITIQUE';
    const expectedConditions: H1cConditionId[] = derivable
      ? ['STRONG_INITIAL', 'ACTIVE_SELF_REVIEW', 'VALID_CRITIQUE', 'PLACEBO_CRITIQUE']
      : ['STRONG_INITIAL', 'ACTIVE_SELF_REVIEW', 'DECISIVE_EVIDENCE'];
    if (
      block.length !== expectedConditions.length ||
      block[0]?.conditionId !== 'STRONG_INITIAL' ||
      block[0]?.serialPosition !== 1 ||
      stableJson([...new Set(block.map((item) => item.conditionId))].sort()) !==
        stableJson([...expectedConditions].sort()) ||
      block.some((item, index) => item.serialPosition !== index + 1)
    ) {
      throw new Error(`H1c H0 block is incomplete or unordered: ${blockId}.`);
    }
  }

  assertPositions(assignments, 'H1C-E', 'ACTIVE_SELF_REVIEW', [2, 2, 3, 3]);
  assertPositions(assignments, 'H1C-E', 'DECISIVE_EVIDENCE', [2, 2, 3, 3]);
  for (const conditionId of [
    'ACTIVE_SELF_REVIEW',
    'VALID_CRITIQUE',
    'PLACEBO_CRITIQUE'
  ] as const) {
    const positions = assignments
      .filter((item) => item.caseId.startsWith('H1C-D') && item.conditionId === conditionId)
      .map((item) => item.serialPosition)
      .sort();
    const counts = [2, 3, 4].map(
      (position) => positions.filter((candidate) => candidate === position).length
    );
    if (
      positions.length !== 4 ||
      Math.min(...counts) !== 1 ||
      Math.max(...counts) !== 2
    ) {
      throw new Error(`H1c H0 critique response order is not counterbalanced: ${conditionId}.`);
    }
  }
}

function assertPositions(
  assignments: readonly H1cAssignment[],
  casePrefix: string,
  conditionId: H1cConditionId,
  expected: number[]
): void {
  const actual = assignments
    .filter((item) => item.caseId.startsWith(casePrefix) && item.conditionId === conditionId)
    .map((item) => item.serialPosition)
    .sort();
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`H1c H0 response positions are not counterbalanced: ${conditionId}.`);
  }
}

function assertPromptSerialization(
  prompts: readonly MaterializedH1cH0Prompt[],
  participants: H1cParticipantCorpus
): void {
  const byCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const commonInstructions = new Set<string>();
  for (const item of prompts) {
    const record = byCase.get(item.caseId)!;
    const serializedCase = extractJsonSection(item.prompt, 'CASE:', 'PUBLIC ARTIFACTS:');
    const serializedArtifacts = extractJsonSection(
      item.prompt,
      'PUBLIC ARTIFACTS:',
      'Return only the public JSON object.'
    );
    if (
      stableJson(serializedCase) !== stableJson(record.participantCase) ||
      stableJson(serializedArtifacts) !==
        stableJson(item.context.visibleInterventionArtifacts) ||
      stableJson(item.context.participantCase) !== stableJson(record.participantCase)
    ) {
      throw new Error(`H1c H0 prompt/context serialization diverged for ${item.assignmentId}.`);
    }
    const stageStart = item.prompt.indexOf('STAGE:');
    if (stageStart < 0) throw new Error(`H1c H0 prompt has no stage for ${item.assignmentId}.`);
    commonInstructions.add(item.prompt.slice(0, stageStart));
  }
  if (commonInstructions.size !== 1) {
    throw new Error('H1c H0 common participant instructions differ across conditions.');
  }
}

function assertNeutralCritiqueFraming(
  prompts: readonly MaterializedH1cH0Prompt[],
  participants: H1cParticipantCorpus
): void {
  const forbiddenLabels = [
    'VALID_CRITIQUE',
    'PLACEBO_CRITIQUE',
    'PLACEBO',
    'TREATMENT_ARM',
    'FALSE_OR_IRRELEVANT',
    'VALID_IF_TARGET_DRAFT_WRONG'
  ];
  for (const item of prompts) {
    const leaked = forbiddenLabels.find((label) => item.prompt.toUpperCase().includes(label));
    if (leaked) {
      throw new Error(`H1c H0 non-neutral label ${leaked} appears in ${item.assignmentId}.`);
    }
  }
  for (const record of participants.records.filter(
    (item) => item.stratum === 'DERIVABLE_CRITIQUE'
  )) {
    if (
      !record.validCritique ||
      !record.placeboCritique ||
      record.validCritique.targetPropositionId !== record.placeboCritique.targetPropositionId ||
      record.validCritique.issueKind !== record.placeboCritique.issueKind ||
      record.validCritique.severity !== record.placeboCritique.severity
    ) {
      throw new Error(
        `H1c H0 valid/placebo notes are not matched on target, kind, and severity for ${record.caseId}.`
      );
    }
    for (const repetition of [1, 2] as const) {
      const cell = prompts.filter(
        (item) => item.caseId === record.caseId && item.repetition === repetition
      );
      const valid = cell.find((item) => item.conditionId === 'VALID_CRITIQUE')!;
      const placebo = cell.find((item) => item.conditionId === 'PLACEBO_CRITIQUE')!;
      const validCritique = critiqueFrom(valid);
      const placeboCritique = critiqueFrom(placebo);
      if (
        validCritique.provenance.sourceLabel !== placeboCritique.provenance.sourceLabel ||
        validCritique.provenance.containsNewFacts ||
        placeboCritique.provenance.containsNewFacts ||
        normalizedCritiqueStage(valid.prompt, validCritique) !==
          normalizedCritiqueStage(placebo.prompt, placeboCritique)
      ) {
        throw new Error(`H1c H0 valid/placebo framing differs for ${record.caseId}:r${repetition}.`);
      }
    }
  }
}

function assertTreatmentIsolation(
  prompts: readonly MaterializedH1cH0Prompt[],
  participants: H1cParticipantCorpus
): void {
  const byCase = new Map(participants.records.map((record) => [record.caseId, record]));
  const expectedKinds: Record<H1cConditionId, LabVisibleInterventionArtifactV4['artifactKind'][]> = {
    STRONG_INITIAL: [],
    ACTIVE_SELF_REVIEW: ['POSITION'],
    VALID_CRITIQUE: ['POSITION', 'CRITIQUE'],
    PLACEBO_CRITIQUE: ['POSITION', 'CRITIQUE'],
    DECISIVE_EVIDENCE: ['POSITION', 'FACTUAL_EVIDENCE']
  };
  for (const item of prompts) {
    const record = byCase.get(item.caseId)!;
    if (stableJson(item.visibleArtifactKinds) !== stableJson(expectedKinds[item.conditionId])) {
      throw new Error(`H1c H0 artifact isolation failed for ${item.assignmentId}.`);
    }
    const artifacts = item.context.visibleInterventionArtifacts;
    const draft = artifacts.find((artifact) => artifact.artifactKind === 'POSITION');
    if (item.conditionId === 'STRONG_INITIAL') {
      if (draft) throw new Error(`H1c H0 initial call received a draft: ${item.assignmentId}.`);
    } else if (
      !draft ||
      draft.artifactId !== H1C_DRAFT_ARTIFACT_ID ||
      draft.provenance.containsNewFacts ||
      draft.publicOutput.issues.length === 0
    ) {
      throw new Error(`H1c H0 response call lacks the shared issue-bearing typed draft: ${item.assignmentId}.`);
    }
    if (item.conditionId === 'VALID_CRITIQUE') {
      assertExactCritique(critiqueFrom(item), record.validCritique, item.assignmentId);
    } else if (item.conditionId === 'PLACEBO_CRITIQUE') {
      assertExactCritique(critiqueFrom(item), record.placeboCritique, item.assignmentId);
    } else if (item.conditionId === 'DECISIVE_EVIDENCE') {
      const artifact = artifacts.find(
        (candidate) => candidate.artifactKind === 'FACTUAL_EVIDENCE'
      );
      const evidence = record.decisiveEvidence;
      if (
        !artifact ||
        artifact.artifactKind !== 'FACTUAL_EVIDENCE' ||
        !evidence ||
        artifact.artifactId !== evidence.artifactId ||
        artifact.evidenceId !== evidence.evidenceId ||
        artifact.text !== evidence.statement ||
        artifact.provenance.sourceLabel !== evidence.sourceLabel ||
        !artifact.provenance.containsNewFacts
      ) {
        throw new Error(`H1c H0 evidence treatment is not exact for ${item.assignmentId}.`);
      }
    }
  }

  for (const blockId of new Set(prompts.map((item) => item.blockId))) {
    const drafts = prompts
      .filter((item) => item.blockId === blockId && item.conditionId !== 'STRONG_INITIAL')
      .map((item) => {
        const position = item.context.visibleInterventionArtifacts.find(
          (artifact) => artifact.artifactKind === 'POSITION'
        );
        return position?.artifactKind === 'POSITION'
          ? stableJson(position.publicOutput)
          : undefined;
      });
    if (drafts.length === 0 || new Set(drafts).size !== 1 || drafts[0] === undefined) {
      throw new Error(`H1c H0 response arms do not share one exact draft in ${blockId}.`);
    }
  }

  for (const record of participants.records) {
    const signals = [record.validCritique, record.placeboCritique, record.decisiveEvidence].filter(
      (signal): signal is NonNullable<typeof signal> => Boolean(signal)
    );
    for (const signal of signals) {
      const exposed = prompts.filter((item) => item.prompt.includes(signal.statement));
      if (exposed.length !== 2 || exposed.some((item) => item.caseId !== record.caseId)) {
        throw new Error(`H1c H0 signal leaked outside its two assigned calls: ${signal.artifactId}.`);
      }
    }
  }
}

function assertUserAndDocumentInstructions(
  prompts: readonly MaterializedH1cH0Prompt[],
  participants: H1cParticipantCorpus
): void {
  const userCase = participants.records.find((record) => record.caseId === 'H1C-E5');
  const documentCase = participants.records.find((record) => record.caseId === 'H1C-E6');
  if (
    !userCase?.participantCase.question.includes('blocking USER information request') ||
    !documentCase?.participantCase.question.includes('blocking DOCUMENT information request') ||
    !documentCase.participantCase.question.includes('Do not request it from the user')
  ) {
    throw new Error('H1c H0 USER/DOCUMENT ownership instructions are missing from the cases.');
  }
  for (const record of [userCase, documentCase]) {
    const cases = prompts
      .filter((item) => item.caseId === record.caseId)
      .map((item) => stableJson(extractJsonSection(item.prompt, 'CASE:', 'PUBLIC ARTIFACTS:')));
    if (new Set(cases).size !== 1 || cases[0] !== stableJson(record.participantCase)) {
      throw new Error(`H1c H0 ownership instructions vary by condition for ${record.caseId}.`);
    }
  }
}

function assertThreadTopology(
  prompts: readonly MaterializedH1cH0Prompt[],
  blockIds: readonly string[]
): void {
  for (const blockId of blockIds) {
    const block = prompts.filter((item) => item.blockId === blockId);
    const initial = block.find((item) => item.conditionId === 'STRONG_INITIAL');
    const continuations = block.filter((item) => item.threadMode === 'CONTINUE_INITIAL');
    if (
      !initial ||
      initial.threadMode !== 'FRESH' ||
      initial.continuationFromAssignmentId !== null ||
      continuations.length !== 1 ||
      continuations[0]!.conditionId !== 'ACTIVE_SELF_REVIEW' ||
      continuations[0]!.continuationFromAssignmentId !== initial.assignmentId ||
      block.some(
        (item) =>
          item.conditionId !== 'ACTIVE_SELF_REVIEW' &&
          (item.threadMode !== 'FRESH' || item.continuationFromAssignmentId !== null)
      )
    ) {
      throw new Error(`H1c H0 continuation/fresh topology is invalid for ${blockId}.`);
    }
  }
}

function assertTruthFirewall(
  prompts: readonly MaterializedH1cH0Prompt[],
  oracles: Awaited<ReturnType<typeof loadH1cOracleCorpus>>
): void {
  const forbiddenLabels = [
    'baseProfile',
    'treatmentProfile',
    'targetPropositionIds',
    'guardPropositionIds',
    'issueOracles',
    'oracleRationale',
    'ambiguityAudit',
    'requiredTreatmentEvidenceId',
    'VALID_IF_TARGET_DRAFT_WRONG',
    'FALSE_OR_IRRELEVANT',
    'DERIVABLE_CRITIQUE',
    'NEW_EVIDENCE',
    'STRONG_INITIAL',
    'ACTIVE_SELF_REVIEW',
    'VALID_CRITIQUE',
    'PLACEBO_CRITIQUE',
    'DECISIVE_EVIDENCE'
  ];
  const forbiddenOracleText = oracles.records.flatMap((oracle) => [
    oracle.oracleRationale,
    oracle.ambiguityAudit,
    stableJson(oracle.baseProfile),
    stableJson(oracle.treatmentProfile)
  ]);
  for (const item of prompts) {
    const leaked = [...forbiddenLabels, ...forbiddenOracleText].find(
      (value) => value.length > 0 && item.prompt.includes(value)
    );
    if (leaked) {
      throw new Error(`H1c H0 scorer truth leaked into ${item.assignmentId}: ${leaked}.`);
    }
  }
}

function assertComponentLocks(validation: H1cValidationReport): void {
  const problems: string[] = [];
  if (!validation.valid) problems.push('validationStatus');
  if (validation.sealVersion !== H1C_SEAL_VERSION) problems.push('sealVersion');
  if (validation.preregistrationVersion !== H1C_PREREGISTRATION_VERSION) {
    problems.push('preregistrationVersion');
  }
  if (validation.locks.corpusVersion !== H1C_CORPUS_VERSION) problems.push('corpusVersion');
  if (validation.locks.promptVersion !== H1C_PROMPT_VERSION) problems.push('promptVersion');
  if (validation.locks.outputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION) {
    problems.push('outputSchemaVersion');
  }
  if (validation.locks.scoringVersion !== H1C_SCORING_VERSION) problems.push('scoringVersion');
  if (validation.locks.protocolVersion !== H1C_PROTOCOL_VERSION) problems.push('protocolVersion');
  if (validation.locks.preregistrationVersion !== H1C_PREREGISTRATION_VERSION) {
    problems.push('lockPreregistrationVersion');
  }
  if (validation.locks.labSourceSha256 !== validation.sourceLock.sha256) {
    problems.push('sourceLockDigest');
  }
  if (
    REQUIRED_BOUNDARY_SOURCE_FILES.some(
      (file) => !validation.sourceLock.sourceFiles.includes(file)
    )
  ) {
    problems.push('transitiveBoundarySourceLock');
  }
  const digests = [
    validation.locks.participantCorpusSha256,
    validation.locks.oracleCorpusSha256,
    validation.locks.labSourceSha256,
    validation.locks.preregistrationSha256,
    validation.sourceLock.sha256
  ];
  if (digests.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) problems.push('digestShape');
  const audiences = new Map(
    validation.verifiedFiles.map((entry) => [entry.audience, entry.sha256])
  );
  if (
    validation.verifiedFiles.length !== 3 ||
    audiences.size !== 3 ||
    audiences.get('PARTICIPANT') !== validation.locks.participantCorpusSha256 ||
    audiences.get('SCORER_ONLY') !== validation.locks.oracleCorpusSha256 ||
    audiences.get('HARNESS') !== validation.locks.preregistrationSha256
  ) {
    problems.push('sealedFileLocks');
  }
  if (problems.length > 0) {
    throw new Error(`H1c H0 component lock failed: ${problems.join(', ')}.`);
  }
}

function critiqueFrom(item: MaterializedH1cH0Prompt): Extract<
  LabVisibleInterventionArtifactV4,
  { artifactKind: 'CRITIQUE' }
> {
  const artifact = item.context.visibleInterventionArtifacts.find(
    (candidate) => candidate.artifactKind === 'CRITIQUE'
  );
  if (!artifact || artifact.artifactKind !== 'CRITIQUE') {
    throw new Error(`H1c H0 critique artifact is absent from ${item.assignmentId}.`);
  }
  return artifact;
}

function normalizedCritiqueStage(
  prompt: string,
  critique: Extract<LabVisibleInterventionArtifactV4, { artifactKind: 'CRITIQUE' }>
): string {
  const start = prompt.indexOf('STAGE:');
  const end = prompt.indexOf('\n\nCASE:', start);
  if (start < 0 || end < 0) throw new Error('H1c H0 cannot extract critique-stage framing.');
  return prompt
    .slice(start, end)
    .replaceAll(critique.issueId, '<ISSUE_ID>')
    .replaceAll(critique.artifactId, '<ARTIFACT_ID>');
}

function assertExactCritique(
  artifact: Extract<LabVisibleInterventionArtifactV4, { artifactKind: 'CRITIQUE' }>,
  signal: H1cParticipantRecord['validCritique'] | H1cParticipantRecord['placeboCritique'],
  assignmentId: string
): void {
  if (
    !signal ||
    artifact.artifactId !== signal.artifactId ||
    artifact.issueId !== signal.issueId ||
    artifact.targetArtifactId !== H1C_DRAFT_ARTIFACT_ID ||
    artifact.targetPropositionId !== signal.targetPropositionId ||
    artifact.text !== signal.statement ||
    artifact.provenance.containsNewFacts
  ) {
    throw new Error(`H1c H0 critique treatment is not exact for ${assignmentId}.`);
  }
}

function extractJsonSection(prompt: string, heading: string, nextHeading: string): unknown {
  const prefix = `${heading}\n`;
  const start = prompt.indexOf(prefix);
  const end = prompt.indexOf(`\n\n${nextHeading}`, start + prefix.length);
  if (start < 0 || end < 0) throw new Error(`H1c H0 prompt section is missing: ${heading}.`);
  return JSON.parse(prompt.slice(start + prefix.length, end));
}

function estimatePromptTokens(prompt: string): number {
  return Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`H1c H0 receipt directory is unavailable or unsafe: ${directory}.`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1c H0 receipt file is unavailable or unsafe: ${filePath}.`);
  }
}

async function readRealJson<T>(filePath: string, label: string): Promise<T> {
  await assertRealFile(filePath);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    throw new Error(`H1c H0 ${label} contains invalid JSON.`);
  }
}
