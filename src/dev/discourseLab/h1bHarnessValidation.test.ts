import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { H1B_CORPUS_VERSION } from './h1bCorpus';
import {
  buildH1bHarnessValidationManifest,
  loadH1bH0ValidationReceipt,
  runH1bHarnessValidation
} from './h1bHarnessValidation';
import { H1B_SCORING_VERSION } from './h1bScoring';
import { buildH1bSourceLock } from './h1bSourceLock';
import type { H1bValidationReport } from './h1bValidation';
import { LabArtifactLedger, type LabComponentLock } from './ledger';
import { LAB_PROMPT_VERSION } from './prompts';
import { LAB_PROTOCOL_VERSION } from './protocols';
import { LAB_PUBLIC_OUTPUT_SCHEMA_VERSION } from './contracts';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('H1b H0 harness validation', () => {
  it('materializes and validates the complete prompt matrix without a provider', async () => {
    const validation = await validationFixture();
    const first = await runH1bHarnessValidation({ fixtureRoot, validation });
    const second = await runH1bHarnessValidation({ fixtureRoot, validation });

    expect(first).toEqual(second);
    expect(first.status).toBe('PASSED');
    expect(first.checks).toHaveLength(10);
    expect(first.checks.every((check) => check.status === 'PASSED')).toBe(true);
    expect(first.maximumEstimatedPromptTokens).toBeGreaterThan(0);
    expect(first.maximumEstimatedPromptTokens).toBeLessThanOrEqual(7_000);
    expect(first.promptSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sourceLock.sourceFiles).toEqual(
      expect.arrayContaining([
        'src/dev/discourseLab/CodexTextDriver.ts',
        'src/core/agent/codex/CodexAppServerSupervisor.ts',
        'src/core/agent/codex/CodexRpcClient.ts',
        'src/core/agent/codex/CodexPermissionProfile.ts',
        'src/core/discourse/DiscourseWorkspace.ts'
      ])
    );
  });

  it('writes and strictly reloads a content-addressed H0 receipt', async () => {
    const validation = await validationFixture();
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1b-h0-'));
    temporaryRoots.push(stateRoot);
    const runId = 'h1b-h0-valid';
    const ledger = new LabArtifactLedger(stateRoot, runId);
    await ledger.initialize(
      buildH1bHarnessValidationManifest(
        runId,
        validation.locks,
        '2026-08-01T00:00:00.000Z'
      )
    );

    const report = await runH1bHarnessValidation({ fixtureRoot, validation, ledger });
    const receipt = await loadH1bH0ValidationReceipt(stateRoot, runId, validation.locks);

    expect(receipt.report).toEqual(report);
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await fs.readdir(path.join(ledger.runDirectory, 'events'))).toEqual([
      '000001-h1b_h0_started.json',
      '000002-h1b_h0_passed.json'
    ]);
    expect(await fs.readdir(path.join(ledger.runDirectory, 'artifacts'))).toEqual([
      `${report.promptSetSha256}.json`
    ]);
  });

  it('rejects unsafe ids, stale locks, and a missing prompt-set artifact', async () => {
    const validation = await validationFixture();
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1b-h0-reject-'));
    temporaryRoots.push(stateRoot);
    const runId = 'h1b-h0-reject';
    const ledger = new LabArtifactLedger(stateRoot, runId);
    await ledger.initialize(buildH1bHarnessValidationManifest(runId, validation.locks));
    const report = await runH1bHarnessValidation({ fixtureRoot, validation, ledger });

    await expect(
      loadH1bH0ValidationReceipt(stateRoot, '../h1b-h0-reject', validation.locks)
    ).rejects.toThrow('unsafe run id');
    const staleLocks = { ...validation.locks, promptVersion: 'changed' };
    await expect(
      loadH1bH0ValidationReceipt(stateRoot, runId, staleLocks)
    ).rejects.toThrow('manifestLocks');
    await fs.unlink(
      path.join(ledger.runDirectory, 'artifacts', `${report.promptSetSha256}.json`)
    );
    await expect(
      loadH1bH0ValidationReceipt(stateRoot, runId, validation.locks)
    ).rejects.toThrow('promptSetArtifact');
  });
});

async function validationFixture(): Promise<H1bValidationReport> {
  const sourceLock = await buildH1bSourceLock(process.cwd(), [
    'src/dev/discourseLab/h1bHarnessValidation.ts',
    'src/dev/discourseLab/CodexTextDriver.ts'
  ]);
  const locks: LabComponentLock = {
    corpusVersion: H1B_CORPUS_VERSION,
    participantCorpusSha256: 'a'.repeat(64),
    oracleCorpusSha256: 'b'.repeat(64),
    labSourceSha256: sourceLock.sha256,
    preregistrationVersion: 'h1b-preregistration-v1',
    preregistrationSha256: 'c'.repeat(64),
    promptVersion: LAB_PROMPT_VERSION,
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    scoringVersion: H1B_SCORING_VERSION,
    protocolVersion: LAB_PROTOCOL_VERSION
  };
  return {
    valid: true,
    sealVersion: 'h1b-seal-v1',
    preregistrationVersion: 'h1b-preregistration-v1',
    verifiedFiles: [],
    sourceLock,
    locks
  };
}
