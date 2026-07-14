import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { AcpStdioSupervisor } from './AcpStdioSupervisor';
import { GEMINI_ACP_PROFILE, type AcpRuntimeProfile } from './AcpRuntimeProfiles';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AcpStdioSupervisor', () => {
  it('persists the process and negotiates stable v1 with no client fs or terminal tools', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-supervisor-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(
      agentScript,
      [
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin });",
        "input.on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  if (message.method === 'initialize') {",
        '    process.stdout.write(JSON.stringify({',
        "      jsonrpc: '2.0',",
        '      id: message.id,',
        '      result: {',
        '        protocolVersion: 1,',
        '        agentCapabilities: {',
        '          promptCapabilities: { image: true },',
        '          sessionCapabilities: { resume: {} }',
        '        },',
        "        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '9.1.0' }",
        '      }',
        "    }) + '\\n');",
        '  }',
        '});'
      ].join('\n'),
      { mode: 0o600 }
    );

    const profile: AcpRuntimeProfile = {
      ...GEMINI_ACP_PROFILE,
      descriptor: { ...GEMINI_ACP_PROFILE.descriptor, id: 'test-acp' },
      executableCandidates: [process.execPath],
      argv: [agentScript],
      allowedEnvironmentKeys: []
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new AcpStdioSupervisor(store, {
      profile,
      runtime: {
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      },
      cwd: directory,
      requestTimeoutMs: 2_000
    });

    try {
      const running = await supervisor.start();
      expect(running.initialize).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', version: '9.1.0' },
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      });
      expect(running.server).toMatchObject({
        runtimeId: 'test-acp',
        runtimeKind: 'ACP_AGENT',
        transport: 'STDIO',
        status: 'READY',
        schemaVersion: '1.19.0',
        runtimeVersion: '9.1.0'
      });
      const journal = await fs.readFile(running.server.protocolJournalPath, 'utf8');
      const entries = journal.trim().split('\n').map((line) => JSON.parse(line) as {
        direction: string;
        raw: string;
      });
      const outboundInitialize = entries.find((entry) => entry.direction === 'OUTBOUND');
      const initialize = JSON.parse(outboundInitialize!.raw) as {
        params: { clientCapabilities: unknown };
      };
      expect(initialize.params.clientCapabilities).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      });
    } finally {
      await supervisor.shutdown();
    }
    const server = (await store.snapshot()).agentServers[0];
    expect(server?.status).toBe('EXITED');
  });

  it('redacts provider credentials from persisted stderr diagnostics', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-redaction-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(
      agentScript,
      [
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin });",
        "input.on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  process.stderr.write('OLD_DIAGNOSTIC_MARKER' + 'x'.repeat(70 * 1024));",
        "  process.stderr.write('{\"GEMINI_API_KEY\":\"TOPSE');",
        '  setTimeout(() => {',
        "    process.stderr.write('CRET123\",\"authorization\":\"Bearer TOPSECRET123\"}\\n');",
        "    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 2 } }) + '\\n'), 20);",
        '  }, 20);',
        '});'
      ].join('\n'),
      { mode: 0o600 }
    );
    const profile: AcpRuntimeProfile = {
      ...GEMINI_ACP_PROFILE,
      descriptor: { ...GEMINI_ACP_PROFILE.descriptor, id: 'test-acp-redaction' },
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new AcpStdioSupervisor(store, {
      profile,
      runtime: {
        executable: process.execPath,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      },
      cwd: directory,
      environment: { ...process.env, GEMINI_API_KEY: 'TOPSECRET123' },
      requestTimeoutMs: 2_000
    });
    await expect(supervisor.start()).rejects.toThrow('supports stable protocol 1');
    const server = (await store.snapshot()).agentServers[0];
    expect(server?.exitReason).toContain('[REDACTED]');
    expect(server?.exitReason).not.toContain('TOPSECRET123');
    expect(server?.exitReason).not.toContain('OLD_DIAGNOSTIC_MARKER');
    const persistedTail = server?.exitReason?.split(' Diagnostics: ')[1] ?? '';
    expect(Buffer.byteLength(persistedTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });
});
