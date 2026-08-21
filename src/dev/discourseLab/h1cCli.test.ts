import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseH1cCliArgs,
  persistH1cFallbackDriverClose,
  runH1cCli,
  writePrivateExclusiveH1cPlan
} from './h1cCli';
import { buildH1cPlan, type H1cH0Receipt } from './h1cPlan';
import {
  buildH1cProbeManifest,
  type H1cProbeCloseResult
} from './h1cProbe';
import { LabArtifactLedger, type LabComponentLock } from './ledger';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('H1c CLI execution boundary', () => {
  it('defaults to help and exposes no confirmation command', async () => {
    const options = parseH1cCliArgs([], '/tmp/h1c-project');
    const result = await runH1cCli(options) as { help: string };
    expect(options.command).toBe('help');
    expect(options.confirmProviderUsage).toBe(false);
    expect(result.help).toContain('  h0 ');
    expect(result.help).toContain('  plan ');
    expect(result.help).toContain('  probe ');
    expect(result.help).toContain('  run ');
    expect(result.help).toContain('Confirmation is absent and closed');
    expect(result.help).not.toContain('confirmation run');
  });

  it('rejects confirmation at argument parsing for every live or local command', () => {
    for (const command of ['h0', 'plan', 'probe', 'run'] as const) {
      expect(() => parseH1cCliArgs([
        command,
        '--partition',
        'confirmation'
      ])).toThrow('confirmation is absent and closed');
    }
  });

  it('keeps H0 and planning local-only', async () => {
    const h0 = parseH1cCliArgs(['h0', '--confirm-provider-usage']);
    await expect(runH1cCli(h0)).rejects.toThrow('local-only');

    const plan = parseH1cCliArgs(['plan']);
    await expect(runH1cCli(plan)).rejects.toThrow('--h0-run-id');
  });

  it('requires a passed H0 receipt and explicit provider authorization before probing', async () => {
    const root = await temporaryRoot('task-monki-h1c-cli-probe-');
    const missingH0 = parseH1cCliArgs([
      'probe',
      '--confirm-provider-usage',
      ...exactSettings(),
      '--codex-home', path.join(root, 'home'),
      '--execution-root', path.join(root, 'execution')
    ]);
    await expect(runH1cCli(missingH0)).rejects.toThrow('--h0-run-id');

    const noAuthorization = parseH1cCliArgs([
      'probe',
      '--h0-run-id', 'h1c-h0-test',
      ...exactSettings(),
      '--codex-home', path.join(root, 'home'),
      '--execution-root', path.join(root, 'execution')
    ]);
    await expect(runH1cCli(noAuthorization)).rejects.toThrow('--confirm-provider-usage');
  });

  it('rejects model, budget, and provider-root mismatches before provider startup', async () => {
    const root = await temporaryRoot('task-monki-h1c-cli-gates-');
    const wrongModel = runArgs(root);
    const modelIndex = wrongModel.indexOf('gpt-5.6-sol');
    wrongModel[modelIndex] = 'gpt-5.6-terra';
    await expect(runH1cCli(parseH1cCliArgs(wrongModel))).rejects.toThrow(
      '--model gpt-5.6-sol --reasoning-effort high --service-tier default'
    );

    const wrongBudget = runArgs(root);
    const callIndex = wrongBudget.indexOf('28');
    wrongBudget[callIndex] = '27';
    await expect(runH1cCli(parseH1cCliArgs(wrongBudget))).rejects.toThrow('--max-calls 28');

    const overlapping = runArgs(root);
    const homeIndex = overlapping.indexOf('--codex-home') + 1;
    const executionIndex = overlapping.indexOf('--execution-root') + 1;
    overlapping[executionIndex] = path.join(overlapping[homeIndex]!, 'execution');
    await expect(runH1cCli(parseH1cCliArgs(overlapping))).rejects.toThrow(
      'separate, non-overlapping'
    );
  });

  it('writes a private plan exactly once', async () => {
    const root = await temporaryRoot('task-monki-h1c-cli-plan-');
    const locks = componentLocks();
    const plan = buildH1cPlan({
      cases: [
        { caseId: 'H1C-D5', stratum: 'DERIVABLE_CRITIQUE' },
        { caseId: 'H1C-D6', stratum: 'DERIVABLE_CRITIQUE' },
        { caseId: 'H1C-E5', stratum: 'NEW_EVIDENCE' },
        { caseId: 'H1C-E6', stratum: 'NEW_EVIDENCE' }
      ],
      locks,
      h0Validation: h0Receipt(locks),
      createdAt: '2026-08-02T00:00:00.000Z'
    });
    const outputPath = path.join(root, 'private', 'h1c-plan.json');
    await writePrivateExclusiveH1cPlan(outputPath, plan);
    const stat = await fs.stat(outputPath);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    await expect(writePrivateExclusiveH1cPlan(outputPath, plan)).rejects.toMatchObject({
      code: 'EEXIST'
    });
  });

  it('persists one authoritative fallback close artifact when no run result returns', async () => {
    const root = await temporaryRoot('task-monki-h1c-cli-close-');
    const runId = 'h1c-fallback-close-test';
    const ledger = new LabArtifactLedger(root, runId);
    const locks = componentLocks();
    await ledger.initialize(buildH1cProbeManifest({
      runId,
      componentLocks: locks,
      providerUsageExplicitlyAuthorized: true,
      createdAt: '2026-08-02T00:00:00.000Z'
    }));
    const close: H1cProbeCloseResult = {
      status: 'FAILED',
      startedAt: '2026-08-02T00:00:01.000Z',
      completedAt: '2026-08-02T00:00:02.000Z',
      elapsedMs: 1_000,
      maximumMs: 30_000,
      boundaryViolations: ['late MCP boundary'],
      failure: { name: 'Error', message: 'close failed' }
    };

    const artifactSha256 = await persistH1cFallbackDriverClose({ ledger, runId, close });

    const report = JSON.parse(await fs.readFile(
      path.join(ledger.runDirectory, 'reports', 'h1c-driver-close.json'),
      'utf8'
    )) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: 'task-monki/discourse-lab-h1c-driver-close@v1',
      runId,
      resultReportWritten: false,
      closeArtifactSha256: artifactSha256,
      close
    });
    const artifact = JSON.parse(await fs.readFile(
      path.join(ledger.runDirectory, 'artifacts', `${artifactSha256}.json`),
      'utf8'
    ));
    expect(artifact).toEqual({ kind: 'H1C_EXPERIMENT_FALLBACK_DRIVER_CLOSE', close });
    const eventNames = await fs.readdir(path.join(ledger.runDirectory, 'events'));
    expect(eventNames).toHaveLength(1);
    const event = JSON.parse(await fs.readFile(
      path.join(ledger.runDirectory, 'events', eventNames[0]!),
      'utf8'
    ));
    expect(event).toMatchObject({
      eventType: 'H1C_EXPERIMENT_FALLBACK_DRIVER_CLOSE_FAILED',
      artifactSha256,
      detail: {
        status: 'FAILED',
        boundaryViolations: ['late MCP boundary'],
        failure: { name: 'Error', message: 'close failed' }
      }
    });
  });

});

