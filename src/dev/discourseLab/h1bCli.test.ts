import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeCodexDriver,
  parseH1bCliArgs,
  recordH1bCommandFailure,
  runH1bCli,
  writePrivateExclusiveH1bPlan,
  type H1bCliOptions
} from './h1bCli';
import { loadH1bParticipantCorpus } from './h1bCorpus';
import {
  buildH1bPlan,
  type H1bH0ValidationReceipt,
  type H1bPlan
} from './h1bPlan';
import { validateH1bInputs } from './h1bValidation';
import type { LabArtifactLedger, LabLedgerEvent } from './ledger';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('H1b CLI safety boundary', () => {
  it('defaults to help and exposes only the five development commands', async () => {
    const options = parseH1bCliArgs([], '/tmp/h1b-project');
    expect(options.command).toBe('help');
    expect(options.confirmProviderUsage).toBe(false);

    const result = await runH1bCli(options) as { help: string };
    expect(result.help).toContain('  h0 ');
    expect(result.help).toContain('  plan ');
    expect(result.help).toContain('  probe ');
    expect(result.help).toContain('  run ');
    expect(result.help).toContain('  help');
    expect(result.help).toContain('Confirmation is absent and closed');
    expect(result.help).not.toContain('confirmation run');
  });

  it('rejects confirmation at argument parsing for every command', () => {
    for (const command of ['h0', 'plan', 'probe', 'run'] as const) {
      expect(() => parseH1bCliArgs([
        command,
        '--partition',
        'confirmation'
      ])).toThrow('confirmation is absent and closed');
    }
  });

  it('keeps h0 and plan provider-free and requires an H0 receipt before validation', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-local-');
    const h0 = parseH1bCliArgs([
      'h0',
      '--state-root', path.join(root, 'state'),
      '--confirm-provider-usage'
    ]);
    await expect(runH1bCli(h0)).rejects.toThrow('local-only');

    const plan = parseH1bCliArgs([
      'plan',
      '--state-root', path.join(root, 'state')
    ]);
    await expect(runH1bCli(plan)).rejects.toThrow('--h0-run-id');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('requires explicit provider authorization before probe validation or state creation', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-probe-auth-');
    const options = probeOptions(root);
    options.confirmProviderUsage = false;

    await expect(runH1bCli(options)).rejects.toThrow('--confirm-provider-usage');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('requires separate, non-overlapping Codex-home and execution roots', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-roots-');
    const options = probeOptions(root);
    options.codexHome = path.join(root, 'provider');
    options.executionRoot = path.join(root, 'provider', 'execution');

    await expect(runH1bCli(options)).rejects.toThrow('separate, non-overlapping');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a non-empty execution root before creating a probe ledger', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-stale-root-');
    const options = probeOptions(root);
    await Promise.all([
      fs.mkdir(options.codexHome!),
      fs.mkdir(options.executionRoot!)
    ]);
    await fs.writeFile(path.join(options.executionRoot!, 'stale.txt'), 'stale\n', 'utf8');

    await expect(runH1bCli(options)).rejects.toThrow('execution root must be empty');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('requires a PASSED exact-model probe receipt before plan access or provider startup', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-probe-receipt-');
    const options = runOptions(root);
    options.schemaProbeRunId = undefined;

    await expect(runH1bCli(options)).rejects.toThrow('--schema-probe-run-id');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a missing plan before creating a run ledger', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-missing-plan-');
    const options = runOptions(root);

    await expect(runH1bCli(options)).rejects.toThrow('run plan is unavailable or unsafe');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a plan with a missing H0 receipt before creating a run ledger', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-missing-h0-');
    const planPath = path.join(root, 'plan.json');
    await writePrivateExclusiveH1bPlan(planPath, await planForMissingH0());
    const options = runOptions(root);
    options.planPath = planPath;

    await expect(runH1bCli(options)).rejects.toThrow('H1b H0 receipt directory');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects a missing probe receipt without adding a development run', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-missing-probe-');
    const stateRoot = path.join(root, 'state');
    const h0Result = await runH1bCli(parseH1bCliArgs([
      'h0',
      '--state-root', stateRoot
    ])) as { runId: string };
    const planPath = path.join(root, 'plan.json');
    await runH1bCli(parseH1bCliArgs([
      'plan',
      '--state-root', stateRoot,
      '--h0-run-id', h0Result.runId,
      '--out', planPath
    ]));
    const runDirectoriesBefore = await fs.readdir(path.join(stateRoot, 'runs'));
    const options = runOptions(root);
    options.planPath = planPath;

    await expect(runH1bCli(options)).rejects.toThrow(
      'public-schema probe receipt directory'
    );
    expect(await fs.readdir(path.join(stateRoot, 'runs'))).toEqual(runDirectoriesBefore);
  });

  it.each([
    ['model', 'gpt-5.6-terra'],
    ['reasoningEffort', 'medium'],
    ['serviceTier', 'priority']
  ] as const)('rejects a run %s mismatch before reading the plan', async (field, value) => {
    const root = await temporaryRoot('task-monki-h1b-cli-settings-');
    const options = runOptions(root);
    Object.assign(options, { [field]: value });

    await expect(runH1bCli(options)).rejects.toThrow(
      '--model gpt-5.6-sol --reasoning-effort high --service-tier default'
    );
  });

  it.each([
    ['maximumCalls', 53, '--max-calls 54'],
    ['maximumTotalTokens', 599_999, '--max-total-tokens 600000'],
    ['maximumCallSeconds', 119, '--max-call-seconds 120'],
    ['maximumExperimentSeconds', 7_199, '--max-experiment-seconds 7200']
  ] as const)('rejects a run %s mismatch before reading the plan', async (
    field,
    value,
    expected
  ) => {
    const root = await temporaryRoot('task-monki-h1b-cli-budget-');
    const options = runOptions(root);
    Object.assign(options, { [field]: value });

    await expect(runH1bCli(options)).rejects.toThrow(expected);
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('writes plans with exclusive creation and private permissions', async () => {
    const root = await temporaryRoot('task-monki-h1b-cli-plan-');
    const outputPath = path.join(root, 'private', 'h1b-plan.json');
    const plan = {
      schemaVersion: 'task-monki/discourse-lab-h1b-plan@v1',
      planVersion: 'h1b-mechanism-plan@v1',
      assignments: []
    } as unknown as H1bPlan;

    await writePrivateExclusiveH1bPlan(outputPath, plan);
    const stat = await fs.stat(outputPath);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    await expect(writePrivateExclusiveH1bPlan(outputPath, plan)).rejects.toMatchObject({
      code: 'EEXIST'
    });
  });

  it('preserves bounded aggregate and cause details for command and close failures', async () => {
    const events: LabLedgerEvent[] = [];
    const ledger = {
      append: vi.fn(async (event: LabLedgerEvent) => {
        events.push(event);
      })
    } as unknown as LabArtifactLedger;
    const caused = new Error('execution failed', { cause: new Error('provider cause') });
    const failure = new AggregateError([caused, new Error('close failed')], 'both failed');

    await recordH1bCommandFailure(ledger, 'H1B_EXPERIMENT_COMMAND_FAILED', failure);

    expect(events[0]).toMatchObject({
      eventType: 'H1B_EXPERIMENT_COMMAND_FAILED',
      detail: {
        name: 'AggregateError',
        message: 'both failed',
        errors: [
          {
            name: 'Error',
            message: 'execution failed',
            cause: { name: 'Error', message: 'provider cause' }
          },
          { name: 'Error', message: 'close failed' }
        ]
      }
    });

    const fakeDriver = {
      close: vi.fn(async () => {
        throw failure;
      }),
      getProcessBoundaryViolations: vi.fn(() => [])
    };
    const close = await closeCodexDriver(
      fakeDriver as never,
      1_000
    );
    expect(close).toMatchObject({
      status: 'FAILED',
      failure: {
        name: 'AggregateError',
        message: 'both failed',
        errors: [
          {
            name: 'Error',
            message: 'execution failed',
            cause: { name: 'Error', message: 'provider cause' }
          },
          { name: 'Error', message: 'close failed' }
        ]
      }
    });
  });

  it('rejects unknown and duplicate options instead of silently accepting them', () => {
    expect(() => parseH1bCliArgs(['h0', '--unknown', 'x'])).toThrow('Unknown H1b option');
    expect(() => parseH1bCliArgs([
      'h0',
      '--state-root', 'one',
      '--state-root', 'two'
    ])).toThrow('Duplicate option');
  });
});

