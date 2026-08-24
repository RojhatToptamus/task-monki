import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabParticipantCase } from './contracts';
import { validateLabParticipantCase } from './outputValidation';

export const H1C_CORPUS_VERSION = 'h1c-assay-corpus@v3' as const;
export const H1C_PARTICIPANT_CORPUS_SCHEMA_VERSION =
  'discourse-lab/h1c-participant-corpus@v3' as const;
export const H1C_ORACLE_CORPUS_SCHEMA_VERSION =
  'discourse-lab/h1c-oracle-corpus@v3' as const;

export type H1cStratum = 'DERIVABLE_CRITIQUE' | 'NEW_EVIDENCE';
export type H1cConditionId =
  | 'STRONG_INITIAL'
  | 'ACTIVE_SELF_REVIEW'
  | 'VALID_CRITIQUE'
  | 'PLACEBO_CRITIQUE'
  | 'DECISIVE_EVIDENCE';

export interface H1cCritiqueSignal {
  artifactId: string;
  artifactType: 'CRITIQUE';
  issueId: string;
  targetPropositionId: string;
  issueKind: 'FACTUAL' | 'EVIDENCE' | 'ASSUMPTION' | 'LOGIC' | 'AMBIGUITY' |
    'MISSING_INFORMATION' | 'TRADEOFF' | 'OTHER';
  severity: 'MATERIAL' | 'ADVISORY';
  containsNewFacts: false;
  statement: string;
}

export interface H1cEvidenceSignal {
  artifactId: string;
  artifactType: 'FACTUAL_EVIDENCE';
  evidenceId: string;
  sourceLabel: string;
  containsNewFacts: true;
  statement: string;
}

export interface H1cParticipantRecord {
  caseId: string;
  stratum: H1cStratum;
  participantCase: LabParticipantCase;
  validCritique?: H1cCritiqueSignal;
  placeboCritique?: H1cCritiqueSignal;
  decisiveEvidence?: H1cEvidenceSignal;
}

export interface H1cParticipantCorpus {
  schemaVersion: typeof H1C_PARTICIPANT_CORPUS_SCHEMA_VERSION;
  corpusVersion: typeof H1C_CORPUS_VERSION;
  partition: 'DEVELOPMENT';
  confirmationStatus: 'ABSENT_CLOSED';
  records: H1cParticipantRecord[];
}

export type H1cExpectedAssessment =
  | 'SUPPORTED'
  | 'CONTRADICTED'
  | 'UNRESOLVED'
  | 'NOT_APPLICABLE';
export type H1cExpectedEvidenceRelation = 'SUPPORTS' | 'CONTRADICTS' | 'LIMITS';

export interface H1cEvidenceExpectation {
  evidenceId: string;
  relation: H1cExpectedEvidenceRelation;
}

export interface H1cClaimExpectation {
  propositionId: string;
  assessment: H1cExpectedAssessment;
  /** Minimum evidence coverage: satisfying any one alternative is enough. */
  requiredEvidenceAlternatives: H1cEvidenceExpectation[][];
  /** Exhaustive permitted pairs, or null when extra semantic relevance is unadjudicated. */
  allowedEvidenceReferences: H1cEvidenceExpectation[] | null;
}

export interface H1cInformationRequestExpectation {
  kind: 'MISSING_FACT' | 'USER_PREFERENCE' | 'AUTHORIZATION' | 'TEST_OR_CHECK';
  source: 'USER' | 'DOCUMENT' | 'TOOL' | 'EXPERT' | 'UNKNOWN';
  blocking: boolean;
  /** Minimum proposition coverage required for a correctly targeted request. */
  requiredPropositionIds: string[];
  /** Exhaustive permitted targets, or null when additional targets are unadjudicated. */
  allowedPropositionIds: string[] | null;
  requiresUserAction: boolean;
}

export interface H1cOracleProfile {
  completionDisposition: 'COMPLETE' | 'NEEDS_USER_ACTION' | 'ABSTAIN';
  epistemicState: 'RESOLVED' | 'UNDERDETERMINED' | 'MULTIPLE_DEFENSIBLE';
  selectedOptionIds: string[];
  claims: H1cClaimExpectation[];
  informationRequest: H1cInformationRequestExpectation | null;
  requiredTreatmentEvidenceId: string | null;
}

