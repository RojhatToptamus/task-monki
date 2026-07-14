import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProcessSupervisor,
  type ProcessSpec,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { OpenCodeServerSupervisor } from './OpenCodeServerSupervisor';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('OpenCodeServerSupervisor', () => {
  it('redacts split and JSON-formatted credentials from bounded persisted stderr', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-opencode-supervisor-')
    );
    temporaryDirectories.push(directory);
    const providerSecret = 'openai-provider-secret-value';
    const processSupervisor = new DiagnosticProcessSupervisor(providerSecret);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const supervisor = new OpenCodeServerSupervisor(store, {
      runtime: {
        executable: '/fake/opencode',
        version: '1.17.18',
        source: 'config',
        diagnostics: {
          selectedExecutable: '/fake/opencode',
          selectedSource: 'config',
          selectedVersion: '1.17.18',
          selectedLaunchArgv: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
          requiredCapabilities: ['GET /global/health'],
          probes: []
        }
      },
      cwd: directory,
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: providerSecret },
      requestTimeoutMs: 200,
      startupTimeoutMs: 1_000,
      processSupervisor
    });

    try {
      await expect(supervisor.start()).rejects.toThrow();
      const server = (await store.snapshot()).agentServers[0];
      const exitReason = server?.exitReason ?? '';

      expect(server?.status).toBe('FAILED');
      expect(processSupervisor.generatedPassword.length).toBeGreaterThan(0);
      expect(exitReason).toContain('[REDACTED]');
      expect(exitReason).not.toContain(providerSecret);
      expect(exitReason).not.toContain(processSupervisor.generatedPassword);
      expect(exitReason).not.toContain('json-shaped-value');
      expect(exitReason).not.toContain('bearer-shaped-value');
      expect(exitReason).not.toContain('OLD_DIAGNOSTIC_MARKER');
      const persistedTail = exitReason.split('OpenCode diagnostics: ')[1] ?? '';
      expect(Buffer.byteLength(persistedTail, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await supervisor.shutdown();
      await store.close();
    }
  });
});

class DiagnosticProcessSupervisor extends ProcessSupervisor {
  generatedPassword = '';

  constructor(private readonly providerSecret: string) {
    super();
  }

  override start(spec: ProcessSpec): SupervisedProcess {
    const events = new EventEmitter() as SupervisedProcess['events'];
    this.generatedPassword = spec.env?.OPENCODE_SERVER_PASSWORD ?? '';
    let closed = false;

    queueMicrotask(() => {
      const passwordSplit = Math.floor(this.generatedPassword.length / 2);
      const providerSplit = Math.floor(this.providerSecret.length / 2);
      events.emit(
        'stderr',
        Buffer.from(`OLD_DIAGNOSTIC_MARKER${'x'.repeat(70 * 1024)}`)
      );
      events.emit(
        'stderr',
        Buffer.from(`generated=${this.generatedPassword.slice(0, passwordSplit)}`)
      );
      events.emit(
        'stderr',
        Buffer.from(
          `${this.generatedPassword.slice(passwordSplit)} {"OPENAI_API_KEY":"${this.providerSecret.slice(0, providerSplit)}`
        )
      );
      events.emit(
        'stderr',
        Buffer.from(
          `${this.providerSecret.slice(providerSplit)}","CUSTOM_API_KEY":"json-shaped-value"} Bearer bearer-shaped-value`
        )
      );
      events.emit(
        'stdout',
        Buffer.from('opencode server listening on http://127.0.0.1:1\n')
      );
    });

    return {
      pid: 4242,
      events,
      cancel: async () => {
        if (closed) return;
        closed = true;
        events.emit('close', { exitCode: null, signal: 'SIGTERM' });
      }
    };
  }
}
