import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LAB_ORACLE_CASE_SCHEMA_VERSION,
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabCasePartition,
  type LabEvaluationKind,
  type LabIssueKind,
  type LabOracleCase,
  type LabOutputStatus,
  type LabParticipantCase
} from './contracts';
import {
  validateLabCasePair,
  validateLabOracleCase,
  validateLabParticipantCase
} from './outputValidation';
import type { LabConditionId } from './protocols';
import type { LabPublicIntervention } from './prompts';

export const LAB_CORPUS_VERSION = 'text-lab-v1' as const;

interface RawParticipantFile {
  schemaVersion: string;
  corpusVersion: string;
  partition: LabCasePartition;
  cases: RawParticipantCase[];
}

interface RawParticipantCase {
  caseId: string;
  partition: LabCasePartition;
  domain: 'OBJECTIVE' | 'SUPPLIED_TEXT' | 'EPISTEMIC_GAP' | 'PLURALISTIC_DECISION';
  prompt: string;
  answerInstructions: string;
  candidateClaims: Array<{ claimId: string; text: string }>;
  evidence: Array<{ evidenceId: string; text: string }>;
  answerOptions: Array<{ optionId: string; text: string }>;
}

interface RawOracleFile {
  schemaVersion: string;
  corpusVersion: string;
  partition: LabCasePartition;
  participantAccess: 'FORBIDDEN';
  oracles: RawOracle[];
}

interface RawOracle {
  caseId: string;
  mechanismTags: string[];
  acceptedFinalStatuses: LabOutputStatus[];
  acceptedAnswerValueSets: string[][];
  acceptedAnswerOptionSets: string[][];
  propositions: Array<{
    claimId: string;
    expectedStance: 'ACCEPT' | 'REJECT' | 'OPEN';
    truthClass: string;
    supportIds: string[];
  }>;
  expectedMaterialIssues: Array<{
    targetClaimId: string;
    kind: string;
    materiality: 'MATERIAL' | 'ADVISORY';
  }>;
  userOwnedCruxes: Array<{ cruxId: string; questionIntent: string }>;
  metricOpportunities: {
    cleanCase: boolean;
    sharedErrorClaimIds: string[];
    disagreementClaimIds: string[];
    abstentionExpected: boolean;
    userQuestionExpected: boolean;
  };
}

interface RawInterventionFile {
  schemaVersion: string;
  corpusVersion: string;
  bundles: RawInterventionBundle[];
}

interface RawInterventionBundle {
  bundleId: string;
  partition: LabCasePartition;
  caseId: string;
  fixedInitial: LabPublicIntervention['fixedInitial'];
  variants: Array<{
    variantId: string;
    signalKind: string;
    artifacts: Array<Record<string, unknown>>;
  }>;
}

interface RawInterventionOracleFile {
  schemaVersion: string;
  corpusVersion: string;
  participantAccess: 'FORBIDDEN';
  variants: Array<{
    variantId: string;
    treatment:
      | 'NO_FEEDBACK'
      | 'VALID_CRITIQUE'
      | 'VALID_EVIDENCE'
      | 'INVALID_CRITIQUE'
      | 'CONFIDENT_WRONG_PEER'
      | 'CORRECT_MINORITY_AGAINST_WRONG_MAJORITY';
    truthBearing: boolean;
    targetClaimIds: string[];
    expectedTransition: string;
  }>;
}

export interface LabControlledAssignment {
  assignmentId: string;
  partition: LabCasePartition;
  caseId: string;
  bundleId: string;
  variantId: string;
  conditionId: LabConditionId;
}

export type LabControlledTreatment =
  RawInterventionOracleFile['variants'][number]['treatment'];

/** Scorer-only treatment metadata. Load only after the participant phase closes. */
export interface LabControlledAssignmentOracle {
  assignmentId: string;
  treatment: LabControlledTreatment;
  truthBearing: boolean;
  targetClaimIds: string[];
  expectedTransition: string;
}

export interface LabParticipantCorpus {
  corpusVersion: typeof LAB_CORPUS_VERSION;
  partition: LabCasePartition;
  cases: LabParticipantCase[];
}

