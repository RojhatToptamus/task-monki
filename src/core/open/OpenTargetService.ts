import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ExecuteOpenTargetActionRequest,
  InspectOpenTargetRequest,
  OpenTargetActionResult,
  OpenTargetAppId,
  OpenTargetDetectedApp,
  OpenTargetInspection,
  OpenTargetRef,
  TaskManagerAppSettings,
  TaskSnapshot,
  WorktreeRecord
} from '../../shared/contracts';

const execFileAsync = promisify(execFile);
const MAX_COPY_FILE_BYTES = 512 * 1024;
const DEFAULT_APP_ID: OpenTargetAppId = 'default';

interface OpenAppDefinition {
  id: Exclude<OpenTargetAppId, 'default'>;
  label: string;
  commandNames: string[];
  knownLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): KnownOpenAppLocation[];
  buildArgs(target: ResolvedOpenTarget): string[];
}

interface KnownOpenAppLocation {
  executable: string;
  iconPath?: string;
}

interface DetectedOpenApp {
  definition: OpenAppDefinition;
  executable: string;
  iconPath?: string;
}

interface OpenTargetContext {
  snapshot: TaskSnapshot;
  defaultRepositoryPath: string;
  appSettings: TaskManagerAppSettings;
}

interface ResolvedOpenTarget {
  ref: OpenTargetRef;
  path: string;
  rootPath?: string;
  line?: number;
  column?: number;
  exists: boolean;
  kind: OpenTargetInspection['target']['kind'];
  statSize?: number;
}

interface TextFileReadiness {
  ok: boolean;
  reason?: string;
}

export interface OpenTargetHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  stat(filePath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null>;
  realpath(filePath: string): Promise<string>;
  access(filePath: string, executable?: boolean): Promise<boolean>;
  readFile(filePath: string): Promise<Buffer>;
  launchExecutable(executable: string, argv: string[], cwd?: string): Promise<void>;
  openDefault(filePath: string): Promise<void>;
  reveal(filePath: string): Promise<void>;
  getFileIconDataUrl?(filePath: string): Promise<string | undefined>;
}

export class OpenTargetService {
  private readonly appIconDataUrls = new Map<string, Promise<string | undefined>>();
  private readonly pathApi: typeof path.posix | typeof path.win32;

  constructor(private readonly host: OpenTargetHost = createNodeOpenTargetHost()) {
    this.pathApi = platformPath(host.platform);
  }

  async inspect(
    input: InspectOpenTargetRequest,
    context: OpenTargetContext
  ): Promise<OpenTargetInspection> {
    const resolved = await this.resolveTarget(input.target, context);
    const apps = await this.detectApps();
    const preferredAppId =
      apps.find((app) => app.id !== DEFAULT_APP_ID)?.id ?? DEFAULT_APP_ID;
    const copyReadiness = await this.canCopyFileContents(resolved);
    const canReveal = await this.canReveal(resolved);
    const canOpenTerminal = await this.canOpenTerminal(resolved);

    return {
      target: {
        type: resolved.ref.type,
        kind: resolved.kind
      },
      apps,
      preferredAppId,
      revealLabel: revealLabel(this.host.platform),
      canOpen: resolved.exists,
      canReveal,
      canOpenTerminal,
      canCopyFileContents: copyReadiness.ok,
      copyFileContentsDisabledReason: copyReadiness.reason,
      disabledReason: resolved.exists ? undefined : 'Path is missing.'
    };
  }