export interface H1cIssueOracle {
  issueId: string;
  artifactId: string;
  targetPropositionId: string;
  truth: 'VALID_IF_TARGET_DRAFT_WRONG' | 'FALSE_OR_IRRELEVANT';
}

export interface H1cOracleRecord {
  caseId: string;
  stratum: H1cStratum;
  targetPropositionIds: string[];
  guardPropositionIds: string[];
  baseProfile: H1cOracleProfile;
  treatmentProfile: H1cOracleProfile;
  issueOracles: H1cIssueOracle[];
  oracleRationale: string;
  ambiguityAudit: string;
}

export interface H1cOracleCorpus {
  schemaVersion: typeof H1C_ORACLE_CORPUS_SCHEMA_VERSION;
  corpusVersion: typeof H1C_CORPUS_VERSION;
  partition: 'DEVELOPMENT';
  records: H1cOracleRecord[];
}

export function h1cParticipantFixturePath(fixtureRoot: string): string {
  return path.join(fixtureRoot, 'corpus', 'h1c-v3', 'participants', 'development.json');
}

export function h1cOracleFixturePath(fixtureRoot: string): string {
  return path.join(fixtureRoot, 'corpus', 'h1c-v3', 'scorer-only', 'development-oracles.json');
}

export async function loadH1cParticipantCorpus(
  fixtureRoot: string
): Promise<H1cParticipantCorpus> {
  const filePath = h1cParticipantFixturePath(fixtureRoot);
  const corpus = await readRealJson<H1cParticipantCorpus>(filePath, 'participant corpus');
  if (
    corpus.schemaVersion !== H1C_PARTICIPANT_CORPUS_SCHEMA_VERSION ||
    corpus.corpusVersion !== H1C_CORPUS_VERSION ||
    corpus.partition !== 'DEVELOPMENT' ||
    corpus.confirmationStatus !== 'ABSENT_CLOSED' ||
    corpus.records.length !== 4
  ) {
    throw new Error('H1c participant corpus header or development boundary is invalid.');
  }
  const ids = new Set<string>();
  for (const record of corpus.records) {
    if (!record.caseId || ids.has(record.caseId) || record.participantCase.caseId !== record.caseId) {
      throw new Error(`H1c participant case identity is invalid: ${record.caseId}.`);
    }
    ids.add(record.caseId);
    const participant = validateLabParticipantCase(record.participantCase);
    if (!participant.ok) {
      throw new Error(`H1c participant case ${record.caseId} is invalid: ${participant.errors[0]?.message}.`);
    }
    validateReservedIdentifiers(record);
    validateSignals(record);
  }
  if (
    corpus.records.filter((record) => record.stratum === 'DERIVABLE_CRITIQUE').length !== 2 ||
    corpus.records.filter((record) => record.stratum === 'NEW_EVIDENCE').length !== 2
  ) {
    throw new Error('H1c requires exactly two cases in each mechanism stratum.');
  }
  return structuredClone(corpus);
}

function validateReservedIdentifiers(record: H1cParticipantRecord): void {
  const reserved = new Set(['CASE', 'PROMPT', 'DRAFT']);
  const identifiers = [
    ...record.participantCase.evidence.map((item) => item.id),
    ...record.participantCase.propositions.map((item) => item.id),
    ...record.participantCase.options.map((item) => item.id),
    ...record.participantCase.topics.map((item) => item.id),
    ...(record.validCritique
      ? [record.validCritique.artifactId, record.validCritique.issueId]
      : []),
    ...(record.placeboCritique
      ? [record.placeboCritique.artifactId, record.placeboCritique.issueId]
      : []),
    ...(record.decisiveEvidence
      ? [record.decisiveEvidence.artifactId, record.decisiveEvidence.evidenceId]
      : [])
  ];
  const collision = identifiers.find((id) => reserved.has(id));
  if (collision) {
    throw new Error(
      `H1c participant case ${record.caseId} collides with reserved identifier ${collision}.`
    );
  }
}

