import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import { execFilePortable, spawnPortable } from '../../process/portableChildProcess';
import {
  compareCodexVersions,
  parseCodexVersionOutput
} from './CodexRuntimeVersion';

export const TASK_MONKI_CODEX_BIN_ENV = 'TASK_MONKI_CODEX_BIN';

export const TASK_MONKI_REQUIRED_CODEX_APP_SERVER_METHODS = [
  'account/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/fork',
  'thread/read',
  'thread/goal/get',
  'thread/goal/set',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'review/start'
] as const;

export type TaskMonkiCodexAppServerMethod =
  (typeof TASK_MONKI_REQUIRED_CODEX_APP_SERVER_METHODS)[number];

export type CodexRuntimeCandidateSource =
  | 'config'
  | 'environment'
  | 'path'
  | 'codex-app-bundle'
  | 'vscode-extension-bundle';

export interface CodexRuntimeCandidate {
  executable: string;
  source: CodexRuntimeCandidateSource;
  explicit: boolean;
  detail?: string;
}

export interface CodexAppServerLaunch {
  argv: string[];
  transport: 'STDIO';
  form: 'stdio-flag' | 'listen-stdio' | 'default-stdio';
}

export interface CodexAppServerCompatibility {
  launch: CodexAppServerLaunch;
  requiredMethods: TaskMonkiCodexAppServerMethod[];
}

export interface ResolvedCodexRuntime {
  executable: string;
  source: CodexRuntimeCandidateSource;
  version: string;
  compatibility: CodexAppServerCompatibility;
  diagnostics: CodexRuntimeProbeResult[];
}

export interface CodexRuntimeProbeResult {
  candidate: CodexRuntimeCandidate;
  compatible: boolean;
  version?: string;
  launch?: CodexAppServerLaunch;
  missingMethods?: TaskMonkiCodexAppServerMethod[];
  detail: string;
}

export interface CodexRuntimeResolverOptions {
  executable?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  pathEntries?: string[];
  appBundleCandidates?: string[];
  extensionRoots?: string[];
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class CodexRuntimeResolutionError extends Error {
  constructor(readonly diagnostics: CodexRuntimeProbeResult[]) {
    super(formatResolutionError(diagnostics));
    this.name = 'CodexRuntimeResolutionError';
  }
}

export async function resolveCodexRuntime(
  options: CodexRuntimeResolverOptions
): Promise<ResolvedCodexRuntime> {
  const candidates = await discoverCodexRuntimeCandidates(options);
  if (candidates.length === 0) {
    throw new CodexRuntimeResolutionError([]);
  }

  const diagnostics: CodexRuntimeProbeResult[] = [];
  for (const candidate of candidates) {
    diagnostics.push(await probeCodexRuntime(candidate, options));
  }

  const explicitRequested = candidates.some((candidate) => candidate.explicit);
  const compatible = diagnostics.filter((result) => result.compatible);
  const selectable = explicitRequested
    ? compatible.filter((result) => result.candidate.explicit)
    : compatible;
  const selected = explicitRequested ? selectable[0] : newestCompatible(selectable);

  if (!selected?.version || !selected.launch) {
    throw new CodexRuntimeResolutionError(diagnostics);
  }

  return {
    executable: selected.candidate.executable,
    source: selected.candidate.source,
    version: selected.version,
    compatibility: {
      launch: selected.launch,
      requiredMethods: [...TASK_MONKI_REQUIRED_CODEX_APP_SERVER_METHODS]
    },
    diagnostics
  };
}

export async function discoverCodexRuntimeCandidates(
  options: CodexRuntimeResolverOptions
): Promise<CodexRuntimeCandidate[]> {
  const environment = options.environment ?? process.env;
  const candidates: CodexRuntimeCandidate[] = [];
  const seen = new Set<string>();

  const add = async (
    executable: string | undefined,
    source: CodexRuntimeCandidateSource,
    explicit: boolean,
    detail?: string
  ) => {
    const trimmed = executable?.trim();
    if (!trimmed) {
      return;
    }
    const resolved = await resolveExecutableCandidate(trimmed, environment);
    if (!resolved) {
      return;
    }
    const key = await candidateKey(resolved);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ executable: resolved, source, explicit, detail });
  };

  await add(options.executable, 'config', true);
  await add(environment[TASK_MONKI_CODEX_BIN_ENV], 'environment', true, TASK_MONKI_CODEX_BIN_ENV);

  for (const candidate of await pathCodexCandidates(options.pathEntries, environment)) {
    await add(candidate, 'path', false);
  }

  for (const candidate of options.appBundleCandidates ?? defaultCodexAppBundleCandidates()) {
    await add(candidate, 'codex-app-bundle', false);
  }

  for (const candidate of await extensionCodexCandidates(
    options.extensionRoots ?? defaultExtensionRoots()
  )) {
    await add(candidate, 'vscode-extension-bundle', false);
  }

  return candidates;
}

