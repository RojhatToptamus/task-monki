import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_MONKI_CODEX_BIN_ENV } from '../agent/codex/CodexRuntimeResolver';
import { writeOutputExecutable } from '../../testSupport/fakeExecutable';
import { ExternalToolResolver, resolveConfiguredExecutable } from './ExternalToolResolver';
import type { ExternalExecutablePathSettings } from '../../shared/agent';

const autoSettings: ExternalExecutablePathSettings = {
  gitExecutablePath: null,
  codexExecutablePath: null,
  ghExecutablePath: null
};

describe('ExternalToolResolver', () => {
  it('auto-detects tools from PATH and reports live versions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-tools-'));
    const git = await writeOutputExecutable(dir, 'git', 'git version 9.9.9');
    const resolver = new ExternalToolResolver({
      cwd: dir,
      env: {
        PATH: dir
      }
    });

    const result = await resolver.probe('git', autoSettings);

    expect(result).toMatchObject({
      tool: 'git',
      source: 'auto',
      executable: 'git',
      status: 'ok',
      version: 'git version 9.9.9'
    });
    expect(result.resolvedPath).toBe(await expectedDiscoveredPath(git));
  });

  it('auto-detects tools without discarding the full process environment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-tools-full-env-'));
    const git = await writeOutputExecutable(dir, 'git', 'git version full-env');
    const resolver = new ExternalToolResolver({
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`
      }
    });

    const result = await resolver.probe('git', autoSettings);

    expect(result).toMatchObject({ status: 'ok', version: 'git version full-env' });
    expect(result.resolvedPath).toBe(await expectedDiscoveredPath(git));
  });

  it('uses explicit custom settings paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-tools-custom-'));
    const codex = await writeOutputExecutable(dir, 'custom-codex', 'codex-cli 1.2.3');
    const resolver = new ExternalToolResolver({ cwd: dir, env: { PATH: '' } });

    const result = await resolver.probe('codex', {
      ...autoSettings,
      codexExecutablePath: codex
    });

    expect(result).toMatchObject({
      tool: 'codex',
      source: 'settings',
      configuredPath: codex,
      executable: codex,
      resolvedPath: codex,
      status: 'ok',
      version: 'codex-cli 1.2.3'
    });
  });

  it('prefers environment overrides over saved settings', () => {
    expect(
      resolveConfiguredExecutable({
        tool: 'gh',
        settings: {
          ...autoSettings,
          ghExecutablePath: '/settings/gh'
        },
        env: {
          TASK_MANAGER_GH_PATH: '/env/gh'
        }
      })
    ).toEqual({
      executable: '/env/gh',
      configuredPath: '/env/gh',
      source: 'env'
    });
  });

  it('ignores blank environment overrides', () => {
    expect(
      resolveConfiguredExecutable({
        tool: 'git',
        settings: {
          ...autoSettings,
          gitExecutablePath: '/settings/git'
        },
        env: {
          TASK_MANAGER_GIT_PATH: '   '
        }
      })
    ).toEqual({
      executable: '/settings/git',
      configuredPath: '/settings/git',
      source: 'settings'
    });
  });

  it('uses TASK_MONKI_CODEX_BIN for Codex environment overrides', () => {
    expect(
      resolveConfiguredExecutable({
        tool: 'codex',
        settings: {
          ...autoSettings,
          codexExecutablePath: '/settings/codex'
        },
        env: {
          [TASK_MONKI_CODEX_BIN_ENV]: '/env/codex'
        }
      })
    ).toEqual({
      executable: '/env/codex',
      configuredPath: '/env/codex',
      source: 'env'
    });
  });

  it('does not bypass environment overrides when testing Auto mode', () => {
    expect(
      resolveConfiguredExecutable({
        tool: 'codex',
        settings: autoSettings,
        request: {
          tool: 'codex',
          executablePath: null
        },
        env: {
          [TASK_MONKI_CODEX_BIN_ENV]: '/env/codex'
        }
      })
    ).toEqual({
      executable: '/env/codex',
      configuredPath: '/env/codex',
      source: 'env'
    });
  });

  it('reports probe errors without throwing', async () => {
    const resolver = new ExternalToolResolver({ cwd: os.tmpdir(), env: { PATH: '' } });

    const result = await resolver.probe('git', {
      ...autoSettings,
      gitExecutablePath: '/missing/git'
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ENOENT|no such file/i);
  });
});

async function expectedDiscoveredPath(candidate: string): Promise<string> {
  return process.platform === 'win32' ? fs.realpath(candidate) : candidate;
}
