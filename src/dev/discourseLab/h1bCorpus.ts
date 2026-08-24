import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type LabClaimStance,
  type LabIssueKind,
  type LabIssueSeverity,
  type LabOutputStatus,
  type LabParticipantCase
} from './contracts';
import { validateLabParticipantCase } from './outputValidation';
import type { LabConditionId } from './protocols';
import type { LabPublicIntervention } from './prompts';

export const H1B_CORPUS_VERSION = 'h1b-text-corpus-v1' as const;

const H1B_PARTICIPANT_FILE_SCHEMA = 'discourse-h1b-participants@1' as const;
const H1B_ORACLE_FILE_SCHEMA = 'discourse-h1b-oracles@1' as const;
const H1B_CASE_IDS = ['H1B-D1', 'H1B-D2', 'H1B-D3', 'H1B-G1', 'H1B-G2', 'H1B-G3'] as const;

export type H1bStratum = 'DERIVABLE_CRITIQUE' | 'NEW_EVIDENCE';

export type H1bConditionId =
  | 'CONTROL_CASE_ONLY_B1'
  | Extract<
      LabConditionId,
      'CONTROL_NO_FEEDBACK_B1' | 'CONTROL_VALID_CRITIQUE_B1' | 'CONTROL_EVIDENCE_B1'
    >;

export interface H1bFixedInitial {
  artifactId: string;
  answer: string;
  values: string[];
  selectedOptionIds: string[];
  status: LabOutputStatus;
  assessments: Array<{ claimId: string; stance: LabClaimStance }>;
}

export interface H1bPublicSignal {
  signalKind: 'PEER_MESSAGE' | 'EVIDENCE_PACKET';
  artifacts: Array<{
    artifactId: string;
    text: string;
    sourceLabel?: string;
    issueId?: string;
    targetPropositionId?: string;
    kind?: LabIssueKind;
    severity?: LabIssueSeverity;
    evidenceId?: string;
    provenance?: Record<string, unknown>;
  }>;
}

export interface H1bParticipantCaseRecord {
  caseId: string;
  stratum: H1bStratum;
  participantCase: LabParticipantCase;
  fixedInitial: H1bFixedInitial;
  signal: H1bPublicSignal;
}

export interface H1bParticipantCorpus {
  corpusVersion: typeof H1B_CORPUS_VERSION;
  partition: 'DEVELOPMENT';
  records: H1bParticipantCaseRecord[];
}

export interface H1bOraclePropositionExpectation {
  propositionId: string;
  acceptableStances: LabClaimStance[];
  requiredEvidenceSets: string[][];
}

export interface H1bOracleProfile {
  profile: 'BASE' | 'TREATMENT';
  conditionIds: H1bConditionId[];
  acceptableStatuses: LabOutputStatus[];
  acceptedAnswerValueSets: string[][];
  acceptedAnswerOptionSets: string[][];
  propositions: H1bOraclePropositionExpectation[];
  requiredUserQuestionCruxIds: string[];
}

export interface H1bAcceptedIssueKindEquivalence {
  targetPropositionId: string;
  acceptedKinds: LabIssueKind[];
  acceptedSeverities: LabIssueSeverity[];
}

export interface H1bOracleCase {
  caseId: string;
  stratum: H1bStratum;
  fixedInitialExpectation: 'WRONG' | 'APPROPRIATELY_OPEN';
  targetPropositionIds: string[];
  guardPropositionIds: string[];
  baseProfile: H1bOracleProfile;
  treatmentProfile: H1bOracleProfile;
  acceptedIssueKindEquivalences: H1bAcceptedIssueKindEquivalence[];
  derivationNotes: string[];
  auditNotes: string[];
}

interface H1bParticipantFile {
  schemaVersion: typeof H1B_PARTICIPANT_FILE_SCHEMA;
  corpusVersion: typeof H1B_CORPUS_VERSION;
  partition: 'DEVELOPMENT';
  records: H1bParticipantCaseRecord[];
}

