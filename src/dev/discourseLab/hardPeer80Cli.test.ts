import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHardPeer80CliArgs,
  prepareHardPeer80ProviderRoots,
  runHardPeer80Cli,
  writePrivateExclusiveHardPeer80Json
} from './hardPeer80Cli';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe('HARD-PEER-80 terminal CLI boundary', () => {
  it('exposes one provider-owning run and no separate probe, confirmation, or follow-up command', async () => {
    const options = parseHardPeer80CliArgs([], '/tmp/hard-peer-80-project');
    const result = await runHardPeer80Cli(options) as { help: string };

    expect(options.command).toBe('help');
    expect(options.confirmProviderUsage).toBe(false);
    expect(result.help).toContain('  h0 ');
    expect(result.help).toContain('  plan ');
    expect(result.help).toContain('  run ');
    expect(result.help).not.toContain('  probe ');
    expect(result.help).toContain('single run command owns the one live boundary');
    expect(result.help).toContain('Confirmation and follow-up studies are absent and closed');
  });

  it('rejects confirmation and unknown or duplicate arguments before doing work', () => {
    for (const command of ['h0', 'plan', 'run'] as const) {
      expect(() => parseHardPeer80CliArgs([
        command,
        '--partition',
        'confirmation'
      ])).toThrow('confirmation is absent and closed');
    }
    expect(() => parseHardPeer80CliArgs(['probe'])).toThrow('Unknown HARD-PEER-80 command');
    expect(() => parseHardPeer80CliArgs([
      'run',
      '--confirm-provider-usage',
      '--confirm-provider-usage'
    ])).toThrow('Duplicate option');
  });

  it('keeps H0 and sealed-plan construction provider-free', async () => {
    await expect(runHardPeer80Cli(parseHardPeer80CliArgs([
      'h0',
      '--confirm-provider-usage'
    ]))).rejects.toThrow('local-only');

    await expect(runHardPeer80Cli(parseHardPeer80CliArgs([
      'plan',
      '--model', 'gpt-5.6-sol'
    ]))).rejects.toThrow('--h0-run-id');

    await expect(runHardPeer80Cli(parseHardPeer80CliArgs([
      'plan',
      '--h0-run-id', 'h0-example',
      '--confirm-provider-usage'
    ]))).rejects.toThrow('local-only');
  });

  it('requires explicit authorization and the exact sealed model and budgets before plan access', async () => {
    const root = await temporaryRoot('task-monki-hard-peer-80-cli-gates-');
    const base = runArgs(root);

    await expect(runHardPeer80Cli(parseHardPeer80CliArgs(
      base.filter((argument) => argument !== '--confirm-provider-usage')
    ))).rejects.toThrow('--confirm-provider-usage');

    const wrongModel = [...base];
    wrongModel[wrongModel.indexOf('gpt-5.6-sol')] = 'gpt-5.6-terra';
    await expect(runHardPeer80Cli(parseHardPeer80CliArgs(wrongModel))).rejects.toThrow(
      '--model gpt-5.6-sol --reasoning-effort high --service-tier default'
    );

    const wrongCalls = [...base];
    wrongCalls[wrongCalls.indexOf('76')] = '80';
    await expect(runHardPeer80Cli(parseHardPeer80CliArgs(wrongCalls))).rejects.toThrow(
      '--max-calls 76'
    );

    const wrongTime = [...base];
    wrongTime[wrongTime.indexOf('18000')] = '18001';
    await expect(runHardPeer80Cli(parseHardPeer80CliArgs(wrongTime))).rejects.toThrow(
      '--max-experiment-seconds 18000'
    );
  });

  it('rejects overlapping provider, state, and repository roots before reading the plan', async () => {
    const root = await temporaryRoot('task-monki-hard-peer-80-cli-overlap-');
    const args = runArgs(root);
    const executionIndex = args.indexOf('--execution-root') + 1;
    args[executionIndex] = path.join(root, 'state', 'execution');

    await expect(runHardPeer80Cli(parseHardPeer80CliArgs(args, root))).rejects.toThrow(
      'separate, non-overlapping'
    );
  });

  it('splits one initially empty external base into three distinct empty stage roots', async () => {
    const root = await temporaryRoot('task-monki-hard-peer-80-cli-roots-');
    const repositoryRoot = path.join(root, 'repository');
    const codexHome = path.join(root, 'codex-home');
    const executionRoot = path.join(root, 'execution');
    const stateRoot = path.join(root, 'state');
    await Promise.all([
      fs.mkdir(repositoryRoot),
      fs.mkdir(codexHome),
      fs.mkdir(executionRoot),
      fs.mkdir(stateRoot)
    ]);

    const prepared = await prepareHardPeer80ProviderRoots({
      codexHome,
      executionRoot,
      repositoryRoot,
      stateRoot
    });

    expect(new Set(Object.values(prepared.executionRoots)).size).toBe(3);
    expect(Object.keys(prepared.executionRoots).sort()).toEqual([
      'CALIBRATION',
      'EVALUATION',
      'PROBE'
    ]);
    for (const stageRoot of Object.values(prepared.executionRoots)) {
      expect(await fs.readdir(stageRoot)).toEqual([]);
    }
    await expect(prepareHardPeer80ProviderRoots({
      codexHome,
      executionRoot,
      repositoryRoot,
      stateRoot
    })).rejects.toThrow('execution root must be empty');
  });

  it('writes local receipts privately and exactly once', async () => {
    const root = await temporaryRoot('task-monki-hard-peer-80-cli-receipt-');
    const receiptPath = path.join(root, 'receipts', 'h0.json');
    await writePrivateExclusiveHardPeer80Json(receiptPath, { status: 'PASSED' });

    expect(JSON.parse(await fs.readFile(receiptPath, 'utf8'))).toEqual({ status: 'PASSED' });
    if (process.platform !== 'win32') {
      expect((await fs.stat(receiptPath)).mode & 0o777).toBe(0o600);
    }
    await expect(writePrivateExclusiveHardPeer80Json(
      receiptPath,
      { status: 'REPLACED' }
    )).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

function runArgs(root: string): string[] {
  return [
    'run',
    '--plan', path.join(root, 'missing-plan.json'),
    '--state-root', path.join(root, 'state'),
    '--codex-home', path.join(root, 'codex-home'),
    '--execution-root', path.join(root, 'execution'),
    '--model', 'gpt-5.6-sol',
    '--reasoning-effort', 'high',
    '--service-tier', 'default',
    '--max-calls', '76',
    '--max-total-tokens', '1500000',
    '--max-call-seconds', '120',
    '--max-experiment-seconds', '18000',
    '--confirm-provider-usage'
  ];
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}
