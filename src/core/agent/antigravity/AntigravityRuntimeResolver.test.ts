import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import {
  AntigravityRuntimeResolutionError,
  resolveAntigravityRuntime
} from './AntigravityRuntimeResolver';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('Antigravity runtime resolution', () => {
  it('attests only the documented public print contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agy-resolver-'));
    directories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      'agy',
      `process.stdout.write(${JSON.stringify(publicHelp())});`
    );

    const resolved = await resolveAntigravityRuntime({ cwd: directory, executable });

    expect(resolved.executable).toBe(executable);
    expect(resolved.diagnostics.requiredCapabilities).toEqual(
      expect.arrayContaining(['agy models', '--new-project', '--sandbox', '--mode plan|accept-edits'])
    );
    expect(resolved.diagnostics.selectedLaunchArgv).not.toContain(
      '--dangerously-skip-permissions'
    );
  });

  it('rejects an executable that merely calls itself Antigravity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agy-resolver-'));
    directories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      'agy',
      'console.log("Usage of agy:\\n  --print Run once");'
    );

    const error = await resolveAntigravityRuntime({ cwd: directory, executable }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AntigravityRuntimeResolutionError);
    expect(error).toMatchObject({ code: 'ANTIGRAVITY_INCOMPATIBLE' });
    expect((error as Error).message).toContain('--new-project');
  });
});

function publicHelp(): string {
  return [
    'Usage of agy:',
    '  --print Run a single prompt non-interactively and print the response',
    '  --model Model for the current CLI session',
    '  --new-project Create a new project for this session',
    '  --sandbox Run in a sandbox with terminal restrictions enabled',
    '  --print-timeout Timeout for print mode wait',
    '  --mode Set the agent execution mode for this session',
    '',
    'Available subcommands:',
    '  models          List available models',
    ''
  ].join('\n');
}
