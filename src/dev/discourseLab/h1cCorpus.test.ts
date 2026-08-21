import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  h1cOracleFixturePath,
  h1cParticipantFixturePath,
  loadH1cOracleCorpus,
  loadH1cParticipantCorpus,
  type H1cOracleCorpus,
  type H1cParticipantCorpus
} from './h1cCorpus';

const fixtureRoot = path.resolve('evaluation/discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('H1c sealed development corpus', () => {
  it('loads four held-out cases with empty case evidence and keeps matched critique controls on the same target', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracles = await loadH1cOracleCorpus(fixtureRoot, participants);

    expect(participants.records).toHaveLength(4);
    expect(participants.records.map((record) => record.participantCase.evidence)).toEqual([
      [], [], [], []
    ]);
    expect(oracles.records).toHaveLength(4);
    for (const record of participants.records.filter(
      (item) => item.stratum === 'DERIVABLE_CRITIQUE'
    )) {
      expect(record.placeboCritique).toMatchObject({
        targetPropositionId: record.validCritique!.targetPropositionId,
        issueKind: record.validCritique!.issueKind,
        severity: record.validCritique!.severity,
        containsNewFacts: false
      });
      const oracle = oracles.records.find((item) => item.caseId === record.caseId)!;
      expect(oracle.issueOracles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          issueId: record.validCritique!.issueId,
          artifactId: record.validCritique!.artifactId,
          targetPropositionId: record.validCritique!.targetPropositionId,
          truth: 'VALID_IF_TARGET_DRAFT_WRONG'
        }),
        expect.objectContaining({
          issueId: record.placeboCritique!.issueId,
          artifactId: record.placeboCritique!.artifactId,
          targetPropositionId: record.placeboCritique!.targetPropositionId,
          truth: 'FALSE_OR_IRRELEVANT'
        })
      ]));
    }
  });

  it('rejects a placebo whose target differs from the valid critique', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const mutated = structuredClone(participants) as H1cParticipantCorpus;
    const derivable = mutated.records.find((item) => item.caseId === 'H1C-D5')!;
    derivable.placeboCritique!.targetPropositionId = 'h1c-d5-p4';

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-corpus-'));
    temporaryRoots.push(root);
    const target = h1cParticipantFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(mutated)}\n`, 'utf8');

    await expect(loadH1cParticipantCorpus(root)).rejects.toThrow(
      'must match target, kind, and severity'
    );
  });

  it.each(['CASE', 'PROMPT', 'DRAFT'] as const)(
    'rejects the reserved participant identifier %s',
    async (reservedId) => {
      const participants = await loadH1cParticipantCorpus(fixtureRoot);
      const mutated = structuredClone(participants) as H1cParticipantCorpus;
      mutated.records[0]!.participantCase.options[0]!.id = reservedId;

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-reserved-id-'));
      temporaryRoots.push(root);
      const target = h1cParticipantFixturePath(root);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(mutated)}\n`, 'utf8');

      await expect(loadH1cParticipantCorpus(root)).rejects.toThrow(
        `collides with reserved identifier ${reservedId}`
      );
    }
  );

  it.each([
    ['artifact id', (oracle: H1cOracleCorpus) => {
      const record = oracle.records.find((item) => item.caseId === 'H1C-D5')!;
      const valid = record.issueOracles.find(
        (issue) => issue.truth === 'VALID_IF_TARGET_DRAFT_WRONG'
      )!;
      valid.artifactId = 'h1c-d5-review-b';
    }],
    ['target proposition id', (oracle: H1cOracleCorpus) => {
      const record = oracle.records.find((item) => item.caseId === 'H1C-D5')!;
      const valid = record.issueOracles.find(
        (issue) => issue.truth === 'VALID_IF_TARGET_DRAFT_WRONG'
      )!;
      valid.targetPropositionId = 'h1c-d5-p2';
    }]
  ] as const)('rejects an oracle critique with a mismatched %s', async (_label, mutate) => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    mutate(oracle);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-oracle-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).rejects.toThrow(
      'controlled-critique oracle is invalid'
    );
  });

  it('rejects required evidence omitted from an exhaustive allowed list', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    const record = oracle.records.find((item) => item.caseId === 'H1C-D5')!;
    const claim = record.baseProfile.claims.find(
      (item) => item.propositionId === 'h1c-d5-p1'
    )!;
    expect(claim.requiredEvidenceAlternatives[0]).toEqual([
      { evidenceId: 'PROMPT', relation: 'SUPPORTS' }
    ]);
    claim.allowedEvidenceReferences = [];

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-oracle-policy-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).rejects.toThrow(
      'oracle profile is invalid'
    );
  });

  it('requires the rule-bearing prompt and the new packet jointly for each resolved target', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = await loadH1cOracleCorpus(fixtureRoot, participants);
    for (const caseId of ['H1C-E5', 'H1C-E6']) {
      const participant = participants.records.find((record) => record.caseId === caseId)!;
      const record = oracle.records.find((candidate) => candidate.caseId === caseId)!;
      const target = record.treatmentProfile.claims.find(
        (claim) => claim.propositionId === record.targetPropositionIds[0]
      )!;
      expect(target.requiredEvidenceAlternatives).toHaveLength(1);
      expect(new Set(target.requiredEvidenceAlternatives[0]!.map(
        (reference) => reference.evidenceId
      ))).toEqual(new Set(['PROMPT', participant.decisiveEvidence!.evidenceId]));
    }
  });

  it('accepts a request target set that contains every required target within a wider allowed set', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    const request = oracle.records.find((item) => item.caseId === 'H1C-E5')!
      .baseProfile.informationRequest!;
    request.allowedPropositionIds = ['h1c-e5-p1', 'h1c-e5-p5'];

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-request-policy-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).resolves.toMatchObject({
      corpusVersion: 'h1c-assay-corpus@v3'
    });
  });

  it('rejects a request allow-list that omits a required proposition target', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    const request = oracle.records.find((item) => item.caseId === 'H1C-E5')!
      .baseProfile.informationRequest!;
    request.allowedPropositionIds = ['h1c-e5-p5'];

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-request-policy-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).rejects.toThrow(
      'information-request oracle is invalid'
    );
  });

  it('rejects an empty required request-target set', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    oracle.records.find((item) => item.caseId === 'H1C-E6')!
      .baseProfile.informationRequest!.requiredPropositionIds = [];

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-request-policy-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).rejects.toThrow(
      'information-request oracle is invalid'
    );
  });

  it('accepts null request and evidence allow-lists as explicitly unadjudicated extras', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const oracle = JSON.parse(
      await fs.readFile(h1cOracleFixturePath(fixtureRoot), 'utf8')
    ) as H1cOracleCorpus;
    const record = oracle.records.find((item) => item.caseId === 'H1C-E5')!;
    record.baseProfile.informationRequest!.allowedPropositionIds = null;
    expect(record.treatmentProfile.claims.find(
      (claim) => claim.propositionId === 'h1c-e5-p1'
    )!.allowedEvidenceReferences).toBeNull();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-null-policy-'));
    temporaryRoots.push(root);
    const target = h1cOracleFixturePath(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(oracle)}\n`, 'utf8');

    await expect(loadH1cOracleCorpus(root, participants)).resolves.toMatchObject({
      corpusVersion: 'h1c-assay-corpus@v3'
    });
  });
});
