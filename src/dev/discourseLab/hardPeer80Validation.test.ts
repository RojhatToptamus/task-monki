import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHardPeer80ParticipantCorpus } from './hardPeer80Corpus';
import { buildHardPeer80Plan } from './hardPeer80Plan';
import { sha256File, stableJson } from './ledger';
import {
  HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION,
  HARD_PEER_80_PREREGISTRATION_VERSION,
  HARD_PEER_80_SEAL_VERSION,
  buildHardPeer80SealedPlan,
  loadHardPeer80SealedPlan,
  persistHardPeer80SealedPlan,
  validateHardPeer80Inputs,
  type HardPeer80H0Receipt
} from './hardPeer80Validation';

const repositoryFixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('HARD-PEER-80 sealed input validation', () => {
  it('binds exactly five audience-mapped inputs and the transitive source closure', async () => {
    const fixture = await createSealedFixture();
    const validation = await validateHardPeer80Inputs(fixture.fixtureRoot, {
      projectRoot: fixture.projectRoot,
      sourceEntryFiles: ['src/entry.ts']
    });

    expect(validation.valid).toBe(true);
    expect(validation.verifiedFiles).toHaveLength(5);
    expect(validation.verifiedFiles.filter(({ audience }) => audience === 'PARTICIPANT'))
      .toHaveLength(2);
    expect(validation.verifiedFiles.filter(({ audience }) => audience === 'SCORER_ONLY'))
      .toHaveLength(2);
    expect(validation.sourceLock.entryFiles).toEqual(['src/entry.ts']);
    expect(validation.sourceLock.sourceFiles).toEqual(['src/dep.ts', 'src/entry.ts']);
    expect(validation.locks.participantCorpusSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(validation.locks.oracleCorpusSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed on content drift and audience swaps', async () => {
    const drifted = await createSealedFixture();
    await fs.appendFile(
      path.join(
        drifted.fixtureRoot,
        'corpus',
        'hard-peer-80-v1',
        'participants',
        'evaluation.json'
      ),
      '\n'
    );
    await expect(validateHardPeer80Inputs(drifted.fixtureRoot, {
      projectRoot: drifted.projectRoot,
      sourceEntryFiles: ['src/entry.ts']
    })).rejects.toThrow('input changed');

    const swapped = await createSealedFixture();
    const sealPath = path.join(swapped.fixtureRoot, 'seal-hard-peer-80-v1.json');
    const seal = JSON.parse(await fs.readFile(sealPath, 'utf8')) as {
      files: Array<{ audience: string }>;
    };
    seal.files[0]!.audience = 'SCORER_ONLY';
    await fs.writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
    await expect(validateHardPeer80Inputs(swapped.fixtureRoot, {
      projectRoot: swapped.projectRoot,
      sourceEntryFiles: ['src/entry.ts']
    })).rejects.toThrow('map exactly');
  });

  it('persists and reloads one content-addressed plan wrapper bound to H0 and active locks', async () => {
    const fixture = await createSealedFixture();
    const validation = await validateHardPeer80Inputs(fixture.fixtureRoot, {
      projectRoot: fixture.projectRoot,
      sourceEntryFiles: ['src/entry.ts']
    });
    const calibration = await loadHardPeer80ParticipantCorpus(fixture.fixtureRoot, 'CALIBRATION');
    const evaluation = await loadHardPeer80ParticipantCorpus(fixture.fixtureRoot, 'EVALUATION');
    const plan = buildHardPeer80Plan({
      calibrationCaseIds: calibration.records.map(({ caseId }) => caseId),
      evaluationCaseIds: evaluation.records.map(({ caseId }) => caseId),
      createdAt: '2026-08-03T12:00:00.000Z'
    });
    const receipt: HardPeer80H0Receipt = {
      schemaVersion: HARD_PEER_80_H0_RECEIPT_SCHEMA_VERSION,
      validationVersion: 'hard-peer-80-h0-validation@v2',
      runId: 'hard-peer-80-h0-test',
      status: 'PASSED',
      manifestSha256: 'a'.repeat(64),
      reportSha256: 'b'.repeat(64),
      componentLocks: structuredClone(validation.locks),
      scheduleSha256: plan.schedule.scheduleSha256,
      promptTemplateSetSha256: 'c'.repeat(64),
      providerCallCount: 0,
      semanticCallExpectation: 76,
      evaluationForkExpectation: 30,
      boundaryProbeForkExpectation: 1
    };
    const sealedPlan = buildHardPeer80SealedPlan({ validation, h0Receipt: receipt, plan });
    const planPath = path.join(fixture.projectRoot, 'state', 'sealed-plan.json');
    const persisted = await persistHardPeer80SealedPlan(planPath, sealedPlan, validation);
    const loaded = await loadHardPeer80SealedPlan(planPath, validation);

    expect(loaded.plan).toEqual(sealedPlan);
    expect(loaded.sha256).toBe(persisted.sha256);
    expect(await sha256File(planPath)).toBe(persisted.sha256);
    const changedValidation = structuredClone(validation);
    changedValidation.locks.promptVersion = 'changed';
    await expect(loadHardPeer80SealedPlan(planPath, changedValidation))
      .rejects.toThrow('locks');
  });
});

async function createSealedFixture(): Promise<{
  projectRoot: string;
  fixtureRoot: string;
}> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hard-peer-80-validation-'));
  temporaryRoots.push(projectRoot);
  const fixtureRoot = path.join(projectRoot, 'evaluation', 'discourse-lab');
  await fs.mkdir(path.join(fixtureRoot, 'corpus'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'preregistration'), { recursive: true });
  await fs.cp(
    path.join(repositoryFixtureRoot, 'corpus', 'hard-peer-80-v1'),
    path.join(fixtureRoot, 'corpus', 'hard-peer-80-v1'),
    { recursive: true }
  );
  await fs.copyFile(
    path.join(repositoryFixtureRoot, 'preregistration', 'hard-peer-80-v1.json'),
    path.join(fixtureRoot, 'preregistration', 'hard-peer-80-v1.json')
  );
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'dep.ts'), 'export const value = 1;\n');
  await fs.writeFile(
    path.join(projectRoot, 'src', 'entry.ts'),
    "export { value } from './dep';\n"
  );
  const files = [
    ['evaluation/discourse-lab/corpus/hard-peer-80-v1/participants/calibration.json', 'PARTICIPANT'],
    ['evaluation/discourse-lab/corpus/hard-peer-80-v1/participants/evaluation.json', 'PARTICIPANT'],
    ['evaluation/discourse-lab/corpus/hard-peer-80-v1/scorer-only/calibration-oracles.json', 'SCORER_ONLY'],
    ['evaluation/discourse-lab/corpus/hard-peer-80-v1/scorer-only/evaluation-oracles.json', 'SCORER_ONLY'],
    ['evaluation/discourse-lab/preregistration/hard-peer-80-v1.json', 'HARNESS']
  ] as const;
  const sealedFiles = await Promise.all(files.map(async ([relativePath, audience]) => ({
    path: relativePath,
    audience,
    sha256: await sha256File(path.join(projectRoot, relativePath))
  })));
  const seal = {
    schemaVersion: 'discourse-lab/hard-peer-80-seal@v1',
    sealVersion: HARD_PEER_80_SEAL_VERSION,
    corpusVersion: 'hard-peer-80-corpus@v1',
    preregistrationVersion: HARD_PEER_80_PREREGISTRATION_VERSION,
    digestAlgorithm: 'SHA-256',
    partition: 'TERMINAL_DEVELOPMENT_ONLY',
    confirmationStatus: 'ABSENT_CLOSED',
    files: sealedFiles
  };
  await fs.writeFile(
    path.join(fixtureRoot, 'seal-hard-peer-80-v1.json'),
    `${JSON.stringify(seal, null, 2)}\n`
  );
  expect(stableJson(seal.files.map(({ path: filePath }) => filePath))).toContain('calibration');
  return { projectRoot, fixtureRoot };
}