export async function loadH1cOracleCorpus(
  fixtureRoot: string,
  participants: H1cParticipantCorpus
): Promise<H1cOracleCorpus> {
  const filePath = h1cOracleFixturePath(fixtureRoot);
  const corpus = await readRealJson<H1cOracleCorpus>(filePath, 'scorer-only corpus');
  if (
    corpus.schemaVersion !== H1C_ORACLE_CORPUS_SCHEMA_VERSION ||
    corpus.corpusVersion !== H1C_CORPUS_VERSION ||
    corpus.partition !== 'DEVELOPMENT' ||
    corpus.records.length !== participants.records.length
  ) {
    throw new Error('H1c scorer-only corpus header is invalid.');
  }
  const participantById = new Map(participants.records.map((record) => [record.caseId, record]));
  const seen = new Set<string>();
  for (const oracle of corpus.records) {
    const participant = participantById.get(oracle.caseId);
    if (!participant || seen.has(oracle.caseId) || oracle.stratum !== participant.stratum) {
      throw new Error(`H1c scorer-only case identity is invalid: ${oracle.caseId}.`);
    }
    seen.add(oracle.caseId);
    validateOracle(oracle, participant);
  }
  if (seen.size !== participantById.size) {
    throw new Error('H1c scorer-only corpus does not cover every participant case exactly once.');
  }
  return structuredClone(corpus);
}

function validateSignals(record: H1cParticipantRecord): void {
  if (record.stratum === 'DERIVABLE_CRITIQUE') {
    if (!record.validCritique || !record.placeboCritique || record.decisiveEvidence) {
      throw new Error(`H1c derivable case ${record.caseId} has the wrong signal set.`);
    }
    for (const signal of [record.validCritique, record.placeboCritique]) {
      if (
        signal.artifactType !== 'CRITIQUE' ||
        signal.containsNewFacts !== false ||
        !record.participantCase.propositions.some(
          (proposition) => proposition.id === signal.targetPropositionId
        ) ||
        !signal.artifactId ||
        !signal.issueId ||
        !signal.statement.trim()
      ) {
        throw new Error(`H1c critique signal is invalid for ${record.caseId}.`);
      }
    }
    if (record.validCritique.artifactId === record.placeboCritique.artifactId) {
      throw new Error(`H1c critique artifacts must be distinct for ${record.caseId}.`);
    }
    if (
      record.validCritique.targetPropositionId !==
        record.placeboCritique.targetPropositionId ||
      record.validCritique.issueKind !== record.placeboCritique.issueKind ||
      record.validCritique.severity !== record.placeboCritique.severity
    ) {
      throw new Error(
        `H1c valid and placebo critiques must match target, kind, and severity for ${record.caseId}.`
      );
    }
    return;
  }
  if (!record.decisiveEvidence || record.validCritique || record.placeboCritique) {
    throw new Error(`H1c evidence case ${record.caseId} has the wrong signal set.`);
  }
  if (
    record.decisiveEvidence.artifactType !== 'FACTUAL_EVIDENCE' ||
    record.decisiveEvidence.containsNewFacts !== true ||
    !record.decisiveEvidence.artifactId ||
    !record.decisiveEvidence.evidenceId ||
    !record.decisiveEvidence.sourceLabel.trim() ||
    !record.decisiveEvidence.statement.trim()
  ) {
    throw new Error(`H1c evidence signal is invalid for ${record.caseId}.`);
  }
}

