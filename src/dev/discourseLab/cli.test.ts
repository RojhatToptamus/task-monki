import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseLabCliArgs,
  recordCommandFailure,
  runLabCli,
  type LabCliOptions
} from './cli';
import type { LabArtifactLedger, LabLedgerEvent } from './ledger';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Discourse Lab CLI safety gates', () => {
  it('defaults to a non-provider help command', () => {
    const options = parseLabCliArgs([], '/tmp/project');
    expect(options.command).toBe('help');
    expect(options.confirmProviderUsage).toBe(false);
    expect(options.probePublicSchema).toBe(false);
  });

  it('requires every finite live budget and provider confirmation', async () => {
    const options = parseLabCliArgs(
      ['pilot-controlled', '--partition', 'development', '--plan', 'plan.json', '--model', 'm'],
      process.cwd()
    );
    await expect(runLabCli(options)).rejects.toThrow('--confirm-provider-usage');
  });

  it('rejects a semantic public-schema probe without explicit provider authorization', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-schema-auth-'));
    roots.push(root);
    const options = parseLabCliArgs([
      'preflight',
      '--probe-public-schema',
      '--state-root', path.join(root, 'state'),
      '--codex-home', path.join(root, 'codex-home'),
      '--execution-root', path.join(root, 'execution'),
      '--model', 'gpt-5.6-sol',
      '--reasoning-effort', 'high',
      '--service-tier', 'default'
    ], process.cwd());

    await expect(runLabCli(options)).rejects.toThrow('--confirm-provider-usage');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('requires the sealed schema-probe receipt id before plan or provider access', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-schema-id-'));
    roots.push(root);
    const options = pilotOptions(root, path.join(root, 'missing-plan.json'));
    options.schemaProbeRunId = undefined;

    await expect(runLabCli(options)).rejects.toThrow('--schema-probe-run-id');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('rejects confirmation before plan access, ledger creation, or provider startup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-confirmation-'));
    roots.push(root);
    const options = pilotOptions(root, path.join(root, 'missing-plan.json'));
    options.partition = 'CONFIRMATION';

    await expect(runLabCli(options)).rejects.toThrow('development-only');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it.each([
    ['model', 'gpt-5.6-terra'],
    ['reasoningEffort', 'medium'],
    ['serviceTier', 'priority']
  ] as const)('rejects a primary H1 %s mismatch before plan access', async (field, value) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-settings-'));
    roots.push(root);
    const options = pilotOptions(root, path.join(root, 'missing-plan.json'));
    Object.assign(options, { [field]: value });

    await expect(runLabCli(options)).rejects.toThrow(
      '--model gpt-5.6-sol --reasoning-effort high --service-tier default'
    );
  });

  it('rejects a missing schema-probe receipt before H1 ledger or provider startup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-schema-receipt-'));
    roots.push(root);
    const planPath = path.join(root, 'plan.json');
    await fs.writeFile(planPath, JSON.stringify({
      assignments: [],
      budget: {
        maximumCalls: 28,
        maximumObservedTotalTokens: 300_000,
        maximumCallMs: 120_000,
        maximumExperimentMs: 1_200_000
      }
    }), 'utf8');
    const options = pilotOptions(root, planPath);

    await expect(runLabCli(options)).rejects.toThrow('public-schema probe receipt');
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it.each([
    ['maximumCalls', 27, '--max-calls'],
    ['maximumTotalTokens', 299_999, '--max-total-tokens'],
    ['maximumCallSeconds', 119, '--max-call-seconds'],
    ['maximumExperimentSeconds', 1_199, '--max-experiment-seconds']
  ] as const)('rejects a sealed-plan budget mismatch in %s before provider startup', async (
    field,
    value,
    expectedFlag
  ) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-budget-'));
    roots.push(root);
    const planPath = path.join(root, 'plan.json');
    await fs.writeFile(planPath, JSON.stringify({
      assignments: [],
      budget: {
        maximumCalls: 28,
        maximumObservedTotalTokens: 300_000,
        maximumCallMs: 120_000,
        maximumExperimentMs: 1_200_000
      }
    }), 'utf8');
    const options = pilotOptions(root, planPath);
    Object.assign(options, { [field]: value });

    await expect(runLabCli(options)).rejects.toThrow(expectedFlag);
    await expect(fs.stat(path.join(root, 'state', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('does not permit a CLI override to weaken the source-locked active boundary', () => {
    expect(() => parseLabCliArgs([
      'pilot-controlled',
      '--allow-detected-text-boundary'
    ])).toThrow('obsolete');
  });

  it('preserves bounded recursive aggregate and cause detail in failure events', async () => {
    const leaf = new Error('leaf failure');
    const caused = new Error('caused failure', { cause: leaf });
    const failure = new AggregateError(
      [caused, new Error('second failure')],
      'driver close failed'
    );
    const events: LabLedgerEvent[] = [];
    const ledger = {
      append: vi.fn(async (event: LabLedgerEvent) => {
        events.push(event);
      })
    } as unknown as LabArtifactLedger;

    await recordCommandFailure(ledger, 'DRIVER_CLOSE_FAILED', failure);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'DRIVER_CLOSE_FAILED',
      detail: {
        name: 'AggregateError',
        message: 'driver close failed',
        errors: [
          {
            name: 'Error',
            message: 'caused failure',
            cause: { name: 'Error', message: 'leaf failure' }
          },
          { name: 'Error', message: 'second failure' }
        ]
      }
    });
  });

  it('bounds cyclic and oversized failure detail', async () => {
    const cyclic = new Error('x'.repeat(5_000));
    cyclic.cause = cyclic;
    const events: LabLedgerEvent[] = [];
    const ledger = {
      append: vi.fn(async (event: LabLedgerEvent) => {
        events.push(event);
      })
    } as unknown as LabArtifactLedger;

    await recordCommandFailure(ledger, 'DRIVER_CLOSE_FAILED', cyclic);

    expect((events[0]!.detail!.message as string).length).toBeLessThanOrEqual(4_097);
    expect(events[0]!.detail!.cause).toMatchObject({
      name: 'CircularFailure',
      truncated: true
    });
  });
});

function pilotOptions(root: string, planPath: string): LabCliOptions {
  return parseLabCliArgs([
    'pilot-controlled',
    '--partition', 'development',
    '--state-root', path.join(root, 'state'),
    '--plan', planPath,
    '--schema-probe-run-id', 'schema-probe-pass',
    '--model', 'gpt-5.6-sol',
    '--reasoning-effort', 'high',
    '--service-tier', 'default',
    '--codex-home', path.join(root, 'codex-home'),
    '--execution-root', path.join(root, 'execution'),
    '--max-calls', '28',
    '--max-total-tokens', '300000',
    '--max-call-seconds', '120',
    '--max-experiment-seconds', '1200',
    '--confirm-provider-usage'
  ], process.cwd());
}