/** This loader has no scorer path or oracle return type by design. */
export async function loadLabParticipantCorpus(
  fixtureRoot: string,
  partition: LabCasePartition
): Promise<LabParticipantCorpus> {
  const filePath = path.join(
    fixtureRoot,
    'corpus',
    'v1',
    'participants',
    partition === 'DEVELOPMENT' ? 'development.json' : 'confirmation.json'
  );
  assertParticipantPath(filePath);
  const raw = await readJson<RawParticipantFile>(filePath);
  if (
    raw.schemaVersion !== 'discourse-text-corpus-participants@1' ||
    raw.corpusVersion !== LAB_CORPUS_VERSION ||
    raw.partition !== partition ||
    !Array.isArray(raw.cases)
  ) {
    throw new Error(`Invalid participant corpus header: ${filePath}`);
  }
  const cases = raw.cases.map(toParticipantCase);
  const ids = new Set(cases.map((item) => item.caseId));
  if (cases.length !== 16 || ids.size !== cases.length) {
    throw new Error(`${partition} participant corpus must contain 16 unique cases.`);
  }
  cases.forEach((item) => {
    const validation = validateLabParticipantCase(item);
    if (!validation.ok) {
      throw new Error(
        `Invalid participant case ${item.caseId}: ${validation.errors.map((error) => error.message).join(' ')}`
      );
    }
  });
  return { corpusVersion: LAB_CORPUS_VERSION, partition, cases };
}

/** Loads only the public intervention text selected by a sealed assignment. */
export async function loadLabPublicIntervention(
  fixtureRoot: string,
  assignment: LabControlledAssignment
): Promise<LabPublicIntervention> {
  const filePath = path.join(fixtureRoot, 'corpus', 'v1', 'interventions', 'controlled-feedback.json');
  assertParticipantPath(filePath);
  const raw = await readJson<RawInterventionFile>(filePath);
  if (
    raw.schemaVersion !== 'discourse-text-interventions@1' ||
    raw.corpusVersion !== LAB_CORPUS_VERSION
  ) {
    throw new Error('Invalid public intervention fixture header.');
  }
  const bundle = raw.bundles.find(
    (candidate) =>
      candidate.bundleId === assignment.bundleId &&
      candidate.partition === assignment.partition &&
      candidate.caseId === assignment.caseId
  );
  const variant = bundle?.variants.find((candidate) => candidate.variantId === assignment.variantId);
  if (!bundle || !variant) {
    throw new Error(`Public intervention assignment is unavailable: ${assignment.assignmentId}`);
  }
  return {
    bundleId: bundle.bundleId,
    variantId: variant.variantId,
    fixedInitial: structuredClone(bundle.fixedInitial),
    signalKind: variant.signalKind,
    artifacts: structuredClone(variant.artifacts)
  };
}

/** Scoring is a separate post-call phase; never pass this return value to a prompt builder. */
export async function loadLabOracleCorpus(
  fixtureRoot: string,
  participantCorpus: LabParticipantCorpus
): Promise<LabOracleCase[]> {
  const partition = participantCorpus.partition;
  const filePath = path.join(
    fixtureRoot,
    'corpus',
    'v1',
    'scorer-only',
    partition === 'DEVELOPMENT' ? 'development-oracles.json' : 'confirmation-oracles.json'
  );
  const raw = await readJson<RawOracleFile>(filePath);
  if (
    raw.schemaVersion !== 'discourse-text-corpus-oracles@1' ||
    raw.corpusVersion !== LAB_CORPUS_VERSION ||
    raw.partition !== partition ||
    raw.participantAccess !== 'FORBIDDEN'
  ) {
    throw new Error(`Invalid scorer-only corpus header: ${filePath}`);
  }
  const participants = new Map(participantCorpus.cases.map((item) => [item.caseId, item]));
  const rawCases = new Map(raw.oracles.map((item) => [item.caseId, item]));
  if (participants.size !== 16 || rawCases.size !== participants.size) {
    throw new Error(`${partition} oracle corpus must exactly cover the 16 participant cases.`);
  }
  const oracles = participantCorpus.cases.map((participant) => {
    const rawOracle = rawCases.get(participant.caseId);
    if (!rawOracle) throw new Error(`Missing oracle for ${participant.caseId}.`);
    const oracle = toOracleCase(partition, participant, rawOracle);
    const validation = validateLabOracleCase(oracle);
    if (!validation.ok) {
      throw new Error(
        `Invalid oracle ${oracle.caseId}: ${validation.errors.map((error) => error.message).join(' ')}`
      );
    }
    const pairErrors = validateLabCasePair(participant, oracle);
    if (pairErrors.length > 0) {
      throw new Error(
        `Invalid case pair ${oracle.caseId}: ${pairErrors.map((error) => error.message).join(' ')}`
      );
    }
    return oracle;
  });
  return oracles;
}

