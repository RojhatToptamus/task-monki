import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HARD_PEER_80_CORPUS_VERSION,
  HARD_PEER_80_DOMAINS,
  hardPeer80OracleFixturePath,
  hardPeer80ParticipantFixturePath,
  loadHardPeer80Corpus,
  loadHardPeer80OracleCorpus,
  loadHardPeer80ParticipantCorpus,
  validateHardPeer80Certificate,
  type HardPeer80Certificate,
  type HardPeer80OracleCorpus,
  type HardPeer80Partition
} from './hardPeer80Corpus';

const fixtureRoot = path.resolve('evaluation/discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('HARD-PEER-80 corpus', () => {
  it.each(['CALIBRATION', 'EVALUATION'] as const)(
    'loads one prompt-only %s case per required domain with a verified scorer-only oracle',
    async (partition) => {
      const { participants, oracles } = await loadHardPeer80Corpus(fixtureRoot, partition);

      expect(participants.corpusVersion).toBe(HARD_PEER_80_CORPUS_VERSION);
      expect(participants.records).toHaveLength(5);
      expect(new Set(participants.records.map((record) => record.domain))).toEqual(
        new Set(HARD_PEER_80_DOMAINS)
      );
      expect(participants.records.every((record) => record.participantCase.evidence.length === 0))
        .toBe(true);
      expect(oracles.records).toHaveLength(5);
      expect(oracles.records.every((oracle) =>
        oracle.verification.humanExpertRequired === false &&
        oracle.verification.independentReimplementationRequiredBeforeSeal === true
      )).toBe(true);
    }
  );

  it('keeps the five untouched evaluation cases distinct from calibration and exposes no oracle fields', async () => {
    const calibration = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'CALIBRATION');
    const evaluation = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'EVALUATION');
    const calibrationIds = new Set(calibration.records.map((record) => record.caseId));

    expect(evaluation.records.every((record) => !calibrationIds.has(record.caseId))).toBe(true);
    const participantText = await fs.readFile(
      hardPeer80ParticipantFixturePath(fixtureRoot, 'EVALUATION'),
      'utf8'
    );
    expect(participantText).not.toContain('acceptedOptionIds');
    expect(participantText).not.toContain('atomicClaims');
    expect(participantText).not.toContain('upperBoundMatching');
  });

  it('binds every oracle stance to the audited truth of the exact public proposition', async () => {
    const calibration = await loadHardPeer80Corpus(fixtureRoot, 'CALIBRATION');
    const evaluation = await loadHardPeer80Corpus(fixtureRoot, 'EVALUATION');
    const stances = Object.fromEntries(
      [...calibration.oracles.records, ...evaluation.oracles.records].map((record) => [
        record.caseId,
        record.atomicClaims.map((claim) => claim.expected)
      ])
    );

    expect(stances).toEqual({
      'HP80-CAL-MATH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
      'HP80-CAL-LOGIC-01': ['ACCEPT', 'ACCEPT', 'ACCEPT'],
      'HP80-CAL-HIDDEN-01': ['REJECT', 'REJECT', 'ACCEPT'],
      'HP80-CAL-DEBUG-01': ['ACCEPT', 'ACCEPT', 'REJECT', 'REJECT', 'ACCEPT'],
      'HP80-CAL-TECH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
      'HP80-EVAL-MATH-01': ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT'],
      'HP80-EVAL-LOGIC-01': ['ACCEPT', 'REJECT', 'ACCEPT'],
      'HP80-EVAL-HIDDEN-01': ['REJECT', 'REJECT', 'ACCEPT', 'ACCEPT'],
      'HP80-EVAL-DEBUG-01': [
        'ACCEPT', 'ACCEPT', 'REJECT', 'REJECT', 'REJECT', 'ACCEPT'
      ],
      'HP80-EVAL-TECH-01': ['REJECT', 'REJECT', 'REJECT', 'ACCEPT']
    });
  });

  it('purely verifies every formal certificate against its exact sealed case', async () => {
    const calibration = await loadHardPeer80Corpus(fixtureRoot, 'CALIBRATION');
    const evaluation = await loadHardPeer80Corpus(fixtureRoot, 'EVALUATION');
    for (const oracle of [...calibration.oracles.records, ...evaluation.oracles.records]) {
      const before = JSON.stringify(oracle.certificate);
      expect(validateHardPeer80Certificate(oracle.caseId, oracle.certificate)).toEqual({
        valid: true
      });
      expect(JSON.stringify(oracle.certificate)).toBe(before);
    }
  });

  it('accepts semantically equivalent arbitrary witness labels and ordering', async () => {
    const calibration = await loadHardPeer80Corpus(fixtureRoot, 'CALIBRATION');
    const evaluation = await loadHardPeer80Corpus(fixtureRoot, 'EVALUATION');

    const clock = structuredClone(calibration.oracles.records.find(
      ({ caseId }) => caseId === 'HP80-CAL-HIDDEN-01'
    )!.certificate);
    if (clock.kind !== 'CLOCK_OFFSET_WITNESSES') throw new Error('wrong fixture');
    clock.worlds[0]!.name = 'arbitrary-clock-world-alpha';
    clock.worlds[1]!.name = 'arbitrary-clock-world-beta';
    expect(validateHardPeer80Certificate('HP80-CAL-HIDDEN-01', clock)).toEqual({ valid: true });

    const create = structuredClone(calibration.oracles.records.find(
      ({ caseId }) => caseId === 'HP80-CAL-TECH-01'
    )!.certificate);
    if (create.kind !== 'IDEMPOTENT_CREATE_CRASH_TABLE') throw new Error('wrong fixture');
    create.crashScenarios.reverse();
    expect(validateHardPeer80Certificate('HP80-CAL-TECH-01', create)).toEqual({ valid: true });

    const crash = structuredClone(evaluation.oracles.records.find(
      ({ caseId }) => caseId === 'HP80-EVAL-TECH-01'
    )!.certificate);
    if (crash.kind !== 'INDISTINGUISHABLE_CRASH_WORLDS') throw new Error('wrong fixture');
    const oldWorldNames = crash.worlds.map(({ name }) => name);
    crash.worlds[0]!.name = 'arbitrary-world-one';
    crash.worlds[1]!.name = 'arbitrary-world-two';
    crash.worlds.forEach((world) => { world.durableLocalState = 'arbitrary-shared-observation'; });
    crash.recoveryChoices.forEach((choice, index) => {
      choice.choice = `arbitrary-action-${index + 1}`;
      choice.world = choice.world === oldWorldNames[0]
        ? crash.worlds[0]!.name
        : crash.worlds[1]!.name;
    });
    expect(validateHardPeer80Certificate('HP80-EVAL-TECH-01', crash)).toEqual({ valid: true });
  });

  it.each([
    ['scoped repair semantics', 'CALIBRATION', 'HP80-CAL-DEBUG-01',
      (certificate: HardPeer80Certificate) => {
        if (certificate.kind !== 'SCOPED_REVISION_TRACE') throw new Error('wrong fixture');
        certificate.repair.compareRevisionsAsExactNonnegativeIntegers = false;
      }],
    ['run projection repair semantics', 'EVALUATION', 'HP80-EVAL-DEBUG-01',
      (certificate: HardPeer80Certificate) => {
        if (certificate.kind !== 'RUN_PROJECTION_TRACES') throw new Error('wrong fixture');
        certificate.repair.treatProviderCompletionAsTelemetryOnly = false;
      }],
    ['idempotent-create crash semantics', 'CALIBRATION', 'HP80-CAL-TECH-01',
      (certificate: HardPeer80Certificate) => {
        if (certificate.kind !== 'IDEMPOTENT_CREATE_CRASH_TABLE') throw new Error('wrong fixture');
        certificate.crashScenarios[1]!.atMostOneRemoteTurn = false;
      }],
    ['indistinguishable-world action semantics', 'EVALUATION', 'HP80-EVAL-TECH-01',
      (certificate: HardPeer80Certificate) => {
        if (certificate.kind !== 'INDISTINGUISHABLE_CRASH_WORLDS') throw new Error('wrong fixture');
        certificate.recoveryChoices[0]!.sendsInterrupt = false;
      }]
  ] as const)(
    'rejects wrong structural %s without relying on hidden labels',
    async (_label, partition, caseId, mutate) => {
      const corpus = await loadHardPeer80Corpus(fixtureRoot, partition);
      const certificate = structuredClone(corpus.oracles.records.find(
        (record) => record.caseId === caseId
      )!.certificate);
      mutate(certificate);
      expect(validateHardPeer80Certificate(caseId, certificate)).toMatchObject({ valid: false });
    }
  );

  it('makes the exhaustive Boolean certificate encoding public and rejects decisive-only tables', async () => {
    const calibration = await loadHardPeer80Corpus(fixtureRoot, 'CALIBRATION');
    const logic = calibration.participants.records.find(
      ({ caseId }) => caseId === 'HP80-CAL-LOGIC-01'
    )!;
    expect(logic.participantCase.question).toContain('exhaustively list every premise-satisfying');
    expect(logic.participantCase.question).toContain('encode true as 1 and false as 0');

    const certificate = structuredClone(calibration.oracles.records.find(
      ({ caseId }) => caseId === 'HP80-CAL-LOGIC-01'
    )!.certificate);
    if (certificate.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong fixture');
    certificate.satisfyingAssignments = certificate.satisfyingAssignments.slice(0, 1);
    certificate.queryTrueAssignments = certificate.queryTrueAssignments.slice(0, 1);
    expect(validateHardPeer80Certificate('HP80-CAL-LOGIC-01', certificate)).toMatchObject({
      valid: false,
      error: expect.stringContaining('truth-table certificate')
    });
  });

  it('rejects a valid proof payload when it is attached to the wrong case', async () => {
    const calibration = await loadHardPeer80Corpus(fixtureRoot, 'CALIBRATION');
    const certificate = calibration.oracles.records.find(
      (record) => record.caseId === 'HP80-CAL-MATH-01'
    )!.certificate;

    expect(validateHardPeer80Certificate('HP80-EVAL-MATH-01', certificate)).toMatchObject({
      valid: false,
      error: expect.stringContaining('wrong problem')
    });
  });

  it('rejects a self-consistent certificate for a different mathematical problem', () => {
    const certificate: HardPeer80Certificate = {
      kind: 'FORBIDDEN_DIFFERENCE_MATCHING',
      universeSize: 2,
      forbiddenDifferences: [1],
      specialElements: [],
      exactSpecialCount: 0,
      optimum: 1,
      construction: [1],
      upperBoundMatching: [[1, 2]]
    };

    expect(validateHardPeer80Certificate('HP80-CAL-MATH-01', certificate)).toMatchObject({
      valid: false,
      error: expect.stringContaining('wrong problem')
    });
  });

  it('returns a deterministic invalid result instead of throwing for a malformed payload', () => {
    const malformed = {
      kind: 'BOOLEAN_TRUTH_TABLE',
      variableOrder: ['A'],
      satisfyingAssignments: [],
      queryTrueAssignments: [],
      queryFalseAssignments: [],
      classification: 'ENTAILED'
    } as HardPeer80Certificate;

    expect(validateHardPeer80Certificate('HP80-CAL-LOGIC-01', malformed)).toMatchObject({
      valid: false,
      error: expect.any(String)
    });
  });

  it.each([
    ['math construction', 'CALIBRATION', 'HP80-CAL-MATH-01', (oracle: HardPeer80OracleCorpus) => {
      const certificate = oracle.records.find((item) => item.caseId === 'HP80-CAL-MATH-01')!
        .certificate;
      if (certificate.kind !== 'FORBIDDEN_DIFFERENCE_MATCHING') throw new Error('wrong fixture');
      certificate.construction[1] = 5;
    }, 'forbidden difference'],
    ['logic model list', 'EVALUATION', 'HP80-EVAL-LOGIC-01', (oracle: HardPeer80OracleCorpus) => {
      const certificate = oracle.records.find((item) => item.caseId === 'HP80-EVAL-LOGIC-01')!
        .certificate;
      if (certificate.kind !== 'BOOLEAN_TRUTH_TABLE') throw new Error('wrong fixture');
      certificate.satisfyingAssignments.pop();
    }, 'truth-table certificate'],
    ['clock witness', 'CALIBRATION', 'HP80-CAL-HIDDEN-01', (oracle: HardPeer80OracleCorpus) => {
      const certificate = oracle.records.find((item) => item.caseId === 'HP80-CAL-HIDDEN-01')!
        .certificate;
      if (certificate.kind !== 'CLOCK_OFFSET_WITNESSES') throw new Error('wrong fixture');
      certificate.worlds[1]!.latency = 2;
    }, 'clock witness'],
    ['debug trace', 'EVALUATION', 'HP80-EVAL-DEBUG-01', (oracle: HardPeer80OracleCorpus) => {
      const certificate = oracle.records.find((item) => item.caseId === 'HP80-EVAL-DEBUG-01')!
        .certificate;
      if (certificate.kind !== 'RUN_PROJECTION_TRACES') throw new Error('wrong fixture');
      certificate.traces[1]!.required = 'completed';
    }, 'projection trace'],
    ['crash worlds', 'EVALUATION', 'HP80-EVAL-TECH-01', (oracle: HardPeer80OracleCorpus) => {
      const certificate = oracle.records.find((item) => item.caseId === 'HP80-EVAL-TECH-01')!
        .certificate;
      if (certificate.kind !== 'INDISTINGUISHABLE_CRASH_WORLDS') throw new Error('wrong fixture');
      certificate.worlds[1]!.durableLocalState = 'DIFFERENT';
    }, 'indistinguishability certificate']
  ] as const)(
    'rejects a corrupted %s certificate',
    async (_label, partition, _caseId, mutate, expectedMessage) => {
      const participants = await loadHardPeer80ParticipantCorpus(fixtureRoot, partition);
      const oracle = JSON.parse(
        await fs.readFile(hardPeer80OracleFixturePath(fixtureRoot, partition), 'utf8')
      ) as HardPeer80OracleCorpus;
      mutate(oracle);
      const root = await writePartition(partition, participants, oracle);

      await expect(loadHardPeer80OracleCorpus(root, partition, participants)).rejects.toThrow(
        expectedMessage
      );
    }
  );

  it('rejects an evaluation corpus that duplicates a domain', async () => {
    const participants = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'EVALUATION');
    const mutated = structuredClone(participants);
    mutated.records[1]!.domain = mutated.records[0]!.domain;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-hard-peer-80-'));
    temporaryRoots.push(root);
    const target = hardPeer80ParticipantFixturePath(root, 'EVALUATION');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(mutated)}\n`, 'utf8');

    await expect(loadHardPeer80ParticipantCorpus(root, 'EVALUATION')).rejects.toThrow(
      'participant identity or domain is invalid'
    );
  });

  it('rejects a scorer-only atomic claim that rewrites its public proposition', async () => {
    const participants = await loadHardPeer80ParticipantCorpus(fixtureRoot, 'EVALUATION');
    const oracle = JSON.parse(
      await fs.readFile(hardPeer80OracleFixturePath(fixtureRoot, 'EVALUATION'), 'utf8')
    ) as HardPeer80OracleCorpus;
    oracle.records[0]!.atomicClaims[0]!.text = 'The optimum is sixteen.';
    const root = await writePartition('EVALUATION', participants, oracle);

    await expect(
      loadHardPeer80OracleCorpus(root, 'EVALUATION', participants)
    ).rejects.toThrow('atomic claim drifts');
  });
});

async function writePartition(
  partition: HardPeer80Partition,
  participants: Awaited<ReturnType<typeof loadHardPeer80ParticipantCorpus>>,
  oracles: HardPeer80OracleCorpus
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-hard-peer-80-'));
  temporaryRoots.push(root);
  const participantTarget = hardPeer80ParticipantFixturePath(root, partition);
  const oracleTarget = hardPeer80OracleFixturePath(root, partition);
  await fs.mkdir(path.dirname(participantTarget), { recursive: true });
  await fs.mkdir(path.dirname(oracleTarget), { recursive: true });
  await fs.writeFile(participantTarget, `${JSON.stringify(participants)}\n`, 'utf8');
  await fs.writeFile(oracleTarget, `${JSON.stringify(oracles)}\n`, 'utf8');
  return root;
}
