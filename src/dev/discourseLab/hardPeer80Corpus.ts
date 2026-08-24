import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabIssueKind, LabParticipantCase } from './contracts';
import { validateLabParticipantCase } from './outputValidation';

export const HARD_PEER_80_CORPUS_VERSION = 'hard-peer-80-corpus@v1' as const;
export const HARD_PEER_80_PARTICIPANT_CORPUS_SCHEMA_VERSION =
  'discourse-lab/hard-peer-80-participant-corpus@v1' as const;
export const HARD_PEER_80_ORACLE_CORPUS_SCHEMA_VERSION =
  'discourse-lab/hard-peer-80-oracle-corpus@v1' as const;

export type HardPeer80Partition = 'CALIBRATION' | 'EVALUATION';
export type HardPeer80Domain =
  | 'ERDOS_STYLE_MATHEMATICS'
  | 'RIGOROUS_LOGIC'
  | 'HIDDEN_ASSUMPTION_REASONING'
  | 'SELF_CONTAINED_DEBUGGING'
  | 'TASK_MONKI_TECHNICAL_DECISION';

export const HARD_PEER_80_DOMAINS: readonly HardPeer80Domain[] = [
  'ERDOS_STYLE_MATHEMATICS',
  'RIGOROUS_LOGIC',
  'HIDDEN_ASSUMPTION_REASONING',
  'SELF_CONTAINED_DEBUGGING',
  'TASK_MONKI_TECHNICAL_DECISION'
];

export interface HardPeer80ParticipantRecord {
  caseId: string;
  domain: HardPeer80Domain;
  participantCase: LabParticipantCase;
}

export interface HardPeer80ParticipantCorpus {
  schemaVersion: typeof HARD_PEER_80_PARTICIPANT_CORPUS_SCHEMA_VERSION;
  corpusVersion: typeof HARD_PEER_80_CORPUS_VERSION;
  partition: HardPeer80Partition;
  records: HardPeer80ParticipantRecord[];
}

export interface HardPeer80AtomicClaim {
  id: string;
  expected: 'ACCEPT' | 'REJECT';
  required: true;
  text: string;
}

export interface HardPeer80GuardClaim {
  id: string;
  text: string;
}

export interface HardPeer80CritiquePredicate {
  id: string;
  targetClaimIds: string[];
  kinds: LabIssueKind[];
  severity: 'MATERIAL' | 'ADVISORY';
  validWhen: string;
}

export type HardPeer80Certificate =
  | {
      kind: 'FORBIDDEN_DIFFERENCE_MATCHING';
      universeSize: number;
      forbiddenDifferences: number[];
      specialElements: number[];
      exactSpecialCount: number;
      optimum: number;
      construction: number[];
      upperBoundMatching: [number, number][];
    }
  | {
      kind: 'BOOLEAN_TRUTH_TABLE';
      variableOrder: string[];
      satisfyingAssignments: string[];
      queryTrueAssignments: string[];
      queryFalseAssignments: string[];
      classification: 'ENTAILED' | 'CONTRADICTED' | 'OPEN';
    }
  | {
      kind: 'CLOCK_OFFSET_WITNESSES';
      offsetRange: [number, number];
      latencyRange: [number, number];
      relativeOffsetRange: [number, number];
      worlds: Array<{
        name: string;
        offsetA: number;
        offsetB: number;
        latency: number;
        leaseAUtc: [number, number];
        leaseBUtc: [number, number];
        claimTrue: boolean;
      }>;
    }
  | {
      kind: 'CONTINGENCY_EXPECTATION_BOUNDS';
      population: number;
      initialPositive: number;
      flagged: number;
      intersectionRange: [number, number];
      repairProbability: number;
      damageProbability: number;
      finalExpectationIntercept: number;
      finalExpectationSlope: number;
      finalExpectationRange: [number, number];
      strictImprovementMinimumIntegerIntersection: number;
      witnessTables: Array<{
        intersection: number;
        flaggedGood: number;
        unflaggedDefective: number;
        unflaggedGood: number;
        finalExpectation: number;
      }>;
    }
  | {
      kind: 'SCOPED_REVISION_TRACE';
      requestedSession: string;
      updates: Array<{
        session: string;
        item: string;
        revision: string;
        state: 'open' | 'done';
      }>;
      currentOutput: string[];
      requiredOutput: string[];
      repair: {
        scopeUpdatesToRequestedSessionBeforeLatestSelection: boolean;
        compareRevisionsAsExactNonnegativeIntegers: boolean;
      };
    }
  | {
      kind: 'RUN_PROJECTION_TRACES';
      activeRunId: string;
      traces: Array<{
        name: string;
        events: Array<[string, number, 'provider-completed' | 'process-exit' | 'report-verified']>;
        current: 'running' | 'interrupted' | 'completed';
        required: 'running' | 'interrupted' | 'completed';
      }>;
      repair: {
        scopeOrdinalFilteringToActiveRun: boolean;
        treatProviderCompletionAsTelemetryOnly: boolean;
        deriveStatusAfterEvidenceAccumulation: boolean;
      };
    }
  | {
      kind: 'IDEMPOTENT_CREATE_CRASH_TABLE';
      durableKeyBeforeCall: boolean;
      sameKeyOnRecovery: boolean;
      providerIdempotentByKey: boolean;
      providerLookupByKey: boolean;
      workflowRequiresLocalVerification: boolean;
      crashScenarios: Array<{
        providerCreateAppliedBeforeCrash: boolean;
        createReplyReceivedBeforeCrash: boolean;
        remoteIdPersistedBeforeCrash: boolean;
        recoveryContactsProvider: boolean;
        recoveryUsesPersistedKey: boolean;
        atMostOneRemoteTurn: boolean;
        remoteIdEventuallyRecoverable: boolean;
      }>;
    }
  | {
      kind: 'INDISTINGUISHABLE_CRASH_WORLDS';
      worlds: Array<{
        name: string;
        durableLocalState: string;
        providerAppliedCount: number;
      }>;
      recoveryChoices: Array<{
        choice: string;
        sendsInterrupt: boolean;
        violates: 'SAFETY' | 'LIVENESS';
        world: string;
      }>;
    };

