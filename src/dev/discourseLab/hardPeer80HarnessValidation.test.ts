import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadHardPeer80ParticipantCorpus
} from './hardPeer80Corpus';
import {
  buildHardPeer80HarnessValidationManifest,
  executeAndRecordHardPeer80H0,
  loadHardPeer80H0Receipt,
  runHardPeer80HarnessValidation
} from './hardPeer80HarnessValidation';
import { buildHardPeer80Plan, type HardPeer80Plan } from './hardPeer80Plan';
import { LabArtifactLedger, type LabComponentLock } from './ledger';
import {
  HARD_PEER_80_PREREGISTRATION_VERSION,
  HARD_PEER_80_PROTOCOL_VERSION,
  HARD_PEER_80_SCORING_VERSION,
  HARD_PEER_80_SEAL_VERSION,
  type HardPeer80ValidationReport
} from './hardPeer80Validation';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('HARD-PEER-80 provider-free H0', () => {
  it('materializes all 76 calls, freezes 31 zero-model forks, and independently verifies ten oracles', async () => {
    const { plan, validation } = await fixtures();
    const first = await runHardPeer80HarnessValidation({ fixtureRoot, plan, validation });
    const second = await runHardPeer80HarnessValidation({ fixtureRoot, plan, validation });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'PASSED',
      providerCallCount: 0,
      semanticCallExpectation: 76,
      calibrationCallExpectation: 5,
      evaluationBlockExpectation: 10,
      evaluationForkExpectation: 30,
      boundaryProbeForkExpectation: 1,
      totalNonModelForkExpectation: 31
    });
    expect(first.prompts).toHaveLength(76);
    expect(new Set(first.prompts.map(({ callId }) => callId)).size).toBe(76);
    expect(first.prompts.filter(({ phase }) => phase === 'BOUNDARY_PROBE')).toHaveLength(1);
    expect(first.prompts.filter(({ phase }) => phase === 'CALIBRATION')).toHaveLength(5);
    expect(first.prompts.filter(({ phase }) => phase === 'EVALUATION')).toHaveLength(70);
    expect(first.oracleVerifications).toHaveLength(10);
    expect(new Set(first.oracleVerifications.map(({ caseId }) => caseId)).size).toBe(10);
    expect(new Set(first.oracleVerifications.map(({ domain }) => domain)).size).toBe(5);
    expect(first.oracleVerifications.every((verification) =>
      verification.validTypedCertificateAccepted && verification.falseTypedCertificateRejected
    )).toBe(true);
    expect(first.checks).toHaveLength(18);
    expect(first.checks.every(({ status }) => status === 'PASSED')).toBe(true);
  });

  it('covers stage, schema, provenance, optional critique, direct response, disagreement, uncertainty, and abstention', async () => {
    const { plan, validation } = await fixtures();
    const report = await runHardPeer80HarnessValidation({ fixtureRoot, plan, validation });
    const contractFixtures = new Map(
      report.contractFixtures.map((fixture) => [fixture.fixtureId, fixture])
    );

    expect(report.contractFixtures).toHaveLength(30);
    expect(report.contractFixtures.every((fixture) =>
      fixture.status === 'PASSED' &&
      fixture.expectedAccepted === fixture.observedAccepted
    )).toBe(true);
    expect(contractFixtures.get('PEER_NO_ISSUE_ACCEPTED')?.observedAccepted).toBe(true);
    expect(contractFixtures.get('PEER_MATERIAL_ISSUE_ACCEPTED')?.observedAccepted).toBe(true);
    expect(contractFixtures.get('PEER_ANSWER_SELECTION_ISSUE_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('PEER_EPISTEMIC_STATE_ISSUE_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('PEER_CERTIFICATE_ISSUE_ACCEPTED')?.observedAccepted).toBe(true);
    expect(contractFixtures.get('PEER_COMPONENT_PROPOSITION_MISMATCH_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('PEER_ARTIFACT_AS_FACTUAL_EVIDENCE_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('AUTHOR_MISSING_DIRECT_RESPONSE_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('AUTHOR_CERTIFICATE_CHANGED_TARGET_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('AUTHOR_DUPLICATE_CHANGED_TARGET_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('AUTHOR_PARTIAL_PRESERVES_DISAGREEMENT_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('AUTHOR_PARTIAL_SILENT_RESOLUTION_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('PROBE_NULL_CERTIFICATE_PAYLOAD_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('INITIAL_SCHEMA_VALID_FALSE_CERTIFICATE_ACCEPTED')?.observedAccepted)
      .toBe(true);
    expect(contractFixtures.get('INITIAL_NULL_CERTIFICATE_PAYLOAD_REJECTED')?.observedAccepted)
      .toBe(false);
    expect(contractFixtures.get('INITIAL_UNCERTAIN_NULL_CERTIFICATE_PAYLOAD_ACCEPTED')
      ?.observedAccepted).toBe(true);
    expect(contractFixtures.get('INITIAL_EXPLICIT_ABSTENTION_ACCEPTED')?.observedAccepted)
      .toBe(true);
  });

  it('records and independently reloads a content-addressed zero-provider receipt', async () => {
    const { plan, validation, caseIds } = await fixtures();
    const ledgerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hard-peer-80-h0-'));
    temporaryRoots.push(ledgerRoot);
    const ledger = new LabArtifactLedger(ledgerRoot, 'hard-peer-80-h0-test');
    await ledger.initialize(buildHardPeer80HarnessValidationManifest(
      ledger.runId,
      validation.locks,
      caseIds,
      '2026-08-03T12:00:00.000Z'
    ));
    const receipt = await executeAndRecordHardPeer80H0({
      fixtureRoot,
      validation,
      plan,
      ledger
    });
    const loaded = await loadHardPeer80H0Receipt({
      ledgerRoot,
      receipt,
      activeLocks: validation.locks,
      plan
    });

    expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.promptTemplateSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.providerCallCount).toBe(0);
    expect(loaded.promptTemplateSetSha256).toBe(receipt.promptTemplateSetSha256);

    await expect(loadHardPeer80H0Receipt({
      ledgerRoot,
      receipt: { ...receipt, reportSha256: '0'.repeat(64) },
      activeLocks: validation.locks,
      plan
    })).rejects.toThrow();
  });

  it('rejects an oracle that reuses a public proposition id with rewritten semantics', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hard-peer-80-oracle-drift-'));
    temporaryRoots.push(temporaryRoot);
    const copiedFixtureRoot = path.join(temporaryRoot, 'evaluation', 'discourse-lab');
    await fs.mkdir(path.join(copiedFixtureRoot, 'corpus'), { recursive: true });
    await fs.cp(
      path.join(fixtureRoot, 'corpus', 'hard-peer-80-v1'),
      path.join(copiedFixtureRoot, 'corpus', 'hard-peer-80-v1'),
      { recursive: true }
    );
    const oraclePath = path.join(
      copiedFixtureRoot,
      'corpus',
      'hard-peer-80-v1',
      'scorer-only',
      'calibration-oracles.json'
    );
    const oracleCorpus = JSON.parse(await fs.readFile(oraclePath, 'utf8')) as {
      records: Array<{ atomicClaims: Array<{ text: string }> }>;
    };
    oracleCorpus.records[0]!.atomicClaims[0]!.text = 'A different hidden proposition.';
    await fs.writeFile(oraclePath, `${JSON.stringify(oracleCorpus, null, 2)}\n`);
    const { plan, validation } = await fixtures(copiedFixtureRoot);

    await expect(runHardPeer80HarnessValidation({
      fixtureRoot: copiedFixtureRoot,
      plan,
      validation
    })).rejects.toThrow('atomic claim drifts');
  });
});

async function fixtures(activeFixtureRoot = fixtureRoot): Promise<{
  plan: HardPeer80Plan;
  validation: HardPeer80ValidationReport;
  caseIds: string[];
}> {
  const calibration = await loadHardPeer80ParticipantCorpus(activeFixtureRoot, 'CALIBRATION');
  const evaluation = await loadHardPeer80ParticipantCorpus(activeFixtureRoot, 'EVALUATION');
  const calibrationCaseIds = calibration.records.map(({ caseId }) => caseId);
  const evaluationCaseIds = evaluation.records.map(({ caseId }) => caseId);
  const plan = buildHardPeer80Plan({
    calibrationCaseIds,
    evaluationCaseIds,
    createdAt: '2026-08-03T12:00:00.000Z'
  });
  const locks: LabComponentLock = {
    corpusVersion: 'hard-peer-80-corpus@v1',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: HARD_PEER_80_PREREGISTRATION_VERSION,
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'hard-peer-80-public-prompts@v6',
    outputSchemaVersion: 'task-monki/discourse-lab-hard-peer-80-output@v4',
    scoringVersion: HARD_PEER_80_SCORING_VERSION,
    protocolVersion: HARD_PEER_80_PROTOCOL_VERSION
  };
  return {
    plan,
    caseIds: [...calibrationCaseIds, ...evaluationCaseIds],
    validation: {
      valid: true,
      sealVersion: HARD_PEER_80_SEAL_VERSION,
      preregistrationVersion: HARD_PEER_80_PREREGISTRATION_VERSION,
      verifiedFiles: [],
      sourceLock: {
        version: 'typescript-local-import-closure@v1',
        entryFiles: ['src/dev/discourseLab/hardPeer80Cli.ts'],
        sourceFiles: ['src/dev/discourseLab/hardPeer80Cli.ts'],
        sha256: locks.labSourceSha256
      },
      locks
    }
  };
}