  async execute(
    input: ExecuteOpenTargetActionRequest,
    context: OpenTargetContext
  ): Promise<OpenTargetActionResult> {
    try {
      const resolved = await this.resolveTarget(input.target, context);
      switch (input.action) {
        case 'copyPath':
          return { ok: true, clipboardText: resolved.path };
        case 'copyFileContents':
          return await this.copyFileContents(resolved);
        case 'reveal':
          await this.reveal(resolved);
          return { ok: true };
        case 'openTerminal':
          await this.openTerminal(resolved);
          return { ok: true };
        case 'open':
          await this.openWithApp(resolved, input.appId);
          return { ok: true };
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async resolveTarget(
    target: OpenTargetRef,
    context: OpenTargetContext
  ): Promise<ResolvedOpenTarget> {
    switch (target.type) {
      case 'repository':
        return await this.resolveRepositoryTarget(target.repositoryPath, target, context);
      case 'worktree':
        return await this.resolveWorktreeTarget(target, context);
      case 'worktreeFile':
        return await this.resolveWorktreeFileTarget(target, context);
    }
  }

  private async resolveRepositoryTarget(
    repositoryPath: string,
    ref: OpenTargetRef,
    context: OpenTargetContext
  ): Promise<ResolvedOpenTarget> {
    const normalized = this.normalizeLocalPath(repositoryPath);
    if (!normalized) {
      throw new Error('Repository path is required.');
    }
    if (!this.knownRepositoryPaths(context).some((candidate) => this.samePath(candidate, normalized))) {
      throw new Error('Repository path is not recorded by Task Monki.');
    }
    return await this.classifyPath(ref, normalized, normalized);
  }

  private async resolveWorktreeTarget(
    ref: Extract<OpenTargetRef, { type: 'worktree' }>,
    context: OpenTargetContext
  ): Promise<ResolvedOpenTarget> {
    const worktree = requireWorktree(context.snapshot, ref.worktreeId, ref.taskId);
    return await this.classifyPath(ref, worktree.worktreePath, worktree.worktreePath);
  }

  private async resolveWorktreeFileTarget(
    ref: Extract<OpenTargetRef, { type: 'worktreeFile' }>,
    context: OpenTargetContext
  ): Promise<ResolvedOpenTarget> {
    const worktree = requireWorktree(context.snapshot, ref.worktreeId, ref.taskId);
    const relativePath = this.normalizeRelativePath(ref.relativePath);
    const resolvedPath = this.pathApi.resolve(worktree.worktreePath, relativePath);
    this.assertPathWithinRoot(resolvedPath, worktree.worktreePath);
    const classified = await this.classifyPath(ref, resolvedPath, worktree.worktreePath);
    await this.assertExistingPathWithinRoot(classified, worktree.worktreePath);
    return {
      ...classified,
      line: positiveInt(ref.line),
      column: positiveInt(ref.column)
    };
  }

  private async classifyPath(
    ref: OpenTargetRef,
    filePath: string,
    rootPath?: string
  ): Promise<ResolvedOpenTarget> {
    const stat = await this.host.stat(filePath);
    const kind: ResolvedOpenTarget['kind'] = stat
      ? stat.isFile
        ? 'file'
        : stat.isDirectory
          ? 'directory'
          : 'other'
      : 'missing';
    return {
      ref,
      path: filePath,
      rootPath,
      exists: Boolean(stat),
      kind,
      statSize: stat?.size
    };
  }

  private async assertExistingPathWithinRoot(
    target: ResolvedOpenTarget,
    rootPath: string
  ): Promise<void> {
    if (!target.exists) {
      return;
    }
    const [realTarget, realRoot] = await Promise.all([
      this.host.realpath(target.path),
      this.host.realpath(rootPath)
    ]);
    this.assertPathWithinRoot(realTarget, realRoot);
  }

  private async detectApps(): Promise<OpenTargetDetectedApp[]> {
    const detected = await Promise.all(
      APP_DEFINITIONS.map(async (definition) => {
        const app = await this.detectApp(definition);
        if (!app) {
          return undefined;
        }
        return await this.toDetectedApp(app);
      })
    );
    return [
      ...detected.filter((app): app is OpenTargetDetectedApp => Boolean(app)),
      {
        id: DEFAULT_APP_ID,
        label: 'Default app'
      }
    ];
  }

  private async detectApp(definition: OpenAppDefinition): Promise<DetectedOpenApp | undefined> {
    const knownLocations = this.knownLocations(definition);
    const pathCandidate = await resolveExecutableFromPath(
      definition.commandNames,
      this.host
    );
    if (pathCandidate) {
      return {
        definition,
        executable: pathCandidate,
        iconPath: await this.resolveAppIconPath(definition, pathCandidate)
      };
    }

    for (const location of knownLocations) {
      if (await this.host.access(location.executable, true)) {
        return {
          definition,
          executable: location.executable,
          iconPath: location.iconPath
        };
      }
    }
    return undefined;
  }

  private async toDetectedApp(app: DetectedOpenApp): Promise<OpenTargetDetectedApp> {
    const iconDataUrl = app.iconPath ? await this.appIconDataUrl(app.iconPath) : undefined;
    return {
      id: app.definition.id,
      label: app.definition.label,
      icon: iconDataUrl ? { kind: 'image', dataUrl: iconDataUrl } : undefined
    };
  }

  private appIconDataUrl(appPath: string): Promise<string | undefined> {
    let promise = this.appIconDataUrls.get(appPath);
    if (!promise) {
      promise = this.host.getFileIconDataUrl?.(appPath).catch(() => undefined)
        ?? Promise.resolve(undefined);
      this.appIconDataUrls.set(appPath, promise);
    }
    return promise;
  }

  private knownLocations(definition: OpenAppDefinition): KnownOpenAppLocation[] {
    return definition
      .knownLocations(this.host.platform, this.host.env)
      .map((location) => ({
        executable: expandHome(location.executable, this.pathApi),
        iconPath: location.iconPath ? expandHome(location.iconPath, this.pathApi) : undefined
      }));
  }

  private async resolveAppIconPath(
    definition: OpenAppDefinition,
    executable: string
  ): Promise<string | undefined> {
    const realExecutable = await this.host.realpath(executable).catch(() => executable);
    const bundlePath = appBundlePathFromExecutable(realExecutable);
    if (bundlePath && (await this.host.access(bundlePath))) {
      return bundlePath;
    }

    for (const location of this.knownLocations(definition)) {
      if (location.iconPath && (await this.host.access(location.iconPath))) {
        return location.iconPath;
      }
    }
    return undefined;
  }

  private async canCopyFileContents(target: ResolvedOpenTarget): Promise<TextFileReadiness> {
    if (!target.exists) {
      return { ok: false, reason: 'File is missing.' };
    }
    if (target.kind !== 'file') {
      return { ok: false, reason: 'Target is not a file.' };
    }
    if ((target.statSize ?? 0) > MAX_COPY_FILE_BYTES) {
      return { ok: false, reason: 'File is too large to copy safely.' };
    }
    const buffer = await this.host.readFile(target.path);
    if (buffer.includes(0)) {
      return { ok: false, reason: 'Binary file contents cannot be copied.' };
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'File is not valid UTF-8 text.' };
    }
  }

  private async copyFileContents(target: ResolvedOpenTarget): Promise<OpenTargetActionResult> {
    const readiness = await this.canCopyFileContents(target);
    if (!readiness.ok) {
      return { ok: false, message: readiness.reason };
    }
    const buffer = await this.host.readFile(target.path);
    return {
      ok: true,
      clipboardText: new TextDecoder('utf-8').decode(buffer)
    };
  }

  private async canReveal(target: ResolvedOpenTarget): Promise<boolean> {
    const revealPath = await this.revealPathFor(target);
    return Boolean(revealPath);
  }

  private async reveal(target: ResolvedOpenTarget): Promise<void> {
    const revealPath = await this.revealPathFor(target);
    if (!revealPath) {
      throw new Error('No existing parent folder could be revealed.');
    }
    await this.host.reveal(revealPath);
  }

  private async revealPathFor(target: ResolvedOpenTarget): Promise<string | undefined> {
    if (target.exists) {
      return target.path;
    }
    const parent = this.pathApi.dirname(target.path);
    const stat = await this.host.stat(parent);
    return stat?.isDirectory ? parent : undefined;
  }

  private async openDefault(target: ResolvedOpenTarget): Promise<void> {
    if (!target.exists) {
      throw new Error('Path is missing.');
    }
    await this.host.openDefault(target.path);
  }

  private async openWithApp(
    target: ResolvedOpenTarget,
    appId: OpenTargetAppId | undefined
  ): Promise<void> {
    if (!target.exists) {
      throw new Error('Path is missing.');
    }
    if (!appId || appId === DEFAULT_APP_ID) {
      await this.openDefault(target);
      return;
    }
    const detected = await this.detectApp(requireAppDefinition(appId));
    if (!detected) {
      throw new Error(`${appLabel(appId)} is not available.`);
    }
    await this.host.launchExecutable(
      detected.executable,
      detected.definition.buildArgs(target),
      target.kind === 'directory' ? target.path : target.rootPath ?? this.pathApi.dirname(target.path)
    );
  }

  private async canOpenTerminal(target: ResolvedOpenTarget): Promise<boolean> {
    return Boolean(await this.terminalLaunchSpec(target));
  }

  private async openTerminal(target: ResolvedOpenTarget): Promise<void> {
    const spec = await this.terminalLaunchSpec(target);
    if (!spec) {
      throw new Error('No supported terminal launcher is available.');
    }
    await this.host.launchExecutable(spec.executable, spec.argv, spec.cwd);
  }

  private async terminalLaunchSpec(
    target: ResolvedOpenTarget
  ): Promise<{ executable: string; argv: string[]; cwd?: string } | undefined> {
    const directory = await this.directoryForTerminal(target);
    if (!directory) {
      return undefined;
    }
    switch (this.host.platform) {
      case 'darwin':
        return { executable: 'open', argv: ['-a', 'Terminal', directory] };
      case 'win32': {
        const wt = await resolveExecutableFromPath(['wt'], this.host);
        return wt ? { executable: wt, argv: ['-d', directory] } : undefined;
      }
      case 'linux': {
        const gnome = await resolveExecutableFromPath(['gnome-terminal'], this.host);
        if (gnome) {
          return { executable: gnome, argv: ['--working-directory', directory] };
        }
        const konsole = await resolveExecutableFromPath(['konsole'], this.host);
        if (konsole) {
          return { executable: konsole, argv: ['--workdir', directory] };
        }
        const fallback = await resolveExecutableFromPath(['x-terminal-emulator'], this.host);
        return fallback ? { executable: fallback, argv: [], cwd: directory } : undefined;
      }
      default:
        return undefined;
    }
  }

  private async directoryForTerminal(target: ResolvedOpenTarget): Promise<string | undefined> {
    if (target.exists && target.kind === 'directory') {
      return target.path;
    }
    const parent = this.pathApi.dirname(target.path);
    const stat = await this.host.stat(parent);
    return stat?.isDirectory ? parent : undefined;
  }

  private knownRepositoryPaths(context: OpenTargetContext): string[] {
    return uniqueStrings([
      context.defaultRepositoryPath,
      context.appSettings.repositories.selectedPath ?? '',
      ...context.appSettings.repositories.knownPaths,
      ...context.snapshot.tasks.map((task) => task.repositoryPath),
      ...context.snapshot.worktrees.map((worktree) => worktree.repositoryPath)
    ].map((value) => this.normalizeLocalPath(value)));
  }

  private normalizeRelativePath(value: string): string {
    if (value.includes('\0')) {
      throw new Error('Path contains invalid characters.');
    }
    const normalized = value.replace(/[\\/]/g, this.pathApi.sep);
    if (!normalized || this.pathApi.isAbsolute(normalized)) {
      throw new Error('Relative file path is required.');
    }
    const resolved = this.pathApi.normalize(normalized);
    if (resolved === '..' || resolved.startsWith(`..${this.pathApi.sep}`)) {
      throw new Error('File path escapes the worktree.');
    }
    return resolved;
  }

  private normalizeLocalPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    if (trimmed === this.pathApi.parse(trimmed).root) {
      return trimmed;
    }
    return this.pathApi.resolve(trimmed);
  }

  private assertPathWithinRoot(candidate: string, root: string): void {
    const relative = this.pathApi.relative(
      comparablePath(root, this.host.platform),
      comparablePath(candidate, this.host.platform)
    );
    if (relative === '' || (!relative.startsWith('..') && !this.pathApi.isAbsolute(relative))) {
      return;
    }
    throw new Error('Path escapes the recorded Task Monki root.');
  }

  private samePath(left: string, right: string): boolean {
    return comparablePath(this.normalizeLocalPath(left), this.host.platform)
      === comparablePath(this.normalizeLocalPath(right), this.host.platform);
  }
}

export function createNodeOpenTargetHost(): OpenTargetHost {
  return {
    platform: process.platform,
    env: process.env,
    async stat(filePath) {
      try {
        const stat = await fs.stat(filePath);
        return {
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async realpath(filePath) {
      try {
        return await fs.realpath(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return path.resolve(filePath);
        }
        throw error;
      }
    },
    async access(filePath, executable = false) {
      try {
        await fs.access(
          filePath,
          executable && process.platform !== 'win32' ? fsConstants.X_OK : fsConstants.F_OK
        );
        return true;
      } catch {
        return false;
      }
    },
    readFile(filePath) {
      return fs.readFile(filePath);
    },
    async launchExecutable(executable, argv, cwd) {
      const child = spawn(executable, argv, {
        cwd,
        detached: true,
        stdio: 'ignore'
      });
      await Promise.race([
        once(child, 'spawn'),
        once(child, 'error').then(([error]) => {
          throw error;
        })
      ]);
      child.unref();
    },
    async openDefault(filePath) {
      await launchPlatformOpen(process.platform, filePath);
    },
    async reveal(filePath) {
      await launchPlatformReveal(process.platform, filePath);
    },
    async getFileIconDataUrl(filePath) {
      if (process.platform !== 'darwin' || path.extname(filePath) !== '.app') {
        return undefined;
      }
      return await macAppIconDataUrl(filePath);
    }
  };
}

const APP_DEFINITIONS: OpenAppDefinition[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    commandNames: ['code'],
    knownLocations: (platform, env) => knownEditorLocations('vscode', platform, env),
    buildArgs: (target) => codeLikeArgs(target)
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    commandNames: ['code-insiders'],
    knownLocations: (platform, env) => knownEditorLocations('vscode-insiders', platform, env),
    buildArgs: (target) => codeLikeArgs(target)
  },
  {
    id: 'cursor',
    label: 'Cursor',
    commandNames: ['cursor'],
    knownLocations: (platform, env) => knownEditorLocations('cursor', platform, env),
    buildArgs: (target) => codeLikeArgs(target)
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    commandNames: ['windsurf'],
    knownLocations: (platform, env) => knownEditorLocations('windsurf', platform, env),
    buildArgs: (target) => codeLikeArgs(target)
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    commandNames: ['subl'],
    knownLocations: (platform, env) => knownEditorLocations('sublime', platform, env),
    buildArgs: (target) => [targetWithLineSuffix(target)]
  },
  {
    id: 'intellij-idea',
    label: 'IntelliJ IDEA',
    commandNames: ['idea', 'idea64'],
    knownLocations: (platform, env) => knownEditorLocations('intellij-idea', platform, env),
    buildArgs: (target) => intellijArgs(target)
  },
  {
    id: 'xcode',
    label: 'Xcode',
    commandNames: ['xed'],
    knownLocations: (platform) =>
      platform === 'darwin'
        ? [
            {
              executable: '/usr/bin/xed',
              iconPath: '/Applications/Xcode.app'
            }
          ]
        : [],
    buildArgs: (target) =>
      target.line && target.kind !== 'directory'
        ? ['-l', String(target.line), target.path]
        : [target.path]
  }
];

async function resolveExecutableFromPath(
  commandNames: string[],
  host: OpenTargetHost
): Promise<string | undefined> {
  const hostPath = platformPath(host.platform);
  const pathEntries = (host.env.PATH ?? '').split(pathDelimiter(host.platform)).filter(Boolean);
  for (const entry of pathEntries) {
    for (const commandName of commandNames) {
      for (const name of candidateExecutableNames(commandName, host)) {
        const candidate = hostPath.join(entry, name);
        if (await host.access(candidate, true)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function candidateExecutableNames(commandName: string, host: OpenTargetHost): string[] {
  if (host.platform !== 'win32' || path.win32.extname(commandName)) {
    return [commandName];
  }
  const extensions = (host.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [commandName, ...extensions.map((extension) => `${commandName}${extension}`)];
}

function appBundlePathFromExecutable(executable: string): string | undefined {
  const match = executable.match(/^(.*?\.app)(?:[/\\]|$)/);
  return match?.[1];
}

async function macAppIconDataUrl(appPath: string): Promise<string | undefined> {
  const iconPath = await macAppIconPath(appPath);
  if (!iconPath) {
    return undefined;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-icon-'));
  const outputPath = path.join(tempDir, 'icon.png');
  try {
    await execFileAsync('/usr/bin/sips', [
      '-s',
      'format',
      'png',
      '-z',
      '32',
      '32',
      iconPath,
      '--out',
      outputPath
    ], { timeout: 5000 });
    const png = await fs.readFile(outputPath);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function macAppIconPath(appPath: string): Promise<string | undefined> {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconName = await readMacBundleIconName(appPath);
  const candidates = new Set<string>();
  if (iconName) {
    candidates.add(iconName);
    if (!path.extname(iconName)) {
      candidates.add(`${iconName}.icns`);
    }
  }

  let resourceNames: string[] = [];
  try {
    resourceNames = await fs.readdir(resourcesPath);
  } catch {
    return undefined;
  }

  for (const candidate of candidates) {
    if (resourceNames.includes(candidate)) {
      return path.join(resourcesPath, candidate);
    }
  }

  const fallback = resourceNames.find((name) => path.extname(name).toLowerCase() === '.icns');
  return fallback ? path.join(resourcesPath, fallback) : undefined;
}

async function readMacBundleIconName(appPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c',
      'Print:CFBundleIconFile',
      path.join(appPath, 'Contents', 'Info.plist')
    ], { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function knownEditorLocations(
  appId: Exclude<OpenTargetAppId, 'default' | 'xcode'>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): KnownOpenAppLocation[] {
  const hostPath = platformPath(platform);
  if (platform === 'darwin') {
    const home = os.homedir();
    const applications = ['/Applications', hostPath.join(home, 'Applications')];
    const appNames: Record<typeof appId, string> = {
      vscode: 'Visual Studio Code.app',
      'vscode-insiders': 'Visual Studio Code - Insiders.app',
      cursor: 'Cursor.app',
      windsurf: 'Windsurf.app',
      sublime: 'Sublime Text.app',
      'intellij-idea': 'IntelliJ IDEA.app'
    };
    const appName = appNames[appId];
    return applications.map((base) => {
      const appPath = hostPath.join(base, appName);
      return {
        iconPath: appPath,
        executable: hostPath.join(appPath, macExecutableFor(appId))
      };
    });
  }

  if (platform === 'win32') {
    return windowsEditorLocations(appId, env);
  }

  return linuxEditorLocations(appId);
}

function macExecutableFor(
  appId: Exclude<OpenTargetAppId, 'default' | 'xcode'>
): string {
  switch (appId) {
    case 'vscode':
      return 'Contents/Resources/app/bin/code';
    case 'vscode-insiders':
      return 'Contents/Resources/app/bin/code-insiders';
    case 'cursor':
      return 'Contents/Resources/app/bin/cursor';
    case 'windsurf':
      return 'Contents/Resources/app/bin/windsurf';
    case 'sublime':
      return 'Contents/SharedSupport/bin/subl';
    case 'intellij-idea':
      return 'Contents/MacOS/idea';
  }
}

function windowsEditorLocations(
  appId: Exclude<OpenTargetAppId, 'default' | 'xcode'>,
  env: NodeJS.ProcessEnv
): KnownOpenAppLocation[] {
  const winPath = path.win32;
  const localAppData = env.LOCALAPPDATA ?? '';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const userProfile = env.USERPROFILE ?? '';
  switch (appId) {
    case 'vscode':
      {
        const appRoot = winPath.join(localAppData, 'Programs', 'Microsoft VS Code');
        return [
          {
            executable: winPath.join(appRoot, 'bin', 'code.cmd'),
            iconPath: winPath.join(appRoot, 'Code.exe')
          }
        ];
      }
    case 'vscode-insiders':
      {
        const appRoot = winPath.join(
          localAppData,
          'Programs',
          'Microsoft VS Code Insiders'
        );
        return [
          {
            executable: winPath.join(appRoot, 'bin', 'code-insiders.cmd'),
            iconPath: winPath.join(appRoot, 'Code - Insiders.exe')
          }
        ];
      }
    case 'cursor':
      {
        const appRoot = winPath.join(localAppData, 'Programs', 'Cursor');
        return [
          {
            executable: winPath.join(appRoot, 'resources', 'app', 'bin', 'cursor.cmd'),
            iconPath: winPath.join(appRoot, 'Cursor.exe')
          }
        ];
      }
    case 'windsurf':
      return [
        {
          executable: winPath.join(userProfile, '.codeium', 'windsurf', 'bin', 'windsurf.cmd'),
          iconPath: winPath.join(userProfile, '.codeium', 'windsurf', 'Windsurf.exe')
        }
      ];
    case 'sublime':
      {
        const appRoot = winPath.join(programFiles, 'Sublime Text');
        return [
          {
            executable: winPath.join(appRoot, 'subl.exe'),
            iconPath: winPath.join(appRoot, 'sublime_text.exe')
          }
        ];
      }
    case 'intellij-idea':
      return [
        {
          executable: winPath.join(localAppData, 'JetBrains', 'Toolbox', 'scripts', 'idea.cmd')
        },
        {
          executable: winPath.join(
            programFiles,
            'JetBrains',
            'IntelliJ IDEA',
            'bin',
            'idea64.exe'
          ),
          iconPath: winPath.join(
            programFiles,
            'JetBrains',
            'IntelliJ IDEA',
            'bin',
            'idea64.exe'
          )
        }
      ];
  }
}

function linuxEditorLocations(
  appId: Exclude<OpenTargetAppId, 'default' | 'xcode'>
): KnownOpenAppLocation[] {
  switch (appId) {
    case 'windsurf':
      return [{ executable: '~/.codeium/windsurf/bin/windsurf' }];
    default:
      return [];
  }
}

function codeLikeArgs(target: ResolvedOpenTarget): string[] {
  if (target.line && target.kind !== 'directory') {
    return ['--goto', targetWithLineSuffix(target)];
  }
  return [target.path];
}

function intellijArgs(target: ResolvedOpenTarget): string[] {
  if (target.kind === 'directory') {
    return [target.path];
  }
  const args: string[] = [];
  if (target.rootPath) {
    args.push(target.rootPath);
  }
  if (target.line) {
    args.push('--line', String(target.line));
  }
  if (target.column) {
    args.push('--column', String(target.column));
  }
  args.push(target.path);
  return args;
}

function targetWithLineSuffix(target: ResolvedOpenTarget): string {
  if (!target.line || target.kind === 'directory') {
    return target.path;
  }
  return target.column
    ? `${target.path}:${target.line}:${target.column}`
    : `${target.path}:${target.line}`;
}

function requireAppDefinition(appId: OpenTargetAppId): OpenAppDefinition {
  const definition = APP_DEFINITIONS.find((candidate) => candidate.id === appId);
  if (!definition) {
    throw new Error('Default app should be handled separately.');
  }
  return definition;
}

function appLabel(appId: OpenTargetAppId): string {
  return appId === DEFAULT_APP_ID
    ? 'Default app'
    : requireAppDefinition(appId).label;
}

function requireWorktree(
  snapshot: TaskSnapshot,
  worktreeId: string,
  taskId?: string
): WorktreeRecord {
  const worktree = snapshot.worktrees.find(
    (candidate) =>
      candidate.id === worktreeId && (!taskId || candidate.taskId === taskId)
  );
  if (!worktree) {
    throw new Error('Worktree is not recorded by Task Monki.');
  }
  return worktree;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function expandHome(value: string, hostPath: typeof path.posix | typeof path.win32): string {
  return value.startsWith('~/') ? hostPath.join(os.homedir(), value.slice(2)) : value;
}

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function comparablePath(filePath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Reveal in Finder';
  }
  if (platform === 'win32') {
    return 'Reveal in File Explorer';
  }
  return 'Show in Files';
}

async function launchPlatformOpen(platform: NodeJS.Platform, filePath: string): Promise<void> {
  if (platform === 'darwin') {
    await execFileAsync('open', [filePath]);
    return;
  }
  if (platform === 'win32') {
    await execFileAsync('explorer.exe', [filePath]);
    return;
  }
  await execFileAsync('xdg-open', [filePath]);
}

async function launchPlatformReveal(platform: NodeJS.Platform, filePath: string): Promise<void> {
  if (platform === 'darwin') {
    await execFileAsync('open', ['-R', filePath]);
    return;
  }
  if (platform === 'win32') {
    const stat = await fs.stat(filePath).catch(() => undefined);
    const argv = stat?.isDirectory() ? [filePath] : [`/select,${filePath}`];
    await execFileAsync('explorer.exe', argv);
    return;
  }
  const stat = await fs.stat(filePath).catch(() => undefined);
  await execFileAsync('xdg-open', [stat?.isDirectory() ? filePath : path.dirname(filePath)]);
}