export interface HardPeer80OracleRecord {
  caseId: string;
  domain: HardPeer80Domain;
  acceptedStatus: 'ANSWER' | 'UNCERTAIN' | 'ABSTAIN' | 'NEEDS_USER_INPUT';
  epistemicState: 'RESOLVED' | 'UNDERDETERMINED';
  acceptedOptionIds: string[];
  acceptedAnswerValues: string[];
  acceptedCertificateKinds: Array<
    'DIRECT' | 'PROOF_SKETCH' | 'COUNTEREXAMPLE' | 'TRACE' | 'TRADEOFF' |
    'MISSING_INFORMATION'
  >;
  requiredEvidenceIds: ['PROMPT'];
  requestExpectation: 'NONE';
  abstentionIsCorrect: boolean;
  atomicClaims: HardPeer80AtomicClaim[];
  guardClaims: HardPeer80GuardClaim[];
  validCritiquePredicates: HardPeer80CritiquePredicate[];
  disagreementPolicy: {
    preserveUnresolvedMaterialIssue: true;
    userOwnedCrux: false;
  };
  certificate: HardPeer80Certificate;
  verification: {
    method: string;
    humanExpertRequired: false;
    independentReimplementationRequiredBeforeSeal: true;
  };
}

export interface HardPeer80OracleCorpus {
  schemaVersion: typeof HARD_PEER_80_ORACLE_CORPUS_SCHEMA_VERSION;
  corpusVersion: typeof HARD_PEER_80_CORPUS_VERSION;
  partition: HardPeer80Partition;
  records: HardPeer80OracleRecord[];
}

export interface HardPeer80LoadedCorpus {
  participants: HardPeer80ParticipantCorpus;
  oracles: HardPeer80OracleCorpus;
}

export type HardPeer80CertificateValidation =
  | { valid: true }
  | { valid: false; error: string };

export function hardPeer80ParticipantFixturePath(
  fixtureRoot: string,
  partition: HardPeer80Partition
): string {
  return path.join(
    fixtureRoot,
    'corpus',
    'hard-peer-80-v1',
    'participants',
    `${partition.toLowerCase()}.json`
  );
}

export function hardPeer80OracleFixturePath(
  fixtureRoot: string,
  partition: HardPeer80Partition
): string {
  return path.join(
    fixtureRoot,
    'corpus',
    'hard-peer-80-v1',
    'scorer-only',
    `${partition.toLowerCase()}-oracles.json`
  );
}

export async function loadHardPeer80ParticipantCorpus(
  fixtureRoot: string,
  partition: HardPeer80Partition
): Promise<HardPeer80ParticipantCorpus> {
  const corpus = await readJson<HardPeer80ParticipantCorpus>(
    hardPeer80ParticipantFixturePath(fixtureRoot, partition),
    'participant corpus'
  );
  if (
    corpus.schemaVersion !== HARD_PEER_80_PARTICIPANT_CORPUS_SCHEMA_VERSION ||
    corpus.corpusVersion !== HARD_PEER_80_CORPUS_VERSION ||
    corpus.partition !== partition ||
    !Array.isArray(corpus.records) ||
    corpus.records.length !== 5
  ) {
    throw new Error(`HARD-PEER-80 ${partition} participant corpus header is invalid.`);
  }
  validateParticipantRecords(corpus.records, partition);
  return structuredClone(corpus);
}

