import path from 'node:path';
import { execFilePortable } from '../../process/portableChildProcess';

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;

export interface PreviewComposeCliOptions {
  executable?: string;
  contextName?: string;
  dockerConfigPath?: string;
  controlledHome: string;
  execute?: typeof executeComposeCommand;
}

export interface PreviewComposeCommand {
  contextName: string;
  projectName: string;
  projectDirectory: string;
  files: string[];
  profiles: string[];
  envFile: string;
}

export class PreviewComposeCliAdapter {
  private readonly executable: string;
  private readonly contextName?: string;
  private readonly dockerConfigPath: string;
  private readonly controlledHome: string;
  private readonly execute: typeof executeComposeCommand;

  constructor(options: PreviewComposeCliOptions) {
    this.executable = options.executable ?? 'docker';
    this.contextName = options.contextName;
    this.dockerConfigPath = options.dockerConfigPath ?? path.join(process.env.HOME ?? '', '.docker');
    this.controlledHome = options.controlledHome;
    this.execute = options.execute ?? executeComposeCommand;
  }

  async probe(contextName = this.contextName ?? 'default'): Promise<{
    version: string;
    supportsNoEnvResolution: boolean;
    supportsRuntimeFlags: boolean;
  }> {
    const explicit = [
      ...(this.dockerConfigPath ? ['--config', this.dockerConfigPath] : []),
      '--context', contextName
    ];
    const version = await this.runRaw([...explicit, 'compose', 'version', '--short'], this.controlledHome);
    const [configHelp, upHelp] = await Promise.all([
      this.runRaw([...explicit, 'compose', 'config', '--help'], this.controlledHome),
      this.runRaw([...explicit, 'compose', 'up', '--help'], this.controlledHome)
    ]);
    const normalized = version.stdout.trim();
    if (!/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(normalized)) {
      throw new Error('Docker Compose returned an invalid semantic version.');
    }
    return {
      version: normalized.replace(/^v/, ''),
      supportsNoEnvResolution: /(?:^|\s)--no-env-resolution(?:\s|$)/m.test(configHelp.stdout),
      supportsRuntimeFlags: ['--wait', '--wait-timeout', '--pull', '--no-build'].every((flag) =>
        upHelp.stdout.includes(flag)
      )
    };
  }

  config(command: PreviewComposeCommand, options: { materialized: boolean }): Promise<string> {
    const argv = [
      ...this.baseArgs(command),
      'config', '--format', 'json',
      ...(options.materialized ? [] : ['--no-interpolate', '--no-env-resolution'])
    ];
    return this.runRaw(argv, command.projectDirectory).then((result) => result.stdout);
  }

  run(
    command: PreviewComposeCommand,
    argv: string[],
    options: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return this.runRaw([...this.baseArgs(command), ...argv], command.projectDirectory, options);
  }

  private baseArgs(command: PreviewComposeCommand): string[] {
    return [
      ...(this.dockerConfigPath ? ['--config', this.dockerConfigPath] : []),
      '--context', command.contextName,
      'compose',
      '-p', command.projectName,
      '--project-directory', command.projectDirectory,
      '--env-file', command.envFile,
      ...command.files.flatMap((file) => ['-f', file]),
      ...command.profiles.flatMap((profile) => ['--profile', profile])
    ];
  }

  private async runRaw(
    argv: string[],
    cwd: string,
    options: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.execute(this.executable, argv, {
        cwd,
        env: this.environment(),
        timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes ?? MAX_STDOUT_BYTES,
        maxErrorBytes: MAX_STDERR_BYTES,
        signal: options.signal
      });
    } catch (error) {
      void error;
      throw new Error('Docker Compose command failed; command output was withheld from general error surfaces.');
    }
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      HOME: this.controlledHome,
      TMPDIR: this.controlledHome,
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      COMPOSE_DISABLE_ENV_FILE: '1',
      COMPOSE_ANSI: 'never',
      COMPOSE_MENU: '0',
      COMPOSE_EXPERIMENTAL: '0'
    };
  }
}

async function executeComposeCommand(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    maxErrorBytes: number;
    signal?: AbortSignal;
  }
): Promise<{ stdout: string; stderr: string }> {
  return execFilePortable(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: Math.max(options.maxOutputBytes, options.maxErrorBytes),
    signal: options.signal
  });
}