function exactSettings(): string[] {
  return [
    '--model', 'gpt-5.6-sol',
    '--reasoning-effort', 'high',
    '--service-tier', 'default'
  ];
}

function runArgs(root: string): string[] {
  return [
    'run',
    '--plan', path.join(root, 'missing-plan.json'),
    '--schema-probe-run-id', 'h1c-probe-test',
    '--codex-home', path.join(root, 'home'),
    '--execution-root', path.join(root, 'execution'),
    ...exactSettings(),
    '--max-calls', '28',
    '--max-total-tokens', '300000',
    '--max-call-seconds', '120',
    '--max-experiment-seconds', '2400',
    '--confirm-provider-usage'
  ];
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function componentLocks(): LabComponentLock {
  return {
    corpusVersion: 'h1c-assay-corpus@v3',
    participantCorpusSha256: '1'.repeat(64),
    oracleCorpusSha256: '2'.repeat(64),
    labSourceSha256: '3'.repeat(64),
    preregistrationVersion: 'h1c-preregistration-v3',
    preregistrationSha256: '4'.repeat(64),
    promptVersion: 'h1c-public-prompts@v3',
    outputSchemaVersion: 'discourse-protocol-lab/public-output-v4',
    scoringVersion: 'h1c-assay-metrics@v3',
    protocolVersion: 'h1c-live-yoked-protocol@v3'
  };
}

function h0Receipt(locks: LabComponentLock): H1cH0Receipt {
  return {
    runId: 'h1c-h0-test',
    manifestSha256: '5'.repeat(64),
    reportSha256: '6'.repeat(64),
    report: {
      schemaVersion: 'task-monki/discourse-lab-h1c-h0@v3',
      validationVersion: 'h1c-h0-validation@v3',
      hypothesisId: 'H0-H1C',
      status: 'PASSED',
      componentLocks: structuredClone(locks),
      promptTemplateSetSha256: '7'.repeat(64),
      checks: [{ checkId: 'ZERO_PROVIDER_BEHAVIOR', status: 'PASSED', detail: 'No calls.' }]
    }
  };
}