function probeOptions(root: string): H1bCliOptions {
  return parseH1bCliArgs([
    'probe',
    '--state-root', path.join(root, 'state'),
    '--codex-home', path.join(root, 'codex-home'),
    '--execution-root', path.join(root, 'execution'),
    '--model', 'gpt-5.6-sol',
    '--reasoning-effort', 'high',
    '--service-tier', 'default',
    '--confirm-provider-usage'
  ]);
}

function runOptions(root: string): H1bCliOptions {
  return parseH1bCliArgs([
    'run',
    '--state-root', path.join(root, 'state'),
    '--plan', path.join(root, 'missing-plan.json'),
    '--schema-probe-run-id', 'schema-probe-pass',
    '--codex-home', path.join(root, 'codex-home'),
    '--execution-root', path.join(root, 'execution'),
    '--model', 'gpt-5.6-sol',
    '--reasoning-effort', 'high',
    '--service-tier', 'default',
    '--max-calls', '54',
    '--max-total-tokens', '600000',
    '--max-call-seconds', '120',
    '--max-experiment-seconds', '7200',
    '--confirm-provider-usage'
  ]);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await fs.realpath(created);
  roots.push(root);
  return root;
}

async function planForMissingH0(): Promise<H1bPlan> {
  const fixtureRoot = path.resolve('evaluation', 'discourse-lab');
  const validation = await validateH1bInputs(fixtureRoot);
  const participant = await loadH1bParticipantCorpus(fixtureRoot);
  const h0Validation: H1bH0ValidationReceipt = {
    runId: 'missing-h0',
    manifestSha256: '0'.repeat(64),
    reportSha256: '1'.repeat(64),
    report: {
      schemaVersion: 'task-monki/discourse-lab-h1b-h0@v1',
      validationVersion: 'h1b-h0-validation@v1',
      hypothesisId: 'H0-H1B',
      status: 'PASSED',
      componentLocks: structuredClone(validation.locks),
      checks: [{ checkId: 'test-only', status: 'PASSED', detail: 'missing-receipt test' }]
    }
  };
  return buildH1bPlan({
    cases: participant.records,
    locks: validation.locks,
    h0Validation,
    createdAt: '2026-08-01T00:00:00.000Z'
  });
}
