import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import { CURSOR_ACP_PROFILE } from './AcpRuntimeProfiles';
import { resolveAcpRuntime } from './AcpRuntimeResolver';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('ACP runtime resolution', () => {
  it('rejects an unrelated generic agent binary and tries the next Cursor candidate', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const genericAgent = await writeNodeExecutable(
      path.join(directory, 'generic'),
      'agent',
      [
        'if (process.argv.includes("--version")) { console.log("unrelated-agent 1.0.0"); process.exit(0); }',
        'console.log("Usage: agent do-something-else");'
      ].join('\n')
    );
    const cursorAgent = await writeNodeExecutable(
      path.join(directory, 'cursor'),
      'cursor-agent',
      'console.log("2026.06.19");'
    );
    const profile = {
      ...CURSOR_ACP_PROFILE,
      executableCandidates: [genericAgent, cursorAgent]
    };

    const resolved = await resolveAcpRuntime(profile, { cwd: directory });

    expect(resolved.executable).toBe(cursorAgent);
    expect(resolved.diagnostics.probes).toEqual([
      expect.objectContaining({
        executable: genericAgent,
        compatible: false,
        detail: expect.stringContaining('identity failed')
      }),
      expect.objectContaining({ executable: cursorAgent, compatible: true })
    ]);
  });

  it('accepts the generic alias only when it proves Cursor ACP identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const genericAgent = await writeNodeExecutable(
      directory,
      'agent',
      [
        'if (process.argv.includes("--version")) { console.log("2026.06.19"); process.exit(0); }',
        'if (process.argv.includes("help") && process.argv.includes("acp")) {',
        '  console.log("Usage: agent acp [options]\\nStart the Cursor Agent as an ACP server");',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\n')
    );
    const profile = {
      ...CURSOR_ACP_PROFILE,
      executableCandidates: [genericAgent]
    };

    const resolved = await resolveAcpRuntime(profile, { cwd: directory });

    expect(resolved.executable).toBe(genericAgent);
    expect(resolved.diagnostics.probes[0]).toEqual(
      expect.objectContaining({
        compatible: true,
        detail: expect.stringContaining('identity succeeded')
      })
    );
  });
});
