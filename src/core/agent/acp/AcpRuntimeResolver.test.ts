import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import {
  CLAUDE_AGENT_ACP_PROFILE,
  CURSOR_ACP_PROFILE,
  GROK_ACP_PROFILE,
  type AcpRuntimeProfile
} from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';
import {
  AcpRuntimeResolutionError,
  resolveAcpRuntime
} from './AcpRuntimeResolver';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('ACP runtime resolution', () => {
  it('rejects an unrelated candidate and tries the next Cursor candidate', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const unrelatedCandidate = await writeNodeExecutable(
      path.join(directory, 'generic'),
      'cursor-agent-preview',
      [
        'if (process.argv.includes("--version")) { console.log("unrelated-agent 1.0.0"); process.exit(0); }',
        'console.log("Usage: agent do-something-else");'
      ].join('\n')
    );
    const cursorAgent = await writeNodeExecutable(
      path.join(directory, 'cursor'),
      'cursor-agent',
      [
        'if (process.argv.includes("--version")) { console.log("2026.06.19"); process.exit(0); }',
        'if (process.argv.includes("help") && process.argv.includes("acp")) {',
        '  console.error("Usage: cursor-agent acp [options]");',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\n')
    );
    const profile = {
      ...CURSOR_ACP_PROFILE,
      executableCandidates: [unrelatedCandidate, cursorAgent]
    };

    const resolved = await resolveAcpRuntime(profile, { cwd: directory });

    expect(resolved.executable).toBe(cursorAgent);
    expect(resolved.diagnostics.probes).toEqual([
      expect.objectContaining({
        executable: unrelatedCandidate,
        compatible: false,
        detail: expect.stringContaining('launch contract failed')
      }),
      expect.objectContaining({ executable: cursorAgent, compatible: true })
    ]);
  });

  it('accepts an explicitly selected generic alias only when it proves Cursor ACP identity', async () => {
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
    const resolved = await resolveAcpRuntime(CURSOR_ACP_PROFILE, {
      cwd: directory,
      executable: genericAgent
    });

    expect(resolved.executable).toBe(genericAgent);
    expect(resolved.diagnostics.probes[0]).toEqual(
      expect.objectContaining({
        compatible: true,
        detail: expect.stringContaining('launch contract succeeded')
      })
    );
  });

  it('never executes a generic PATH agent during Cursor auto-discovery', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    await writeNodeExecutable(
      directory,
      'agent',
      [
        'console.error("generic PATH agent must not execute");',
        'process.exit(99);'
      ].join('\n')
    );

    const error = await resolveAcpRuntime(CURSOR_ACP_PROFILE, {
      cwd: directory,
      environment: { PATH: directory }
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AcpRuntimeResolutionError);
    expect(error).toMatchObject({
      code: 'ACP_RUNTIME_NOT_FOUND',
      diagnostics: {
        probes: [expect.objectContaining({ executable: 'cursor-agent' })]
      }
    });
    expect(JSON.stringify((error as AcpRuntimeResolutionError).diagnostics)).not.toContain(
      'generic PATH agent must not execute'
    );
  });

  it.each(
    [
      {
        label: 'Test ACP Agent',
        profile: TEST_ACP_PROFILE,
        version: '0.50.0',
        help: 'Usage: test-acp [options] [command]\n      --acp  Starts the agent in ACP mode'
      },
      {
        label: 'Grok Build',
        profile: GROK_ACP_PROFILE,
        version: '0.2.101',
        help: 'Run the agent over stdio\n\nUsage: grok agent stdio [OPTIONS]'
      },
      {
        label: 'Cursor Agent',
        profile: CURSOR_ACP_PROFILE,
        version: '2026.06.19',
        help: 'Usage: cursor-agent acp [options]'
      },
      {
        label: 'Claude Agent ACP',
        profile: CLAUDE_AGENT_ACP_PROFILE,
        version: '0.59.0',
        help: 'Usage: claude [options] [command]\nClaude Code'
      }
    ] satisfies Array<{
      label: string;
      profile: AcpRuntimeProfile;
      version: string;
      help: string;
    }>
  )('accepts $label only after its exact launch contract responds', async ({
    profile,
    version,
    help
  }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      profile.descriptor.id,
      exactProbeScript(profile, version, help)
    );

    const resolved = await resolveAcpRuntime(profile, {
      cwd: directory,
      executable
    });

    expect(resolved).toMatchObject({ executable, version });
    expect(resolved.diagnostics.probes).toEqual([
      expect.objectContaining({
        explicit: true,
        compatible: true,
        version,
        detail: expect.stringContaining('ACP wire compatibility will be negotiated during initialize')
      })
    ]);
  });

  it('rejects Antigravity agy as an unrelated ACP profile even when explicitly configured', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const agy = await writeNodeExecutable(
      directory,
      'agy',
      [
        'if (process.argv.includes("--version")) { console.log("agy 1.1.2"); process.exit(0); }',
        'if (process.argv.includes("--help")) {',
        '  console.error("Usage: agy [options] [command]\\nGoogle Antigravity CLI");',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\n')
    );

    const error = await resolveAcpRuntime(TEST_ACP_PROFILE, {
      cwd: directory,
      executable: agy
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AcpRuntimeResolutionError);
    expect(error).toMatchObject({
      code: 'ACP_RUNTIME_INCOMPATIBLE',
      diagnostics: {
        selectedExecutable: agy,
        selectedVersion: 'agy 1.1.2',
        probes: [
          expect.objectContaining({
            explicit: true,
            compatible: false,
            version: 'agy 1.1.2',
            detail: expect.stringContaining('Test ACP launch contract failed')
          })
        ]
      }
    });
    expect((error as Error).message).toContain(
      'A version response alone does not prove the required ACP launch contract'
    );
  });

  it('distinguishes a missing executable from an incompatible one', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const missingExecutable = path.join(directory, 'missing-test-acp');

    const error = await resolveAcpRuntime(TEST_ACP_PROFILE, {
      cwd: directory,
      executable: missingExecutable
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AcpRuntimeResolutionError);
    expect(error).toMatchObject({
      code: 'ACP_RUNTIME_NOT_FOUND',
      diagnostics: {
        selectedExecutable: missingExecutable,
        probes: [expect.objectContaining({ compatible: false })]
      }
    });
  });

  it('uses a portable non-secret environment until the candidate proves provider identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      'test-acp-environment-contract',
      [
        'if (process.env.PATH === undefined) process.exit(10);',
        'if (process.env.TEST_ACP_API_KEY !== undefined) process.exit(11);',
        'if (process.env.XDG_CONFIG_HOME !== undefined) process.exit(13);',
        'if (process.env.HTTPS_PROXY !== undefined) process.exit(14);',
        'if (process.env.CODEX_HOME !== undefined) process.exit(15);',
        'if (process.env.TASK_MONKI_UNRELATED_SECRET !== undefined) process.exit(16);',
        exactProbeScript(
          TEST_ACP_PROFILE,
          '0.50.0',
          'Usage: test-acp [options] [command]\\n      --acp  Starts the agent in ACP mode'
        )
      ].join('\n')
    );

    const resolved = await resolveAcpRuntime(TEST_ACP_PROFILE, {
      cwd: directory,
      executable,
      environment: {
        PATH: process.env.PATH,
        TEST_ACP_API_KEY: 'allowed-provider-secret',
        XDG_CONFIG_HOME: '/secret/provider-config',
        HTTPS_PROXY: 'https://user:proxy-secret@example.test',
        CODEX_HOME: '/secret/codex-home',
        TASK_MONKI_UNRELATED_SECRET: 'must-not-pass'
      }
    });

    expect(resolved.executable).toBe(executable);
  });

  it('redacts and bounds failed probe output before returning diagnostics', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      'noisy-test-acp-candidate',
      [
        'if (process.argv.includes("--version")) {',
        '  console.error("candidate diagnostic TOPSECRET123 " + "x".repeat(16 * 1024));',
        '  process.exit(9);',
        '}',
        'process.exit(2);'
      ].join('\n')
    );

    const error = await resolveAcpRuntime(TEST_ACP_PROFILE, {
      cwd: directory,
      executable,
      environment: {
        PATH: process.env.PATH,
        TEST_ACP_API_KEY: 'TOPSECRET123'
      }
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(AcpRuntimeResolutionError);
    const detail = (error as AcpRuntimeResolutionError).diagnostics.probes[0]?.detail ?? '';
    expect(detail).toContain('Version probe failed');
    expect(detail).toContain('[REDACTED]');
    expect(detail).toContain('[diagnostic truncated]');
    expect(detail).not.toContain('TOPSECRET123');
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect((error as Error).message).not.toContain('TOPSECRET123');
  });

  it('redacts successful stdout before treating it as version diagnostics', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-resolver-'));
    temporaryDirectories.push(directory);
    const executable = await writeNodeExecutable(
      directory,
      'test-acp-version-redaction',
      exactProbeScript(
        TEST_ACP_PROFILE,
        'test-acp TOPSECRET123',
        'Usage: test-acp [options] [command]\n      --acp  Starts the agent in ACP mode'
      )
    );

    const resolved = await resolveAcpRuntime(TEST_ACP_PROFILE, {
      cwd: directory,
      executable,
      environment: {
        PATH: process.env.PATH,
        TEST_ACP_API_KEY: 'TOPSECRET123'
      }
    });

    expect(resolved.version).toBe('test-acp [REDACTED]');
    expect(JSON.stringify(resolved.diagnostics)).not.toContain('TOPSECRET123');
  });
});

function exactProbeScript(
  profile: AcpRuntimeProfile,
  version: string,
  help: string
): string {
  const versionArgv = JSON.stringify(profile.versionArgv);
  const contractArgv = JSON.stringify(profile.launchContractProbe.argv);
  return [
    'const argv = process.argv.slice(2);',
    `if (JSON.stringify(argv) === ${JSON.stringify(versionArgv)}) {`,
    `  console.log(${JSON.stringify(version)});`,
    '  process.exit(0);',
    '}',
    `if (JSON.stringify(argv) === ${JSON.stringify(contractArgv)}) {`,
    // Real provider CLIs vary between stdout and stderr for help. The resolver
    // must use both streams without treating stderr help as a failed proof.
    `  console.error(${JSON.stringify(help)});`,
    '  process.exit(0);',
    '}',
    'console.error(`Unexpected argv: ${JSON.stringify(argv)}`);',
    'process.exit(2);'
  ].join('\n');
}