export async function loadHardPeer80OracleCorpus(
  fixtureRoot: string,
  partition: HardPeer80Partition,
  participants: HardPeer80ParticipantCorpus
): Promise<HardPeer80OracleCorpus> {
  const corpus = await readJson<HardPeer80OracleCorpus>(
    hardPeer80OracleFixturePath(fixtureRoot, partition),
    'scorer-only corpus'
  );
  if (
    corpus.schemaVersion !== HARD_PEER_80_ORACLE_CORPUS_SCHEMA_VERSION ||
    corpus.corpusVersion !== HARD_PEER_80_CORPUS_VERSION ||
    corpus.partition !== partition ||
    !Array.isArray(corpus.records) ||
    corpus.records.length !== participants.records.length
  ) {
    throw new Error(`HARD-PEER-80 ${partition} scorer-only corpus header is invalid.`);
  }
  validateOracleRecords(corpus.records, participants);
  return structuredClone(corpus);
}

export async function loadHardPeer80Corpus(
  fixtureRoot: string,
  partition: HardPeer80Partition
): Promise<HardPeer80LoadedCorpus> {
  const participants = await loadHardPeer80ParticipantCorpus(fixtureRoot, partition);
  const oracles = await loadHardPeer80OracleCorpus(fixtureRoot, partition, participants);
  return { participants, oracles };
}

function validateParticipantRecords(
  records: readonly HardPeer80ParticipantRecord[],
  partition: HardPeer80Partition
): void {
  const prefix = partition === 'CALIBRATION' ? 'HP80-CAL-' : 'HP80-EVAL-';
  const ids = new Set<string>();
  const domains = new Set<HardPeer80Domain>();
  for (const record of records) {
    if (
      !record ||
      typeof record.caseId !== 'string' ||
      !record.caseId.startsWith(prefix) ||
      ids.has(record.caseId) ||
      !HARD_PEER_80_DOMAINS.includes(record.domain) ||
      domains.has(record.domain) ||
      record.participantCase?.caseId !== record.caseId
    ) {
      throw new Error(`HARD-PEER-80 participant identity or domain is invalid: ${record?.caseId}.`);
    }
    const validation = validateLabParticipantCase(record.participantCase);
    if (!validation.ok) {
      throw new Error(
        `HARD-PEER-80 participant case ${record.caseId} is invalid: ${validation.errors[0]?.message}.`
      );
    }
    if (record.participantCase.evidence.length !== 0) {
      throw new Error(`HARD-PEER-80 case ${record.caseId} must remain prompt-only.`);
    }
    ids.add(record.caseId);
    domains.add(record.domain);
  }
  if (domains.size !== HARD_PEER_80_DOMAINS.length) {
    throw new Error(`HARD-PEER-80 ${partition} must contain exactly one case per domain.`);
  }
}

function validateOracleRecords(
  records: readonly HardPeer80OracleRecord[],
  participants: HardPeer80ParticipantCorpus
): void {
  const participantById = new Map(participants.records.map((record) => [record.caseId, record]));
  const seen = new Set<string>();
  for (const oracle of records) {
    const participant = participantById.get(oracle?.caseId);
    if (!participant || seen.has(oracle.caseId) || oracle.domain !== participant.domain) {
      throw new Error(`HARD-PEER-80 scorer-only identity is invalid: ${oracle?.caseId}.`);
    }
    const propositionById = new Map(
      participant.participantCase.propositions.map((proposition) => [
        proposition.id,
        proposition.text
      ])
    );
    const propositionIds = new Set(propositionById.keys());
    const optionIds = new Set(participant.participantCase.options.map((option) => option.id));
    if (
      oracle.acceptedStatus !== 'ANSWER' ||
      oracle.abstentionIsCorrect !== false ||
      !Array.isArray(oracle.acceptedOptionIds) ||
      oracle.acceptedOptionIds.length !== 1 ||
      oracle.acceptedOptionIds.some((optionId) => !optionIds.has(optionId)) ||
      !Array.isArray(oracle.acceptedAnswerValues) ||
      oracle.acceptedAnswerValues.length === 0 ||
      !Array.isArray(oracle.acceptedCertificateKinds) ||
      oracle.acceptedCertificateKinds.length === 0 ||
      !sameStrings(oracle.requiredEvidenceIds, ['PROMPT']) ||
      oracle.requestExpectation !== 'NONE' ||
      !Array.isArray(oracle.atomicClaims) ||
      oracle.atomicClaims.length !== propositionIds.size ||
      !Array.isArray(oracle.guardClaims) ||
      oracle.guardClaims.length === 0 ||
      !Array.isArray(oracle.validCritiquePredicates) ||
      oracle.validCritiquePredicates.length === 0 ||
      oracle.disagreementPolicy?.preserveUnresolvedMaterialIssue !== true ||
      oracle.disagreementPolicy?.userOwnedCrux !== false ||
      oracle.verification?.humanExpertRequired !== false ||
      oracle.verification?.independentReimplementationRequiredBeforeSeal !== true ||
      !oracle.verification.method?.trim()
    ) {
      throw new Error(`HARD-PEER-80 scorer-only contract is invalid: ${oracle.caseId}.`);
    }
    const atomicIds = new Set<string>();
    for (const claim of oracle.atomicClaims) {
      if (propositionIds.has(claim.id) && claim.text !== propositionById.get(claim.id)) {
        throw new Error(
          `HARD-PEER-80 atomic claim drifts from its public proposition: ${oracle.caseId}/${claim.id}.`
        );
      }
      if (
        !propositionIds.has(claim.id) ||
        atomicIds.has(claim.id) ||
        !['ACCEPT', 'REJECT'].includes(claim.expected) ||
        claim.required !== true ||
        !claim.text?.trim()
      ) {
        throw new Error(`HARD-PEER-80 atomic claim is invalid: ${oracle.caseId}/${claim?.id}.`);
      }
      atomicIds.add(claim.id);
    }
    for (const critique of oracle.validCritiquePredicates) {
      if (
        !critique.id?.trim() ||
        !critique.validWhen?.trim() ||
        critique.targetClaimIds.length === 0 ||
        critique.targetClaimIds.some((id) => !atomicIds.has(id)) ||
        critique.kinds.length === 0 ||
        critique.kinds.some((kind) => ![
          'FACTUAL', 'EVIDENCE', 'ASSUMPTION', 'LOGIC', 'AMBIGUITY',
          'MISSING_INFORMATION', 'TRADEOFF', 'OTHER'
        ].includes(kind))
      ) {
        throw new Error(`HARD-PEER-80 critique predicate is invalid: ${oracle.caseId}.`);
      }
    }
    const certificateValidation = validateHardPeer80Certificate(
      oracle.caseId,
      oracle.certificate
    );
    if (!certificateValidation.valid) {
      throw new Error(certificateValidation.error);
    }
    seen.add(oracle.caseId);
  }
  if (seen.size !== participantById.size) {
    throw new Error('HARD-PEER-80 scorer-only corpus must cover every participant case once.');
  }
}