/** Allocation-only scorer access. Persist the returned assignments before participant calls. */
export async function planControlledAssignments(
  fixtureRoot: string,
  partition: LabCasePartition
): Promise<LabControlledAssignment[]> {
  const [interventions, interventionOracles] = await Promise.all([
    readJson<RawInterventionFile>(
      path.join(fixtureRoot, 'corpus', 'v1', 'interventions', 'controlled-feedback.json')
    ),
    readJson<RawInterventionOracleFile>(
      path.join(fixtureRoot, 'corpus', 'v1', 'scorer-only', 'intervention-oracles.json')
    )
  ]);
  if (
    interventions.corpusVersion !== LAB_CORPUS_VERSION ||
    interventionOracles.corpusVersion !== LAB_CORPUS_VERSION ||
    interventionOracles.participantAccess !== 'FORBIDDEN'
  ) {
    throw new Error('Invalid controlled-intervention allocation fixtures.');
  }
  const treatmentByVariant = new Map(
    interventionOracles.variants.map((item) => [item.variantId, item.treatment])
  );
  const assignments: LabControlledAssignment[] = [];
  for (const bundle of interventions.bundles.filter((item) => item.partition === partition)) {
    for (const variant of bundle.variants) {
      const treatment = treatmentByVariant.get(variant.variantId);
      if (!treatment) throw new Error(`Missing treatment allocation for ${variant.variantId}.`);
      assignments.push({
        assignmentId: `${bundle.bundleId}:${variant.variantId}`,
        partition,
        caseId: bundle.caseId,
        bundleId: bundle.bundleId,
        variantId: variant.variantId,
        conditionId: conditionForTreatment(treatment)
      });
    }
  }
  return assignments.sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
}

/**
 * Resolves scorer-only intervention truth for already-sealed assignments. This
 * deliberately has a separate API from the public intervention loader so the
 * participant phase cannot accidentally receive treatment validity or target
 * labels.
 */
export async function loadLabControlledAssignmentOracles(
  fixtureRoot: string,
  assignments: readonly LabControlledAssignment[]
): Promise<LabControlledAssignmentOracle[]> {
  const filePath = path.join(
    fixtureRoot,
    'corpus',
    'v1',
    'scorer-only',
    'intervention-oracles.json'
  );
  const raw = await readJson<RawInterventionOracleFile>(filePath);
  if (
    raw.schemaVersion !== 'discourse-text-intervention-oracles@1' ||
    raw.corpusVersion !== LAB_CORPUS_VERSION ||
    raw.participantAccess !== 'FORBIDDEN'
  ) {
    throw new Error(`Invalid scorer-only intervention fixture header: ${filePath}`);
  }
  const byVariant = new Map(raw.variants.map((item) => [item.variantId, item]));
  if (byVariant.size !== raw.variants.length) {
    throw new Error('Scorer-only intervention fixture contains duplicate variant ids.');
  }
  return assignments.map((assignment) => {
    const oracle = byVariant.get(assignment.variantId);
    if (!oracle) {
      throw new Error(`Missing scorer-only intervention metadata for ${assignment.assignmentId}.`);
    }
    if (conditionForTreatment(oracle.treatment) !== assignment.conditionId) {
      throw new Error(`Treatment allocation changed after sealing: ${assignment.assignmentId}.`);
    }
    return {
      assignmentId: assignment.assignmentId,
      treatment: oracle.treatment,
      truthBearing: oracle.truthBearing,
      targetClaimIds: [...oracle.targetClaimIds],
      expectedTransition: oracle.expectedTransition
    };
  });
}

export function participantFixturePaths(
  fixtureRoot: string,
  partition: LabCasePartition
): string[] {
  return [
    path.join(
      fixtureRoot,
      'corpus',
      'v1',
      'participants',
      partition === 'DEVELOPMENT' ? 'development.json' : 'confirmation.json'
    ),
    path.join(fixtureRoot, 'corpus', 'v1', 'interventions', 'controlled-feedback.json')
  ];
}

function toParticipantCase(raw: RawParticipantCase): LabParticipantCase {
  const topicId = 'case';
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: raw.caseId,
    question: `${raw.prompt}\n\nRequested answer: ${raw.answerInstructions}`,
    evidence: [
      { id: 'PROMPT', text: 'Facts and wording stated in the public question.' },
      ...raw.evidence.map((item) => ({ id: item.evidenceId, text: item.text }))
    ],
    propositions: raw.candidateClaims.map((item) => ({
      id: item.claimId,
      topicId,
      text: item.text
    })),
    options: raw.answerOptions.map((item) => ({ id: item.optionId, text: item.text })),
    topics: [{ id: topicId, label: raw.domain.toLowerCase().replaceAll('_', ' ') }]
  };
}