interface H1bOracleFile {
  schemaVersion: typeof H1B_ORACLE_FILE_SCHEMA;
  corpusVersion: typeof H1B_CORPUS_VERSION;
  partition: 'DEVELOPMENT';
  participantAccess: 'FORBIDDEN';
  cases: H1bOracleCase[];
}

const OUTPUT_STATUSES: readonly LabOutputStatus[] = [
  'ANSWER',
  'UNCERTAIN',
  'ABSTAIN',
  'NEEDS_USER_INPUT',
  'MULTIPLE_DEFENSIBLE'
];
const CLAIM_STANCES: readonly LabClaimStance[] = [
  'ACCEPT',
  'REJECT',
  'OPEN',
  'NOT_APPLICABLE'
];
const ISSUE_KINDS: readonly LabIssueKind[] = [
  'FACTUAL',
  'EVIDENCE',
  'ASSUMPTION',
  'LOGIC',
  'AMBIGUITY',
  'MISSING_INFORMATION',
  'TRADEOFF',
  'OTHER'
];
const ISSUE_SEVERITIES: readonly LabIssueSeverity[] = ['MATERIAL', 'ADVISORY'];
const BASE_CONDITIONS: readonly H1bConditionId[] = [
  'CONTROL_CASE_ONLY_B1',
  'CONTROL_NO_FEEDBACK_B1'
];
const PARTICIPANT_FORBIDDEN_KEYS = new Set([
  'acceptedIssueKindEquivalences',
  'auditNotes',
  'baseProfile',
  'derivationNotes',
  'fixedInitialExpectation',
  'participantAccess',
  'treatmentProfile'
]);

/** Loads only development stimuli. It has no scorer path or oracle return type. */
export async function loadH1bParticipantCorpus(
  fixtureRoot: string
): Promise<H1bParticipantCorpus> {
  const filePath = h1bParticipantFixturePaths(fixtureRoot)[0]!;
  assertParticipantPath(filePath);
  const raw = await readJson<unknown>(filePath);
  assertNoOracleKeys(raw, '$');
  if (!isRecord(raw)) throw new Error(`Invalid H1b participant corpus: ${filePath}`);
  if (
    raw.schemaVersion !== H1B_PARTICIPANT_FILE_SCHEMA ||
    raw.corpusVersion !== H1B_CORPUS_VERSION ||
    raw.partition !== 'DEVELOPMENT' ||
    !Array.isArray(raw.records)
  ) {
    throw new Error(`Invalid H1b participant corpus header: ${filePath}`);
  }

  const records = raw.records.map((value, index) =>
    validateParticipantRecord(value, `records[${index}]`)
  );
  assertExactCaseSet(records.map((record) => record.caseId), 'participant');
  assertStratumBalance(records);
  return {
    corpusVersion: H1B_CORPUS_VERSION,
    partition: 'DEVELOPMENT',
    records: structuredClone(records)
  };
}

/** Scorer-only truth is resolved only after a participant corpus has been loaded. */
export async function loadH1bOracleCorpus(
  fixtureRoot: string,
  participant: H1bParticipantCorpus
): Promise<H1bOracleCase[]> {
  const filePath = h1bScorerFixturePaths(fixtureRoot)[0]!;
  const raw = await readJson<unknown>(filePath);
  if (!isRecord(raw)) throw new Error(`Invalid H1b oracle corpus: ${filePath}`);
  if (
    raw.schemaVersion !== H1B_ORACLE_FILE_SCHEMA ||
    raw.corpusVersion !== H1B_CORPUS_VERSION ||
    raw.partition !== 'DEVELOPMENT' ||
    raw.participantAccess !== 'FORBIDDEN' ||
    !Array.isArray(raw.cases)
  ) {
    throw new Error(`Invalid H1b scorer-only corpus header: ${filePath}`);
  }
  if (participant.corpusVersion !== H1B_CORPUS_VERSION || participant.partition !== 'DEVELOPMENT') {
    throw new Error('H1b oracle loading requires the matching development participant corpus.');
  }

  const participants = new Map(participant.records.map((record) => [record.caseId, record]));
  assertExactCaseSet([...participants.keys()], 'participant input');
  const cases = raw.cases.map((value, index) => {
    if (!isRecord(value) || typeof value.caseId !== 'string') {
      throw new Error(`Invalid H1b oracle at cases[${index}].`);
    }
    const publicRecord = participants.get(value.caseId);
    if (!publicRecord) throw new Error(`Missing H1b participant case for oracle ${value.caseId}.`);
    return validateOracleCase(value, publicRecord, `cases[${index}]`);
  });
  assertExactCaseSet(cases.map((item) => item.caseId), 'oracle');
  return structuredClone(cases);
}