export async function probeCodexRuntime(
  candidate: CodexRuntimeCandidate,
  options: Pick<CodexRuntimeResolverOptions, 'cwd' | 'environment' | 'requestTimeoutMs'>
): Promise<CodexRuntimeProbeResult> {
  let version: string | undefined;
  try {
    version = await probeCodexVersion(candidate.executable, options.cwd, options.environment);
  } catch (error) {
    return {
      candidate,
      compatible: false,
      detail: `Could not read Codex version: ${errorMessage(error)}`
    };
  }

  const launchForms = await supportedAppServerLaunchForms(
    candidate.executable,
    options.cwd,
    options.environment
  );
  if (launchForms.length === 0) {
    return {
      candidate,
      compatible: false,
      version,
      detail: 'Codex App Server command or stdio transport was not detected.'
    };
  }

  let lastDetail = '';
  for (const launch of launchForms) {
    const capabilityResult = await probeJsonRpcCapabilities(candidate.executable, launch, {
      cwd: options.cwd,
      environment: options.environment,
      requestTimeoutMs: options.requestTimeoutMs
    });
    if (capabilityResult.ok) {
      return {
        candidate,
        compatible: true,
        version,
        launch,
        detail: `Compatible Codex App Server via ${launch.form}.`
      };
    }
    lastDetail = capabilityResult.detail;
    if (capabilityResult.missingMethods?.length) {
      return {
        candidate,
        compatible: false,
        version,
        launch,
        missingMethods: capabilityResult.missingMethods,
        detail: `Codex App Server is missing required methods: ${capabilityResult.missingMethods.join(', ')}.`
      };
    }
  }

  return {
    candidate,
    compatible: false,
    version,
    detail: lastDetail || 'Codex App Server did not initialize over stdio.'
  };
}