function toOracleCase(
  partition: LabCasePartition,
  participant: LabParticipantCase,
  raw: RawOracle
): LabOracleCase {
  const domain = participant.topics[0]?.label ?? 'unknown';
  return {
    schemaVersion: LAB_ORACLE_CASE_SCHEMA_VERSION,
    caseId: raw.caseId,
    partition,
    domain,
    evaluationKind: evaluationKind(domain),
    mechanismTags: [...raw.mechanismTags],
    acceptableStatuses: [...raw.acceptedFinalStatuses],
    acceptedAnswerOptionSets: structuredClone(raw.acceptedAnswerOptionSets),
    acceptedAnswerValueSets: structuredClone(raw.acceptedAnswerValueSets),
    propositionExpectations: raw.propositions.map((item) => ({
      propositionId: item.claimId,
      acceptableStances: [item.expectedStance],
      requiredEvidenceSets: item.supportIds.length > 0 ? [item.supportIds] : []
    })),
    validCritiques: raw.expectedMaterialIssues.map((item) => ({
      targetPropositionId: item.targetClaimId,
      kinds: [mapIssueKind(item.kind)],
      severities: [item.materiality]
    })),
    sharedErrorPropositionIds: [...raw.metricOpportunities.sharedErrorClaimIds],
    disagreementRequirements:
      raw.metricOpportunities.disagreementClaimIds.length === 0
        ? []
        : [{
            propositionIds: [...raw.metricOpportunities.disagreementClaimIds],
            acceptableStatuses: [
              'UNRESOLVED',
              'COMPATIBLE_DIFFERENCE',
              'NEEDS_USER_INPUT'
            ],
            ...(raw.userOwnedCruxes[0] ? { requiredCruxId: raw.userOwnedCruxes[0].cruxId } : {})
          }],
    requiredUserQuestionCruxIds: raw.metricOpportunities.userQuestionExpected
      ? raw.userOwnedCruxes.map((item) => item.cruxId)
      : []
  };
}

function evaluationKind(domain: string): LabEvaluationKind {
  if (domain === 'pluralistic decision') return 'PLURALISTIC';
  if (domain === 'epistemic gap') return 'MISSING_INFORMATION';
  return 'OBJECTIVE';
}

function mapIssueKind(value: string): LabIssueKind {
  if (/AMBIG|REFERENT|SCOPE/iu.test(value)) return 'AMBIGUITY';
  if (/MISSING|UNSTATED|PERSPECTIVE|PRIORITY|VALUE|TRADEOFF/iu.test(value)) {
    return /TRADEOFF|VALUE|PRIORITY/iu.test(value) ? 'TRADEOFF' : 'MISSING_INFORMATION';
  }
  if (/EVIDENCE|SOURCE|CAUSAL|ATTRITION|STALE/iu.test(value)) return 'EVIDENCE';
  if (/ASSUM|CONSEQUENT|LOGIC|CONSTRAINT/iu.test(value)) return 'LOGIC';
  return 'FACTUAL';
}

function conditionForTreatment(
  treatment: RawInterventionOracleFile['variants'][number]['treatment']
): LabConditionId {
  switch (treatment) {
    case 'NO_FEEDBACK':
      return 'CONTROL_NO_FEEDBACK_B1';
    case 'VALID_CRITIQUE':
      return 'CONTROL_VALID_CRITIQUE_B1';
    case 'VALID_EVIDENCE':
      return 'CONTROL_EVIDENCE_B1';
    case 'INVALID_CRITIQUE':
      return 'CONTROL_INVALID_CRITIQUE_B1';
    case 'CONFIDENT_WRONG_PEER':
      return 'CONTROL_CONFIDENT_WRONG_B1';
    case 'CORRECT_MINORITY_AGAINST_WRONG_MAJORITY':
      return 'CONTROL_CORRECT_MINORITY_B1';
  }
}

function assertParticipantPath(filePath: string): void {
  if (filePath.split(path.sep).includes('scorer-only')) {
    throw new Error('Participant loading cannot access scorer-only fixtures.');
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Discourse Lab fixture must be a real file: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}