/**
 * Validates a typed public certificate against the exact sealed case. The
 * result depends only on the case id and certificate payload; oracle prose,
 * answer claims, and condition identity are deliberately not inputs.
 */
export function validateHardPeer80Certificate(
  caseId: string,
  certificate: HardPeer80Certificate
): HardPeer80CertificateValidation {
  try {
    assertCertificateCaseBoundary(caseId, certificate);
    verifyCertificatePayload(caseId, certificate);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function verifyCertificatePayload(caseId: string, certificate: HardPeer80Certificate): void {
  switch (certificate.kind) {
    case 'FORBIDDEN_DIFFERENCE_MATCHING':
      verifyForbiddenDifferenceCertificate(caseId, certificate);
      return;
    case 'BOOLEAN_TRUTH_TABLE':
      verifyTruthTableCertificate(caseId, certificate);
      return;
    case 'CLOCK_OFFSET_WITNESSES':
      verifyClockCertificate(caseId, certificate);
      return;
    case 'CONTINGENCY_EXPECTATION_BOUNDS':
      verifyContingencyCertificate(caseId, certificate);
      return;
    case 'SCOPED_REVISION_TRACE':
      verifyScopedRevisionCertificate(caseId, certificate);
      return;
    case 'RUN_PROJECTION_TRACES':
      verifyRunProjectionCertificate(caseId, certificate);
      return;
    case 'IDEMPOTENT_CREATE_CRASH_TABLE':
      verifyIdempotentCreateCertificate(caseId, certificate);
      return;
    case 'INDISTINGUISHABLE_CRASH_WORLDS':
      verifyIndistinguishableWorldsCertificate(caseId, certificate);
  }
}

function assertCertificateCaseBoundary(caseId: string, certificate: HardPeer80Certificate): void {
  const expectedKinds: Record<string, HardPeer80Certificate['kind']> = {
    'HP80-CAL-MATH-01': 'FORBIDDEN_DIFFERENCE_MATCHING',
    'HP80-CAL-LOGIC-01': 'BOOLEAN_TRUTH_TABLE',
    'HP80-CAL-HIDDEN-01': 'CLOCK_OFFSET_WITNESSES',
    'HP80-CAL-DEBUG-01': 'SCOPED_REVISION_TRACE',
    'HP80-CAL-TECH-01': 'IDEMPOTENT_CREATE_CRASH_TABLE',
    'HP80-EVAL-MATH-01': 'FORBIDDEN_DIFFERENCE_MATCHING',
    'HP80-EVAL-LOGIC-01': 'BOOLEAN_TRUTH_TABLE',
    'HP80-EVAL-HIDDEN-01': 'CONTINGENCY_EXPECTATION_BOUNDS',
    'HP80-EVAL-DEBUG-01': 'RUN_PROJECTION_TRACES',
    'HP80-EVAL-TECH-01': 'INDISTINGUISHABLE_CRASH_WORLDS'
  };
  const expectedKind = expectedKinds[caseId];
  if (!expectedKind) {
    throw new Error(`HARD-PEER-80 certificate references an unknown case: ${caseId}.`);
  }
  if (!certificate || certificate.kind !== expectedKind) {
    throw new Error(
      `HARD-PEER-80 certificate kind does not match ${caseId}: expected ${expectedKind}.`
    );
  }
}

function verifyForbiddenDifferenceCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'FORBIDDEN_DIFFERENCE_MATCHING' }>
): void {
  const expected = caseId === 'HP80-CAL-MATH-01'
    ? {
        universeSize: 26,
        forbiddenDifferences: [4, 7],
        specialElements: [2, 6, 10, 14, 18, 22, 26],
        exactSpecialCount: 3,
        optimum: 13
      }
    : {
        universeSize: 31,
        forbiddenDifferences: [6, 10],
        specialElements: [2, 7, 12, 17, 22, 27],
        exactSpecialCount: 3,
        optimum: 16
      };
  if (
    certificate.universeSize !== expected.universeSize ||
    !sameNumberSet(certificate.forbiddenDifferences, expected.forbiddenDifferences) ||
    !sameNumberSet(certificate.specialElements, expected.specialElements) ||
    certificate.exactSpecialCount !== expected.exactSpecialCount ||
    certificate.optimum !== expected.optimum
  ) {
    throw new Error(`HARD-PEER-80 mathematical certificate targets the wrong problem: ${caseId}.`);
  }
  const construction = new Set(certificate.construction);
  const special = new Set(certificate.specialElements);
  const forbidden = new Set(certificate.forbiddenDifferences);
  const matched = new Set<number>();
  if (
    construction.size !== certificate.optimum ||
    [...construction].some((value) => !Number.isInteger(value) || value < 1 || value > certificate.universeSize) ||
    [...construction].filter((value) => special.has(value)).length !== certificate.exactSpecialCount
  ) {
    throw new Error(`HARD-PEER-80 mathematical construction certificate is invalid: ${caseId}.`);
  }
  for (const left of construction) {
    for (const right of construction) {
      if (left < right && forbidden.has(right - left)) {
        throw new Error(`HARD-PEER-80 construction contains a forbidden difference: ${caseId}.`);
      }
    }
  }
  for (const edge of certificate.upperBoundMatching) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      edge.some((value) => !Number.isInteger(value) || value < 1 || value > certificate.universeSize) ||
      edge.some((value) => matched.has(value)) ||
      !forbidden.has(Math.abs(edge[1] - edge[0]))
    ) {
      throw new Error(`HARD-PEER-80 upper-bound matching certificate is invalid: ${caseId}.`);
    }
    matched.add(edge[0]);
    matched.add(edge[1]);
  }
  const matchingUpperBound = certificate.upperBoundMatching.length +
    (certificate.universeSize - matched.size);
  if (matchingUpperBound !== certificate.optimum) {
    throw new Error(`HARD-PEER-80 matching does not prove the stated optimum: ${caseId}.`);
  }
}

function verifyTruthTableCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'BOOLEAN_TRUTH_TABLE' }>
): void {
  const expectedVariables = caseId === 'HP80-CAL-LOGIC-01'
    ? ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
    : ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'];
  const expectedClassification = caseId === 'HP80-CAL-LOGIC-01' ? 'ENTAILED' : 'OPEN';
  if (
    !sameStrings(certificate.variableOrder, expectedVariables) ||
    certificate.classification !== expectedClassification
  ) {
    throw new Error(`HARD-PEER-80 truth-table certificate targets the wrong query: ${caseId}.`);
  }
  const width = certificate.variableOrder.length;
  const satisfying: string[] = [];
  const queryTrue: string[] = [];
  const queryFalse: string[] = [];
  for (let mask = 0; mask < 2 ** width; mask += 1) {
    const bits = Array.from({ length: width }, (_, index) =>
      Boolean(mask & (1 << (width - index - 1)))
    );
    if (!logicPremises(caseId, bits)) continue;
    const encoded = bits.map((bit) => bit ? '1' : '0').join('');
    satisfying.push(encoded);
    (logicQuery(caseId, bits) ? queryTrue : queryFalse).push(encoded);
  }
  const derivedClassification =
    queryFalse.length === 0 ? 'ENTAILED' : queryTrue.length === 0 ? 'CONTRADICTED' : 'OPEN';
  if (
    !sameStringSet(satisfying, certificate.satisfyingAssignments) ||
    !sameStringSet(queryTrue, certificate.queryTrueAssignments) ||
    !sameStringSet(queryFalse, certificate.queryFalseAssignments) ||
    certificate.classification !== derivedClassification
  ) {
    throw new Error(`HARD-PEER-80 truth-table certificate is invalid: ${caseId}.`);
  }
}