export async function probeCodexVersion(
  executable: string,
  cwd: string,
  environment?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFilePortable(executable, ['--version'], {
    cwd,
    env: sanitizeEnvironment(environment ?? process.env),
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  return parseCodexVersionOutput(stdout);
}

async function supportedAppServerLaunchForms(
  executable: string,
  cwd: string,
  environment?: NodeJS.ProcessEnv
): Promise<CodexAppServerLaunch[]> {
  const help = await execFileText(executable, ['app-server', '--help'], {
    cwd,
    environment
  });
  if (!hasAppServerHelp(help)) {
    return [];
  }

  const forms: CodexAppServerLaunch[] = [];
  if (/(^|\s)--stdio(\s|$)/.test(help)) {
    forms.push({
      argv: ['app-server', '--stdio'],
      transport: 'STDIO',
      form: 'stdio-flag'
    });
  }
  if (/(^|\s)--listen(\s|$)/.test(help)) {
    forms.push({
      argv: ['app-server', '--listen', 'stdio://'],
      transport: 'STDIO',
      form: 'listen-stdio'
    });
  }
  if (forms.length === 0 && /(^|\n)\s*Usage:\s+.*\bapp-server\b/i.test(help)) {
    forms.push({
      argv: ['app-server'],
      transport: 'STDIO',
      form: 'default-stdio'
    });
  }
  return forms;
}

function hasAppServerHelp(help: string): boolean {
  return (
    /(^|\n)\s*Usage:\s+.*\bapp-server\b/i.test(help) ||
    /Launch (the )?Codex app server/i.test(help) ||
    /\bcodex app-server\b/.test(help)
  );
}

async function probeJsonRpcCapabilities(
  executable: string,
  launch: CodexAppServerLaunch,
  options: Pick<CodexRuntimeResolverOptions, 'cwd' | 'environment' | 'requestTimeoutMs'>
): Promise<
  | { ok: true }
  | {
      ok: false;
      detail: string;
      missingMethods?: TaskMonkiCodexAppServerMethod[];
    }
> {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-probe-'));
  const child = spawnPortable(executable, launch.argv, {
    cwd: options.cwd,
    env: {
      ...sanitizeEnvironment(options.environment ?? process.env),
      CODEX_HOME: codexHome
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  }) as ChildProcessWithoutNullStreams;

  let stderr = '';
  const timeoutMs = options.requestTimeoutMs ?? 2_500;
  const pending = new Map<
    number,
    {
      resolve(value: JsonRpcResponse): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();

  const failPending = (message: string) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(`${message} while waiting for request ${id}.`));
    }
    pending.clear();
  };

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      failPending(`Codex App Server emitted non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (!isJsonRpcResponse(parsed)) {
      return;
    }
    const request = pending.get(parsed.id);
    if (!request) {
      return;
    }
    pending.delete(parsed.id);
    clearTimeout(request.timer);
    request.resolve(parsed);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
  });
  child.once('close', () => {
    failPending(`Codex App Server exited: ${stderr.trim() || 'no diagnostic output'}`);
  });
  child.once('error', (error) => {
    failPending(error.message);
  });

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = nextId;
    nextId += 1;
    const payload = JSON.stringify({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`);
    });
  };
  const notify = (method: string, params: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  };

  try {
    await waitForSpawn(child);
    const initialized = await request('initialize', {
      clientInfo: {
        name: 'task_monki_probe',
        title: 'Task Monki Probe',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: false
      }
    });
    if (initialized.error) {
      return {
        ok: false,
        detail: `initialize failed: ${initialized.error.message ?? 'unknown error'}`
      };
    }
    notify('initialized', {});

    const missingMethods: TaskMonkiCodexAppServerMethod[] = [];
    await Promise.all(
      TASK_MONKI_REQUIRED_CODEX_APP_SERVER_METHODS.map(async (method) => {
        const response = await request(method, capabilityProbeParams(method));
        if (response.error && isMethodNotFound(response.error)) {
          missingMethods.push(method);
        }
      })
    );

    if (missingMethods.length > 0) {
      missingMethods.sort();
      return {
        ok: false,
        detail: `Missing methods: ${missingMethods.join(', ')}.`,
        missingMethods
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: errorMessage(error)
    };
  } finally {
    reader.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!(await waitForClose(child, 1_000))) {
        child.kill('SIGKILL');
      }
    }
    await fs.rm(codexHome, { recursive: true, force: true });
  }
}

function capabilityProbeParams(
  method: TaskMonkiCodexAppServerMethod
): Record<string, unknown> {
  switch (method) {
    case 'account/read':
      return { refreshToken: false };
    case 'model/list':
      return { cursor: null, limit: 1, includeHidden: false };
    case 'thread/start':
      return {
        model: '__task_monki_capability_probe_invalid_model__',
        ephemeral: true
      };
    case 'thread/resume':
    case 'thread/read':
    case 'thread/fork':
    case 'thread/goal/get':
      return { threadId: '__task_monki_capability_probe_missing_thread__' };
    case 'thread/goal/set':
      return {
        threadId: '__task_monki_capability_probe_missing_thread__',
        objective: 'Task Monki App Server compatibility probe'
      };
    case 'turn/start':
      return {
        threadId: '__task_monki_capability_probe_missing_thread__',
        input: [{ type: 'text', text: 'Task Monki App Server compatibility probe' }]
      };
    case 'turn/steer':
      return {
        threadId: '__task_monki_capability_probe_missing_thread__',
        input: [{ type: 'text', text: 'Task Monki App Server compatibility probe' }]
      };
    case 'turn/interrupt':
      return { threadId: '__task_monki_capability_probe_missing_thread__' };
    case 'review/start':
      return {
        threadId: '__task_monki_capability_probe_missing_thread__',
        delivery: 'inline'
      };
  }
}

