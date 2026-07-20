import { describe, expect, it } from 'vitest';
import { PreviewComposeCliAdapter } from './PreviewComposeCliAdapter';

describe('PreviewComposeCliAdapter', () => {
  it('uses explicit context/config/project inputs and a clean bounded environment', async () => {
    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv; signal?: AbortSignal }> = [];
    const adapter = new PreviewComposeCliAdapter({
      executable: '/usr/local/bin/docker',
      contextName: 'desktop-linux',
      dockerConfigPath: '/safe/docker-config',
      controlledHome: '/safe/control',
      execute: async (_executable, argv, options) => {
        calls.push({ argv, env: options.env, signal: options.signal });
        if (argv.includes('version')) return { stdout: '2.40.0\n', stderr: '' };
        if (argv.includes('config') && argv.includes('--help')) {
          return { stdout: '  --no-env-resolution  Do not resolve env files\n', stderr: '' };
        }
        if (argv.includes('up') && argv.includes('--help')) {
          return { stdout: '  --wait  --wait-timeout  --pull  --no-build\n', stderr: '' };
        }
        return { stdout: '{}', stderr: '' };
      }
    });
    await expect(adapter.probe()).resolves.toEqual({
      version: '2.40.0',
      supportsNoEnvResolution: true,
      supportsRuntimeFlags: true
    });
    await adapter.config({
      contextName: 'desktop-linux',
      projectName: 'taskmonki_abc',
      projectDirectory: '/captured/source',
      files: ['/captured/source/compose.yaml'],
      profiles: ['preview'],
      envFile: '/safe/empty.env'
    }, { materialized: false });

    const config = calls[3];
    expect(config.argv).toEqual(expect.arrayContaining([
      '--config', '/safe/docker-config', '--context', 'desktop-linux', 'compose',
      '-p', 'taskmonki_abc', '--project-directory', '/captured/source',
      '--env-file', '/safe/empty.env', '-f', '/captured/source/compose.yaml',
      '--profile', 'preview', 'config', '--no-interpolate', '--no-env-resolution'
    ]));
    expect(config.env).toEqual({
      HOME: '/safe/control',
      TMPDIR: '/safe/control',
      PATH: expect.any(String),
      LANG: 'C',
      LC_ALL: 'C',
      COMPOSE_DISABLE_ENV_FILE: '1',
      COMPOSE_ANSI: 'never',
      COMPOSE_MENU: '0',
      COMPOSE_EXPERIMENTAL: '0'
    });
    expect(config.env).not.toHaveProperty('DOCKER_HOST');
    expect(config.env).not.toHaveProperty('COMPOSE_FILE');

    const controller = new AbortController();
    await adapter.run({
      contextName: 'desktop-linux', projectName: 'taskmonki_abc',
      projectDirectory: '/captured/source', files: ['/captured/source/compose.yaml'],
      profiles: [], envFile: '/safe/empty.env'
    }, ['up'], { signal: controller.signal });
    expect(calls.at(-1)?.signal).toBe(controller.signal);
  });

  it('does not copy Compose stderr or plaintext into surfaced errors', async () => {
    const adapter = new PreviewComposeCliAdapter({
      controlledHome: '/safe/control',
      execute: async () => { throw new Error('plaintext-canary from stderr'); }
    });
    let error: Error | undefined;
    try {
      await adapter.probe();
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    if (!error) throw new Error('Expected probe failure.');
    expect(error.message).toBe('Docker Compose command failed; command output was withheld from general error surfaces.');
    expect(JSON.stringify(error)).not.toContain('plaintext-canary');
    expect(error.cause).toBeUndefined();
  });
});