/**
 * Projects one public stimulus. Case-only and stratum-inapplicable treatments
 * deliberately return null so no fixed answer or wrong signal can leak in.
 */
export function h1bPublicIntervention(
  record: H1bParticipantCaseRecord,
  conditionId: H1bConditionId
): LabPublicIntervention | null {
  if (conditionId === 'CONTROL_CASE_ONLY_B1') return null;
  if (conditionId === 'CONTROL_NO_FEEDBACK_B1') {
    return {
      bundleId: `${record.caseId}-B0`,
      variantId: `${record.caseId}-V0`,
      fixedInitial: structuredClone(record.fixedInitial),
      signalKind: 'NONE',
      artifacts: []
    };
  }
  const applicableTreatment = treatmentCondition(record.stratum);
  if (conditionId !== applicableTreatment) return null;
  return {
    bundleId: `${record.caseId}-B0`,
    variantId: `${record.caseId}-V1`,
    fixedInitial: structuredClone(record.fixedInitial),
    signalKind: record.signal.signalKind,
    artifacts: structuredClone(record.signal.artifacts) as Array<Record<string, unknown>>
  };
}

export function h1bParticipantFixturePaths(fixtureRoot: string): string[] {
  return [path.join(fixtureRoot, 'corpus', 'h1b-v1', 'participants', 'development.json')];
}

export function h1bScorerFixturePaths(fixtureRoot: string): string[] {
  return [
    path.join(fixtureRoot, 'corpus', 'h1b-v1', 'scorer-only', 'development-oracles.json')
  ];
}

function validateParticipantRecord(value: unknown, location: string): H1bParticipantCaseRecord {
  if (!isRecord(value)) throw new Error(`Invalid H1b participant ${location}.`);
  if (
    typeof value.caseId !== 'string' ||
    (value.stratum !== 'DERIVABLE_CRITIQUE' && value.stratum !== 'NEW_EVIDENCE')
  ) {
    throw new Error(`Invalid H1b participant identity at ${location}.`);
  }
  const caseValidation = validateLabParticipantCase(value.participantCase);
  if (!caseValidation.ok) {
    throw new Error(
      `Invalid H1b public case ${value.caseId}: ${caseValidation.errors.map((error) => error.message).join(' ')}`
    );
  }
  if (caseValidation.value.caseId !== value.caseId) {
    throw new Error(`H1b participant case id mismatch at ${location}.`);
  }
  const propositionIds = new Set(caseValidation.value.propositions.map((item) => item.id));
  const optionIds = new Set(caseValidation.value.options.map((item) => item.id));
  const fixedInitial = validateFixedInitial(value.fixedInitial, propositionIds, optionIds, location);
  const signal = validateSignal(value.signal, value.stratum, propositionIds, location);
  return {
    caseId: value.caseId,
    stratum: value.stratum,
    participantCase: structuredClone(caseValidation.value),
    fixedInitial,
    signal
  };
}