function validateOracle(oracle: H1cOracleRecord, participant: H1cParticipantRecord): void {
  const propositionIds = new Set(
    participant.participantCase.propositions.map((proposition) => proposition.id)
  );
  const optionIds = new Set(participant.participantCase.options.map((option) => option.id));
  const expectedEvidenceIds = new Set([
    'PROMPT',
    ...participant.participantCase.evidence.map((evidence) => evidence.id),
    ...(participant.decisiveEvidence ? [participant.decisiveEvidence.evidenceId] : [])
  ]);
  if (
    oracle.targetPropositionIds.length === 0 ||
    oracle.guardPropositionIds.length < 2 ||
    [...oracle.targetPropositionIds, ...oracle.guardPropositionIds].some(
      (id) => !propositionIds.has(id)
    ) ||
    new Set([...oracle.targetPropositionIds, ...oracle.guardPropositionIds]).size !==
      oracle.targetPropositionIds.length + oracle.guardPropositionIds.length ||
    !oracle.oracleRationale.trim() ||
    !oracle.ambiguityAudit.trim()
  ) {
    throw new Error(`H1c oracle target/guard definition is invalid for ${oracle.caseId}.`);
  }
  for (const profile of [oracle.baseProfile, oracle.treatmentProfile]) {
    if (
      profile.selectedOptionIds.length !== 1 ||
      !optionIds.has(profile.selectedOptionIds[0]!) ||
      profile.claims.length !== propositionIds.size ||
      new Set(profile.claims.map((claim) => claim.propositionId)).size !== propositionIds.size ||
      profile.claims.some((claim) =>
        !propositionIds.has(claim.propositionId) ||
        (claim.allowedEvidenceReferences !== null && (
          new Set(claim.allowedEvidenceReferences.map((item) =>
            `${item.evidenceId}\u0000${item.relation}`
          )).size !== claim.allowedEvidenceReferences.length ||
          claim.allowedEvidenceReferences.some(
            (item) => !expectedEvidenceIds.has(item.evidenceId)
          )
        )) ||
        claim.requiredEvidenceAlternatives.some((alternative) =>
          alternative.length === 0 || alternative.some((item) =>
            !expectedEvidenceIds.has(item.evidenceId) ||
            (claim.allowedEvidenceReferences !== null &&
            !claim.allowedEvidenceReferences.some((allowed) =>
              allowed.evidenceId === item.evidenceId && allowed.relation === item.relation
            ))
          )
        )
      )
    ) {
      throw new Error(`H1c oracle profile is invalid for ${oracle.caseId}.`);
    }
    const request = profile.informationRequest;
    if (request) {
      const requiredPropositionIds = new Set(request.requiredPropositionIds);
      const allowedPropositionIds = request.allowedPropositionIds === null
        ? null
        : new Set(request.allowedPropositionIds);
      if (
        request.requiredPropositionIds.length === 0 ||
        requiredPropositionIds.size !== request.requiredPropositionIds.length ||
        request.requiredPropositionIds.some((id) => !propositionIds.has(id)) ||
        (request.allowedPropositionIds !== null && (
          allowedPropositionIds!.size !== request.allowedPropositionIds.length ||
          request.allowedPropositionIds.some((id) => !propositionIds.has(id)) ||
          request.requiredPropositionIds.some((id) => !allowedPropositionIds!.has(id))
        )) ||
        request.requiresUserAction !==
          (request.source === 'USER' && request.blocking) ||
        (request.requiresUserAction && profile.completionDisposition !== 'NEEDS_USER_ACTION')
      ) {
        throw new Error(`H1c information-request oracle is invalid for ${oracle.caseId}.`);
      }
    } else if (profile.completionDisposition === 'NEEDS_USER_ACTION') {
      throw new Error(`H1c user action lacks a request oracle for ${oracle.caseId}.`);
    }
  }
  if (participant.stratum === 'DERIVABLE_CRITIQUE') {
    const expectedIssues = new Map<H1cIssueOracle['truth'], H1cCritiqueSignal>([
      ['VALID_IF_TARGET_DRAFT_WRONG', participant.validCritique!],
      ['FALSE_OR_IRRELEVANT', participant.placeboCritique!]
    ]);
    if (
      oracle.issueOracles.length !== 2 ||
      new Set(oracle.issueOracles.map((issue) => issue.truth)).size !== expectedIssues.size ||
      oracle.issueOracles.some((issue) => {
        const signal = expectedIssues.get(issue.truth);
        return (
          !signal ||
          issue.issueId !== signal.issueId ||
          issue.artifactId !== signal.artifactId ||
          issue.targetPropositionId !== signal.targetPropositionId
        );
      }) ||
      oracle.treatmentProfile.requiredTreatmentEvidenceId !== null
    ) {
      throw new Error(`H1c controlled-critique oracle is invalid for ${oracle.caseId}.`);
    }
  } else if (
    oracle.issueOracles.length !== 0 ||
    oracle.baseProfile.requiredTreatmentEvidenceId !== null ||
    oracle.treatmentProfile.requiredTreatmentEvidenceId !==
      participant.decisiveEvidence!.evidenceId
  ) {
    throw new Error(`H1c controlled-evidence oracle is invalid for ${oracle.caseId}.`);
  }
}

async function readRealJson<T>(filePath: string, label: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1c ${label} must be a real file: ${filePath}.`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}