function logicPremises(caseId: string, b: boolean[]): boolean {
  if (caseId === 'HP80-CAL-LOGIC-01') {
    const [A, B, C, D, E, F, G, H, I, J] = b;
    return Number(A) + Number(B) + Number(C) + Number(D) === 2 &&
      E === (A !== C) &&
      F === ((B && !D) || (C && D)) &&
      (!G || E !== F) &&
      H === (G || (A && !F)) &&
      I === (H !== D) &&
      J === ((I && B) || (!H && C)) &&
      Number(E) + Number(F) + Number(G) + Number(I) + Number(J) === 2 &&
      (!A || !B) &&
      (!C || G || J);
  }
  if (caseId === 'HP80-EVAL-LOGIC-01') {
    const [P, Q, R, S, T, U, V, W, X, Y] = b;
    return Number(P) + Number(Q) + Number(R) + Number(S) === 2 &&
      T === (P !== R) &&
      (!U || (Q && !S)) &&
      V === ((T && U) || (S && !Q)) &&
      (!W || V !== R) &&
      (W || U) &&
      (!P || !Q) &&
      X === (P !== V) &&
      Y === ((W && !U) || Q);
  }
  throw new Error(`HARD-PEER-80 has no logic verifier for ${caseId}.`);
}

function logicQuery(caseId: string, b: boolean[]): boolean {
  if (caseId === 'HP80-CAL-LOGIC-01') return b[3] === true && b[5] === false;
  if (caseId === 'HP80-EVAL-LOGIC-01') return !(b[4] && b[9]) || b[1] === true;
  throw new Error(`HARD-PEER-80 has no query verifier for ${caseId}.`);
}

function verifyClockCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'CLOCK_OFFSET_WITNESSES' }>
): void {
  if (
    !sameNumbers(certificate.offsetRange, [-4, 4]) ||
    !sameNumbers(certificate.latencyRange, [1, 5]) ||
    !sameNumbers(certificate.relativeOffsetRange, [2, 6])
  ) {
    throw new Error(`HARD-PEER-80 clock certificate targets the wrong problem: ${caseId}.`);
  }
  const observedClaims = new Set<boolean>();
  for (const world of certificate.worlds) {
    const latency = (31 - world.offsetB) - (24 - world.offsetA);
    const leaseA: [number, number] = [12 - world.offsetA, 26 - world.offsetA];
    const leaseB: [number, number] = [32 - world.offsetB, 46 - world.offsetB];
    const noOverlap = leaseA[1] < leaseB[0] || leaseB[1] < leaseA[0];
    if (
      world.offsetA < certificate.offsetRange[0] ||
      world.offsetA > certificate.offsetRange[1] ||
      world.offsetB < certificate.offsetRange[0] ||
      world.offsetB > certificate.offsetRange[1] ||
      latency !== world.latency ||
      latency < certificate.latencyRange[0] ||
      latency > certificate.latencyRange[1] ||
      !sameNumbers(leaseA, world.leaseAUtc) ||
      !sameNumbers(leaseB, world.leaseBUtc) ||
      noOverlap !== world.claimTrue
    ) {
      throw new Error(`HARD-PEER-80 clock witness is invalid: ${caseId}/${world.name}.`);
    }
    observedClaims.add(noOverlap);
  }
  if (observedClaims.size !== 2) {
    throw new Error(`HARD-PEER-80 clock certificate does not prove OPEN: ${caseId}.`);
  }
}

function verifyContingencyCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'CONTINGENCY_EXPECTATION_BOUNDS' }>
): void {
  if (
    certificate.population !== 100 ||
    certificate.initialPositive !== 30 ||
    certificate.flagged !== 35 ||
    certificate.repairProbability !== 0.8 ||
    certificate.damageProbability !== 0.2
  ) {
    throw new Error(`HARD-PEER-80 contingency certificate targets the wrong problem: ${caseId}.`);
  }
  const lower = Math.max(0, certificate.initialPositive + certificate.flagged - certificate.population);
  const upper = Math.min(certificate.initialPositive, certificate.flagged);
  const finalAt = (intersection: number): number =>
    certificate.initialPositive - certificate.repairProbability * intersection +
    certificate.damageProbability * (certificate.flagged - intersection);
  const values = Array.from({ length: upper - lower + 1 }, (_, index) => finalAt(lower + index));
  const range: [number, number] = [Math.min(...values), Math.max(...values)];
  const firstImprovement = Array.from({ length: upper - lower + 1 }, (_, index) => lower + index)
    .find((intersection) => finalAt(intersection) < certificate.initialPositive);
  if (
    !sameNumbers(certificate.intersectionRange, [lower, upper]) ||
    certificate.finalExpectationIntercept !== finalAt(0) ||
    certificate.finalExpectationSlope !== finalAt(1) - finalAt(0) ||
    !sameNumbers(certificate.finalExpectationRange, range) ||
    certificate.strictImprovementMinimumIntegerIntersection !== firstImprovement
  ) {
    throw new Error(`HARD-PEER-80 contingency bound is invalid: ${caseId}.`);
  }
  for (const table of certificate.witnessTables) {
    if (
      table.intersection + table.flaggedGood !== certificate.flagged ||
      table.intersection + table.unflaggedDefective !== certificate.initialPositive ||
      table.intersection + table.flaggedGood + table.unflaggedDefective + table.unflaggedGood !==
        certificate.population ||
      table.finalExpectation !== finalAt(table.intersection)
    ) {
      throw new Error(`HARD-PEER-80 contingency witness is invalid: ${caseId}.`);
    }
  }
}

function verifyScopedRevisionCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'SCOPED_REVISION_TRACE' }>
): void {
  const expectedUpdates = [
    { session: 'S1', item: 'x', revision: '9', state: 'open' },
    { session: 'S2', item: 'x', revision: '99', state: 'done' },
    { session: 'S1', item: 'x', revision: '10', state: 'done' },
    { session: 'S1', item: 'y', revision: '1', state: 'done' }
  ];
  if (
    certificate.requestedSession !== 'S1' ||
    JSON.stringify(certificate.updates) !== JSON.stringify(expectedUpdates)
  ) {
    throw new Error(`HARD-PEER-80 scoped-revision certificate targets the wrong trace: ${caseId}.`);
  }
  const current = new Map<string, (typeof certificate.updates)[number]>();
  for (const update of certificate.updates) {
    const previous = current.get(update.item);
    if (!previous || update.revision > previous.revision) current.set(update.item, update);
  }
  const currentOutput = [...current.values()]
    .filter((update) => update.session === certificate.requestedSession && update.state === 'done')
    .map((update) => update.item)
    .sort();
  const required = new Map<string, (typeof certificate.updates)[number]>();
  for (const update of certificate.updates) {
    if (update.session !== certificate.requestedSession) continue;
    const previous = required.get(update.item);
    if (!previous || BigInt(update.revision) > BigInt(previous.revision)) {
      required.set(update.item, update);
    }
  }
  const requiredOutput = [...required.values()]
    .filter((update) => update.state === 'done')
    .map((update) => update.item)
    .sort();
  if (
    !sameStrings(currentOutput, certificate.currentOutput) ||
    !sameStrings(requiredOutput, certificate.requiredOutput) ||
    certificate.repair.scopeUpdatesToRequestedSessionBeforeLatestSelection !== true ||
    certificate.repair.compareRevisionsAsExactNonnegativeIntegers !== true
  ) {
    throw new Error(`HARD-PEER-80 scoped-revision certificate is invalid: ${caseId}.`);
  }
}

function verifyRunProjectionCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'RUN_PROJECTION_TRACES' }>
): void {
  const expectedTraces = [
    {
      name: 'A',
      events: [
        ['X', 40, 'process-exit'],
        ['Y', 1, 'provider-completed'],
        ['Y', 2, 'process-exit'],
        ['Y', 3, 'report-verified']
      ]
    },
    {
      name: 'B',
      events: [['Y', 1, 'provider-completed'], ['Y', 2, 'process-exit']]
    },
    {
      name: 'C',
      events: [['Y', 1, 'process-exit'], ['Y', 2, 'report-verified']]
    }
  ];
  if (
    certificate.activeRunId !== 'Y' ||
    certificate.traces.length !== expectedTraces.length ||
    expectedTraces.some((expected) => {
      const actual = certificate.traces.find((trace) => trace.name === expected.name);
      return !actual || JSON.stringify(actual.events) !== JSON.stringify(expected.events);
    })
  ) {
    throw new Error(`HARD-PEER-80 projection certificate targets the wrong traces: ${caseId}.`);
  }
  for (const trace of certificate.traces) {
    if (
      currentProjection(certificate.activeRunId, trace.events) !== trace.current ||
      requiredProjection(certificate.activeRunId, trace.events) !== trace.required
    ) {
      throw new Error(`HARD-PEER-80 projection trace is invalid: ${caseId}/${trace.name}.`);
    }
  }
  if (
    certificate.repair.scopeOrdinalFilteringToActiveRun !== true ||
    certificate.repair.treatProviderCompletionAsTelemetryOnly !== true ||
    certificate.repair.deriveStatusAfterEvidenceAccumulation !== true
  ) {
    throw new Error(`HARD-PEER-80 projection repair certificate is incomplete: ${caseId}.`);
  }
}