function validateFixedInitial(
  value: unknown,
  propositionIds: Set<string>,
  optionIds: Set<string>,
  location: string
): H1bFixedInitial {
  if (
    !isRecord(value) ||
    typeof value.artifactId !== 'string' ||
    typeof value.answer !== 'string' ||
    !isStringArray(value.values) ||
    !isStringArray(value.selectedOptionIds) ||
    !value.selectedOptionIds.every((optionId) => optionIds.has(optionId)) ||
    !OUTPUT_STATUSES.includes(value.status as LabOutputStatus) ||
    !Array.isArray(value.assessments)
  ) {
    throw new Error(`Invalid H1b fixed initial at ${location}.`);
  }
  const assessments = value.assessments.map((assessment, index) => {
    if (
      !isRecord(assessment) ||
      typeof assessment.claimId !== 'string' ||
      !propositionIds.has(assessment.claimId) ||
      !CLAIM_STANCES.includes(assessment.stance as LabClaimStance)
    ) {
      throw new Error(`Invalid H1b fixed assessment at ${location}[${index}].`);
    }
    return { claimId: assessment.claimId, stance: assessment.stance as LabClaimStance };
  });
  if (
    assessments.length !== propositionIds.size ||
    new Set(assessments.map((item) => item.claimId)).size !== propositionIds.size
  ) {
    throw new Error(`H1b fixed initial must assess every proposition exactly once at ${location}.`);
  }
  return {
    artifactId: value.artifactId,
    answer: value.answer,
    values: [...value.values],
    selectedOptionIds: [...value.selectedOptionIds],
    status: value.status as LabOutputStatus,
    assessments
  };
}

function validateSignal(
  value: unknown,
  stratum: H1bStratum,
  propositionIds: Set<string>,
  location: string
): H1bPublicSignal {
  const expectedKind = stratum === 'DERIVABLE_CRITIQUE' ? 'PEER_MESSAGE' : 'EVIDENCE_PACKET';
  if (!isRecord(value) || value.signalKind !== expectedKind || !Array.isArray(value.artifacts)) {
    throw new Error(`Invalid H1b ${stratum} signal at ${location}.`);
  }
  const artifacts = value.artifacts.map((artifact, index) => {
    if (
      !isRecord(artifact) ||
      typeof artifact.artifactId !== 'string' ||
      typeof artifact.text !== 'string' ||
      (artifact.sourceLabel !== undefined && typeof artifact.sourceLabel !== 'string') ||
      (artifact.issueId !== undefined && typeof artifact.issueId !== 'string') ||
      (artifact.targetPropositionId !== undefined &&
        (typeof artifact.targetPropositionId !== 'string' ||
          !propositionIds.has(artifact.targetPropositionId))) ||
      (artifact.kind !== undefined && !ISSUE_KINDS.includes(artifact.kind as LabIssueKind)) ||
      (artifact.severity !== undefined &&
        !ISSUE_SEVERITIES.includes(artifact.severity as LabIssueSeverity)) ||
      (artifact.evidenceId !== undefined && typeof artifact.evidenceId !== 'string') ||
      (artifact.provenance !== undefined && !isRecord(artifact.provenance))
    ) {
      throw new Error(`Invalid H1b signal artifact at ${location}[${index}].`);
    }
    return {
      artifactId: artifact.artifactId,
      text: artifact.text,
      ...(typeof artifact.sourceLabel === 'string' ? { sourceLabel: artifact.sourceLabel } : {}),
      ...(typeof artifact.issueId === 'string' ? { issueId: artifact.issueId } : {}),
      ...(typeof artifact.targetPropositionId === 'string'
        ? { targetPropositionId: artifact.targetPropositionId }
        : {}),
      ...(typeof artifact.kind === 'string' ? { kind: artifact.kind as LabIssueKind } : {}),
      ...(typeof artifact.severity === 'string'
        ? { severity: artifact.severity as LabIssueSeverity }
        : {}),
      ...(typeof artifact.evidenceId === 'string' ? { evidenceId: artifact.evidenceId } : {}),
      ...(isRecord(artifact.provenance) ? { provenance: structuredClone(artifact.provenance) } : {})
    };
  });
  if (artifacts.length !== 1 || new Set(artifacts.map((item) => item.artifactId)).size !== 1) {
    throw new Error(`H1b cases require exactly one uniquely identified signal at ${location}.`);
  }
  const artifact = artifacts[0]!;
  if (
    stratum === 'DERIVABLE_CRITIQUE' &&
    (!artifact.issueId || !artifact.targetPropositionId || !artifact.kind || !artifact.severity)
  ) {
    throw new Error(`H1b derivable critique requires an exact structured issue target at ${location}.`);
  }
  if (
    stratum === 'NEW_EVIDENCE' &&
    (!artifact.evidenceId || artifact.evidenceId !== artifact.artifactId)
  ) {
    throw new Error(`H1b evidence signal requires an exact evidence id at ${location}.`);
  }
  return { signalKind: expectedKind, artifacts };
}