function isMethodNotFound(error: { code?: number; message?: string }): boolean {
  return (
    error.code === -32601 ||
    /method not found|unknown method|unsupported(?: method)?/i.test(error.message ?? '')
  );
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number'
  );
}

async function execFileText(
  executable: string,
  argv: string[],
  options: { cwd: string; environment?: NodeJS.ProcessEnv }
): Promise<string> {
  try {
    const { stdout, stderr } = await execFilePortable(executable, argv, {
      cwd: options.cwd,
      env: sanitizeEnvironment(options.environment ?? process.env),
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const maybeOutput = error as { stdout?: unknown; stderr?: unknown };
    return `${typeof maybeOutput.stdout === 'string' ? maybeOutput.stdout : ''}${
      typeof maybeOutput.stderr === 'string' ? maybeOutput.stderr : ''
    }`;
  }
}

async function pathCodexCandidates(
  pathEntries: string[] | undefined,
  environment: NodeJS.ProcessEnv
): Promise<string[]> {
  const entries = pathEntries ?? (environment.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32' ? windowsExecutableNames('codex') : ['codex'];
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await canAccess(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function windowsExecutableNames(base: string): string[] {
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .filter(Boolean);
  return [base, ...extensions.map((extension) => `${base}${extension.toLowerCase()}`)];
}

async function extensionCodexCandidates(extensionRoots: string[]): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of extensionRoots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      if (!entry.startsWith('openai.chatgpt-')) {
        continue;
      }
      const binRoot = path.join(root, entry, 'bin');
      let platformDirs: string[];
      try {
        platformDirs = await fs.readdir(binRoot);
      } catch {
        continue;
      }
      for (const platformDir of platformDirs.sort().reverse()) {
        for (const name of process.platform === 'win32' ? windowsExecutableNames('codex') : ['codex']) {
          const candidate = path.join(binRoot, platformDir, name);
          if (await canAccess(candidate)) {
            candidates.push(candidate);
          }
        }
      }
    }
  }
  return candidates;
}

function defaultCodexAppBundleCandidates(): string[] {
  if (process.platform !== 'darwin') {
    return [];
  }
  return [
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex')
  ];
}

function defaultExtensionRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE ?? home;
    return [
      path.join(userProfile, '.vscode', 'extensions'),
      path.join(userProfile, '.cursor', 'extensions'),
      path.join(userProfile, '.windsurf', 'extensions')
    ];
  }
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions')
  ];
}

async function resolveExecutableCandidate(
  executable: string,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return executable;
  }
  const entries = (environment.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32' ? windowsExecutableNames(executable) : [executable];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await canAccess(candidate)) {
        return candidate;
      }
    }
  }
  return executable;
}

async function candidateKey(executable: string): Promise<string> {
  try {
    return await fs.realpath(executable);
  } catch {
    return path.resolve(executable);
  }
}

async function canAccess(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function newestCompatible(results: CodexRuntimeProbeResult[]): CodexRuntimeProbeResult | undefined {
  return [...results].sort((left, right) => {
    if (!left.version || !right.version) {
      return 0;
    }
    return compareCodexVersions(right.version, left.version);
  })[0];
}

function formatResolutionError(diagnostics: CodexRuntimeProbeResult[]): string {
  if (diagnostics.length === 0) {
    return (
      `No Codex executable candidates were found. Install Codex or set ` +
      `${TASK_MONKI_CODEX_BIN_ENV} to a Codex CLI with App Server support.`
    );
  }
  const detail = diagnostics
    .map((result) => {
      const version = result.version ? ` ${result.version}` : '';
      return `- ${result.candidate.executable}${version} (${result.candidate.source}): ${result.detail}`;
    })
    .join('\n');
  return `No compatible Codex App Server runtime was found.\n${detail}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}
