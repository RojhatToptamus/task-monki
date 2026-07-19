import { describe, expect, it } from 'vitest';
import type { PreviewOciEngineIdentity } from '../../../shared/contracts';
import {
  OciEngineAdapter,
  OciEngineError,
  type OciCommandExecutor
} from './OciEngineAdapter';

describe('OciEngineAdapter', () => {
  it('pins the selected context and records a bounded exact engine identity', async () => {
    const calls: string[][] = [];
    const adapter = new OciEngineAdapter({
      execute: fixtureExecutor(calls)
    });

    const capability = await adapter.requireReady();

    expect(capability).toMatchObject({
      status: 'READY',
      contextName: 'desktop-linux',
      supportsMemoryLimit: true,
      supportsCpuLimit: true,
      supportsPidsLimit: true,
      identity: {
        contextName: 'desktop-linux',
        engineId: 'engine-id',
        serverVersion: '28.0.4',
        apiVersion: '1.48',
        operatingSystem: 'linux',
        architecture: 'arm64'
      }
    });
    expect(capability.identity.endpointDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]).toEqual(['context', 'show']);
    expect(calls.slice(1).every((argv) => argv.includes('desktop-linux'))).toBe(true);

    await adapter.probe();
    expect(calls.filter((argv) => argv[0] === 'context' && argv[1] === 'show')).toHaveLength(1);
  });

  it('distinguishes a missing executable, unavailable daemon, and unsupported engine', async () => {
    const missing = new OciEngineAdapter({
      execute: async () => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      }
    });
    await expect(missing.probe()).resolves.toMatchObject({ status: 'ENGINE_MISSING' });

    const unavailable = new OciEngineAdapter({
      contextName: 'desktop-linux',
      execute: async () => {
        throw new Error('Cannot connect to the Docker daemon.');
      }
    });
    await expect(unavailable.probe()).resolves.toMatchObject({
      status: 'ENGINE_UNAVAILABLE',
      contextName: 'desktop-linux'
    });

    const unsupported = new OciEngineAdapter({
      execute: fixtureExecutor([], { operatingSystem: 'windows', architecture: 'amd64' })
    });
    await expect(unsupported.probe()).resolves.toMatchObject({
      status: 'UNSUPPORTED_ENGINE',
      reason: expect.stringContaining('windows/amd64')
    });
  });

  it('refuses cleanup authority when a context is retargeted to another engine', async () => {
    const adapter = new OciEngineAdapter({ execute: fixtureExecutor([]) });
    const capability = await adapter.requireReady();
    const expected: PreviewOciEngineIdentity = {
      ...capability.identity,
      engineId: 'different-engine'
    };

    await expect(adapter.requireReady(expected)).rejects.toMatchObject({
      code: 'ENGINE_IDENTITY_MISMATCH'
    } satisfies Partial<OciEngineError>);
  });

  it('keeps one-shot credential input outside OCI argv and configured environment', async () => {
    const calls: Array<{ argv: string[]; input: Buffer; env: NodeJS.ProcessEnv }> = [];
    const adapter = new OciEngineAdapter({
      env: { PATH: process.env.PATH, UNRELATED: 'public' },
      attachStdin: async (_executable, argv, input, options) => {
        calls.push({ argv: [...argv], input: Buffer.from(input), env: { ...options.env } });
        return {
          failure: new Promise<never>(() => undefined),
          async close() {}
        };
      }
    });
    const secret = Buffer.from('credential-canary', 'utf8');

    const attachment = await adapter.attachStdin(['container', 'attach', 'owned-id'], secret);
    await attachment.close();

    expect(calls).toHaveLength(1);
    expect(calls[0].input.toString('utf8')).toBe('credential-canary');
    expect(JSON.stringify(calls[0].argv)).not.toContain('credential-canary');
    expect(JSON.stringify(calls[0].env)).not.toContain('credential-canary');
    secret.fill(0);
  });

  it('joins the bounded stdin attachment after its payload is flushed', async () => {
    const adapter = new OciEngineAdapter({ executable: process.execPath });
    const input = Buffer.from('transient-canary', 'utf8');

    const attachment = await adapter.attachStdin([
      '-e',
      'process.stdin.resume();'
    ], input, { timeoutMs: 5_000 });
    const firstClose = attachment.close();
    const concurrentClose = attachment.close();
    expect(concurrentClose).toBe(firstClose);
    await firstClose;

    input.fill(0);
  });

  it('terminates and joins the stdin attachment when startup is canceled', async () => {
    const controller = new AbortController();
    const adapter = new OciEngineAdapter({ executable: process.execPath });
    const input = Buffer.from('cancel-canary', 'utf8');
    const attachment = await adapter.attachStdin([
      '-e',
      'process.stdin.resume(); setInterval(() => {}, 1000);'
    ], input, { timeoutMs: 5_000, signal: controller.signal });

    controller.abort(new Error('preview canceled'));

    await expect(attachment.failure).rejects.toThrow('preview canceled');
    await attachment.close();
    input.fill(0);
  });

  it.runIf(process.platform === 'darwin' && process.env.TASK_MONKI_OCI_INTEGRATION === '1')(
    'passes the capability contract against the configured macOS Docker context',
    async () => {
      const adapter = new OciEngineAdapter({
        executable: process.env.TASK_MONKI_OCI_BIN || 'docker',
        contextName: process.env.TASK_MONKI_OCI_CONTEXT || 'desktop-linux'
      });

      const capability = await adapter.requireReady();

      expect(capability.identity.operatingSystem).toBe('linux');
      expect(['arm64', 'amd64']).toContain(capability.identity.architecture);
      expect(capability.identity.engineId).toBeTruthy();
    },
    30_000
  );
});

function fixtureExecutor(
  calls: string[][],
  override: { operatingSystem?: string; architecture?: string } = {}
): OciCommandExecutor {
  return async (_executable, argv) => {
    calls.push(argv);
    if (argv[0] === 'context' && argv[1] === 'show') {
      return { stdout: 'desktop-linux\n', stderr: '' };
    }
    if (argv[0] === 'context' && argv[1] === 'inspect') {
      return {
        stdout: JSON.stringify([{
          Name: 'desktop-linux',
          Endpoints: { docker: { Host: 'unix:///private/docker.sock', SkipTLSVerify: false } }
        }]),
        stderr: ''
      };
    }
    if (argv.includes('version')) {
      return {
        stdout: JSON.stringify({
          Server: {
            Version: '28.0.4',
            ApiVersion: '1.48',
            Os: override.operatingSystem ?? 'linux',
            Arch: override.architecture ?? 'aarch64'
          }
        }),
        stderr: ''
      };
    }
    if (argv.includes('info')) {
      return {
        stdout: JSON.stringify({
          ID: 'engine-id',
          MemoryLimit: true,
          CpuCfsQuota: true,
          PidsLimit: true
        }),
        stderr: ''
      };
    }
    throw new Error(`Unexpected OCI fixture command: ${argv.join(' ')}`);
  };
}