function validateOracleCase(
  value: Record<string, unknown>,
  participant: H1bParticipantCaseRecord,
  location: string
): H1bOracleCase {
  if (
    value.caseId !== participant.caseId ||
    value.stratum !== participant.stratum ||
    (value.fixedInitialExpectation !== 'WRONG' &&
    value.fixedInitialExpectation !== 'APPROPRIATELY_OPEN') ||
    !isStringArray(value.targetPropositionIds) ||
    !isStringArray(value.guardPropositionIds) ||
    !Array.isArray(value.acceptedIssueKindEquivalences) ||
    !isStringArray(value.derivationNotes) ||
    !isStringArray(value.auditNotes)
  ) {
    throw new Error(`Invalid H1b oracle identity at ${location}.`);
  }
  const expectedInitial = participant.stratum === 'DERIVABLE_CRITIQUE'
    ? 'WRONG'
    : 'APPROPRIATELY_OPEN';
  if (value.fixedInitialExpectation !== expectedInitial) {
    throw new Error(`H1b fixed-initial expectation does not match ${participant.stratum}.`);
  }

  const propositionIds = new Set(participant.participantCase.propositions.map((item) => item.id));
  const targetPropositionIds = [...value.targetPropositionIds];
  const guardPropositionIds = [...value.guardPropositionIds];
  if (
    targetPropositionIds.length === 0 ||
    !sameStringSet([...targetPropositionIds, ...guardPropositionIds], [...propositionIds]) ||
    new Set([...targetPropositionIds, ...guardPropositionIds]).size !== propositionIds.size ||
    targetPropositionIds.some((id) => guardPropositionIds.includes(id))
  ) {
    throw new Error(`H1b target and guard propositions must exactly partition ${participant.caseId}.`);
  }
  const optionIds = new Set(participant.participantCase.options.map((item) => item.id));
  const publicEvidenceIds = new Set(participant.participantCase.evidence.map((item) => item.id));
  const signalEvidenceIds = new Set(participant.signal.artifacts.map((item) => item.artifactId));
  const baseProfile = validateProfile(
    value.baseProfile,
    'BASE',
    BASE_CONDITIONS,
    propositionIds,
    optionIds,
    publicEvidenceIds,
    location
  );
  const treatmentProfile = validateProfile(
    value.treatmentProfile,
    'TREATMENT',
    [treatmentCondition(participant.stratum)],
    propositionIds,
    optionIds,
    new Set([...publicEvidenceIds, ...signalEvidenceIds]),
    location
  );
  for (const signalId of signalEvidenceIds) {
    if (profileEvidenceIds(baseProfile).has(signalId)) {
      throw new Error(`H1b base profile cannot depend on treatment signal ${signalId}.`);
    }
  }
  if (
    participant.stratum === 'NEW_EVIDENCE' &&
    ![...signalEvidenceIds].every((evidenceId) => profileEvidenceIds(treatmentProfile).has(evidenceId))
  ) {
    throw new Error(`H1b evidence treatment must require its exact signal evidence at ${location}.`);
  }
  if (
    participant.stratum === 'DERIVABLE_CRITIQUE' &&
    [...signalEvidenceIds].some((evidenceId) => profileEvidenceIds(treatmentProfile).has(evidenceId))
  ) {
    throw new Error(`H1b derivable critique cannot become new truth evidence at ${location}.`);
  }

  const acceptedIssueKindEquivalences = value.acceptedIssueKindEquivalences.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.targetPropositionId !== 'string' ||
      !propositionIds.has(item.targetPropositionId) ||
      !Array.isArray(item.acceptedKinds) ||
      item.acceptedKinds.length === 0 ||
      !item.acceptedKinds.every((kind) => ISSUE_KINDS.includes(kind as LabIssueKind)) ||
      !Array.isArray(item.acceptedSeverities) ||
      item.acceptedSeverities.length === 0 ||
      !item.acceptedSeverities.every((severity) =>
        ISSUE_SEVERITIES.includes(severity as LabIssueSeverity)
      )
    ) {
      throw new Error(`Invalid H1b issue-kind equivalence at ${location}[${index}].`);
    }
    return {
      targetPropositionId: item.targetPropositionId,
      acceptedKinds: [...item.acceptedKinds] as LabIssueKind[],
      acceptedSeverities: [...item.acceptedSeverities] as LabIssueSeverity[]
    };
  });
  if (acceptedIssueKindEquivalences.length === 0) {
    throw new Error(`H1b oracle must declare accepted issue-kind equivalences at ${location}.`);
  }

  const baseByProposition = new Map(
    baseProfile.propositions.map((expectation) => [expectation.propositionId, expectation])
  );
  const initialByProposition = new Map(
    participant.fixedInitial.assessments.map((assessment) => [assessment.claimId, assessment.stance])
  );
  const guardsPreserved = guardPropositionIds.every((propositionId) =>
    baseByProposition.get(propositionId)?.acceptableStances.includes(
      initialByProposition.get(propositionId)!
    )
  );
  if (!guardsPreserved) {
    throw new Error(`H1b fixed initial must preserve every guard proposition at ${location}.`);
  }
  const wrongTargetCount = targetPropositionIds.filter(
    (propositionId) =>
      !baseByProposition.get(propositionId)?.acceptableStances.includes(
        initialByProposition.get(propositionId)!
      )
  ).length;
  if (value.fixedInitialExpectation === 'WRONG' && wrongTargetCount === 0) {
    throw new Error(`H1b derivable fixed initial must be wrong on a target at ${location}.`);
  }
  if (
    value.fixedInitialExpectation === 'APPROPRIATELY_OPEN' &&
    (wrongTargetCount !== 0 ||
      !baseProfile.acceptableStatuses.includes(participant.fixedInitial.status) ||
      !baseProfile.acceptedAnswerOptionSets.some((set) =>
        sameStringSet(set, participant.fixedInitial.selectedOptionIds)
      ))
  ) {
    throw new Error(`H1b gap fixed initial must satisfy the BASE profile at ${location}.`);
  }
  const publicSignal = participant.signal.artifacts[0]!;
  if (
    participant.stratum === 'DERIVABLE_CRITIQUE' &&
    (!publicSignal.targetPropositionId ||
      !targetPropositionIds.includes(publicSignal.targetPropositionId) ||
      !acceptedIssueKindEquivalences.some(
        (equivalence) =>
          equivalence.targetPropositionId === publicSignal.targetPropositionId &&
          publicSignal.kind !== undefined &&
          equivalence.acceptedKinds.includes(publicSignal.kind) &&
          publicSignal.severity !== undefined &&
          equivalence.acceptedSeverities.includes(publicSignal.severity)
      ))
  ) {
    throw new Error(`H1b derivable signal must target an accepted target issue at ${location}.`);
  }

  return {
    caseId: participant.caseId,
    stratum: participant.stratum,
    fixedInitialExpectation: value.fixedInitialExpectation,
    targetPropositionIds,
    guardPropositionIds,
    baseProfile,
    treatmentProfile,
    acceptedIssueKindEquivalences,
    derivationNotes: [...value.derivationNotes],
    auditNotes: [...value.auditNotes]
  };
}