function currentProjection(
  active: string,
  events: Extract<HardPeer80Certificate, { kind: 'RUN_PROJECTION_TRACES' }>['traces'][number]['events']
): 'running' | 'interrupted' | 'completed' {
  let lastOrdinal = 0;
  let providerDone = false;
  let status: 'running' | 'interrupted' | 'completed' = 'running';
  for (const [runId, ordinal, kind] of events) {
    if (ordinal <= lastOrdinal) continue;
    lastOrdinal = ordinal;
    if (runId !== active) continue;
    if (kind === 'provider-completed') providerDone = true;
    else if (kind === 'process-exit' && !providerDone) status = 'interrupted';
    else if (kind === 'report-verified' && status === 'running') status = 'completed';
  }
  return status;
}

function requiredProjection(
  active: string,
  events: Extract<HardPeer80Certificate, { kind: 'RUN_PROJECTION_TRACES' }>['traces'][number]['events']
): 'running' | 'interrupted' | 'completed' {
  let sawExit = false;
  let sawVerified = false;
  for (const [runId, , kind] of events) {
    if (runId !== active) continue;
    if (kind === 'process-exit') sawExit = true;
    if (kind === 'report-verified') sawVerified = true;
  }
  return sawVerified ? 'completed' : sawExit ? 'interrupted' : 'running';
}

function verifyIdempotentCreateCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'IDEMPOTENT_CREATE_CRASH_TABLE' }>
): void {
  if (
    certificate.durableKeyBeforeCall !== true ||
    certificate.sameKeyOnRecovery !== true ||
    certificate.providerIdempotentByKey !== true ||
    certificate.providerLookupByKey !== true ||
    certificate.workflowRequiresLocalVerification !== true
  ) {
    throw new Error(`HARD-PEER-80 idempotent-create certificate is invalid: ${caseId}.`);
  }
  const expectedProgressStates = new Set(['000', '100', '110', '111']);
  const observedProgressStates = new Set<string>();
  for (const scenario of certificate.crashScenarios) {
    const progressState = [
      scenario.providerCreateAppliedBeforeCrash,
      scenario.createReplyReceivedBeforeCrash,
      scenario.remoteIdPersistedBeforeCrash
    ].map((value) => value ? '1' : '0').join('');
    if (
      !expectedProgressStates.has(progressState) ||
      observedProgressStates.has(progressState) ||
      scenario.recoveryContactsProvider !== !scenario.remoteIdPersistedBeforeCrash ||
      scenario.recoveryUsesPersistedKey !== true ||
      scenario.atMostOneRemoteTurn !== true ||
      scenario.remoteIdEventuallyRecoverable !== true
    ) {
      throw new Error(`HARD-PEER-80 idempotent-create crash scenario is invalid: ${caseId}.`);
    }
    observedProgressStates.add(progressState);
  }
  if (
    observedProgressStates.size !== expectedProgressStates.size ||
    [...expectedProgressStates].some((state) => !observedProgressStates.has(state))
  ) {
    throw new Error(`HARD-PEER-80 idempotent-create crash scenarios are incomplete: ${caseId}.`);
  }
}

function verifyIndistinguishableWorldsCertificate(
  caseId: string,
  certificate: Extract<HardPeer80Certificate, { kind: 'INDISTINGUISHABLE_CRASH_WORLDS' }>
): void {
  const worldNames = new Set(certificate.worlds.map(({ name }) => name));
  const choiceNames = new Set(certificate.recoveryChoices.map(({ choice }) => choice));
  const applied = certificate.worlds.find((world) => world.providerAppliedCount === 1);
  const lost = certificate.worlds.find((world) => world.providerAppliedCount === 0);
  const sends = certificate.recoveryChoices.find((choice) => choice.sendsInterrupt);
  const doesNotSend = certificate.recoveryChoices.find((choice) => !choice.sendsInterrupt);
  const sendsWorld = certificate.worlds.find(({ name }) => name === sends?.world);
  const doesNotSendWorld = certificate.worlds.find(({ name }) => name === doesNotSend?.world);
  if (
    certificate.worlds.length !== 2 ||
    worldNames.size !== 2 ||
    certificate.worlds.some(({ name, durableLocalState, providerAppliedCount }) =>
      !name.trim() || !durableLocalState.trim() || ![0, 1].includes(providerAppliedCount)
    ) ||
    !applied ||
    !lost ||
    applied.durableLocalState !== lost.durableLocalState ||
    certificate.recoveryChoices.length !== 2 ||
    choiceNames.size !== 2 ||
    certificate.recoveryChoices.some(({ choice, world }) =>
      !choice.trim() || !worldNames.has(world)
    ) ||
    sends?.violates !== 'SAFETY' ||
    sendsWorld?.providerAppliedCount !== 1 ||
    doesNotSend?.violates !== 'LIVENESS' ||
    doesNotSendWorld?.providerAppliedCount !== 0
  ) {
    throw new Error(`HARD-PEER-80 indistinguishability certificate is invalid: ${caseId}.`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read HARD-PEER-80 ${label} ${filePath}: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in HARD-PEER-80 ${label} ${filePath}: ${String(error)}`);
  }
}