function validateProfile(
  value: unknown,
  profile: H1bOracleProfile['profile'],
  expectedConditions: readonly H1bConditionId[],
  propositionIds: Set<string>,
  optionIds: Set<string>,
  allowedEvidenceIds: Set<string>,
  location: string
): H1bOracleProfile {
  if (
    !isRecord(value) ||
    value.profile !== profile ||
    !isStringArray(value.conditionIds) ||
    !sameStringSet(value.conditionIds, expectedConditions) ||
    !Array.isArray(value.acceptableStatuses) ||
    value.acceptableStatuses.length === 0 ||
    !value.acceptableStatuses.every((status) => OUTPUT_STATUSES.includes(status as LabOutputStatus)) ||
    !isNestedStringArray(value.acceptedAnswerValueSets) ||
    !isNestedStringArray(value.acceptedAnswerOptionSets) ||
    !Array.isArray(value.propositions) ||
    !isStringArray(value.requiredUserQuestionCruxIds)
  ) {
    throw new Error(`Invalid H1b ${profile} profile at ${location}.`);
  }
  value.acceptedAnswerOptionSets.flat().forEach((optionId) => {
    if (!optionIds.has(optionId)) {
      throw new Error(`Unknown H1b answer option ${optionId} at ${location}.`);
    }
  });
  const propositions = value.propositions.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.propositionId !== 'string' ||
      !propositionIds.has(item.propositionId) ||
      !Array.isArray(item.acceptableStances) ||
      item.acceptableStances.length === 0 ||
      !item.acceptableStances.every((stance) => CLAIM_STANCES.includes(stance as LabClaimStance)) ||
      !isNestedStringArray(item.requiredEvidenceSets)
    ) {
      throw new Error(`Invalid H1b ${profile} proposition at ${location}[${index}].`);
    }
    item.requiredEvidenceSets.flat().forEach((evidenceId) => {
      if (!allowedEvidenceIds.has(evidenceId)) {
        throw new Error(`Unknown H1b ${profile} evidence ${evidenceId} at ${location}.`);
      }
    });
    return {
      propositionId: item.propositionId,
      acceptableStances: [...item.acceptableStances] as LabClaimStance[],
      requiredEvidenceSets: item.requiredEvidenceSets.map((set) => [...set])
    };
  });
  if (
    propositions.length !== propositionIds.size ||
    new Set(propositions.map((item) => item.propositionId)).size !== propositionIds.size
  ) {
    throw new Error(`H1b ${profile} profile must cover every proposition exactly once at ${location}.`);
  }
  return {
    profile,
    conditionIds: [...value.conditionIds] as H1bConditionId[],
    acceptableStatuses: [...value.acceptableStatuses] as LabOutputStatus[],
    acceptedAnswerValueSets: value.acceptedAnswerValueSets.map((set) => [...set]),
    acceptedAnswerOptionSets: value.acceptedAnswerOptionSets.map((set) => [...set]),
    propositions,
    requiredUserQuestionCruxIds: [...value.requiredUserQuestionCruxIds]
  };
}

function treatmentCondition(stratum: H1bStratum): H1bConditionId {
  return stratum === 'DERIVABLE_CRITIQUE'
    ? 'CONTROL_VALID_CRITIQUE_B1'
    : 'CONTROL_EVIDENCE_B1';
}

function profileEvidenceIds(profile: H1bOracleProfile): Set<string> {
  return new Set(profile.propositions.flatMap((item) => item.requiredEvidenceSets.flat()));
}

function assertExactCaseSet(caseIds: string[], label: string): void {
  if (
    caseIds.length !== H1B_CASE_IDS.length ||
    new Set(caseIds).size !== H1B_CASE_IDS.length ||
    !sameStringSet(caseIds, H1B_CASE_IDS)
  ) {
    throw new Error(`H1b ${label} corpus must contain exactly the six development cases.`);
  }
}

function assertStratumBalance(records: H1bParticipantCaseRecord[]): void {
  const derivable = records.filter((item) => item.stratum === 'DERIVABLE_CRITIQUE').length;
  const evidence = records.filter((item) => item.stratum === 'NEW_EVIDENCE').length;
  if (derivable !== 3 || evidence !== 3) {
    throw new Error('H1b participant corpus must contain three cases in each stratum.');
  }
}

function assertParticipantPath(filePath: string): void {
  if (filePath.split(path.sep).includes('scorer-only')) {
    throw new Error('H1b participant loading cannot access scorer-only fixtures.');
  }
}

function assertNoOracleKeys(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOracleKeys(item, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PARTICIPANT_FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Scorer-only H1b key ${key} appeared in participant fixture at ${location}.`);
    }
    assertNoOracleKeys(child, `${location}.${key}`);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNestedStringArray(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((item) => isStringArray(item));
}

async function readJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1b fixture must be a real file: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}
