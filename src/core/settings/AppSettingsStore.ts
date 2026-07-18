import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodexExternalToolSettings,
  ExternalExecutablePathSettings,
  TaskManagerAppSettings,
  TaskManagerRepositorySettings,
  TaskManagerThemePreference
} from '../../shared/agent';
import {
  CODEX_RUNTIME_ID,
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
import type { UpdateAppSettingsRequest } from '../../shared/contracts';

export interface AppSettingsStorage {
  get(): Promise<TaskManagerAppSettings>;
  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings>;
}

export class AppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private loaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(): Promise<TaskManagerAppSettings> {
    await this.init();
    return cloneSettings(this.settings);
  }

  async update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    await this.init();
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const candidate = mergeAppSettings(this.settings, input);
        await this.persist(candidate);
        this.settings = candidate;
        return cloneSettings(candidate);
      });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.settings = normalizeAppSettings(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      await this.persist();
      this.loaded = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.moveInvalidSettingsFileAside();
      this.settings = normalizeAppSettings(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      await this.persist();
      this.loaded = true;
      return;
    }

    assertPersistedSettingsSchema(parsed);
    this.settings = normalizeAppSettings(parsed);

    if (raw !== serializeAppSettings(this.settings)) {
      await this.persist();
    }

    this.loaded = true;
  }

  private async persist(settings = this.settings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, serializeAppSettings(settings), {
      encoding: 'utf8',
      mode: 0o600
    });
    await fs.rename(tmpPath, this.filePath);
  }

  private async moveInvalidSettingsFileAside(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[^0-9A-Za-z_-]/g, '-');
    const backupPath = `${this.filePath}.invalid-${timestamp}`;
    try {
      await fs.rename(this.filePath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function serializeAppSettings(settings: TaskManagerAppSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export class MemoryAppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings;

  constructor(initialSettings: Partial<TaskManagerAppSettings> = {}) {
    this.settings = normalizeAppSettings(initialSettings);
  }

  get(): Promise<TaskManagerAppSettings> {
    return Promise.resolve(cloneSettings(this.settings));
  }

  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    this.settings = mergeAppSettings(this.settings, input);
    return Promise.resolve(cloneSettings(this.settings));
  }
}

export function normalizeAppSettings(value: unknown): TaskManagerAppSettings {
  const record = isRecord(value) ? value : {};
  assertSupportedSchemaVersion(record.schemaVersion);
  const repositories = normalizeRepositories(record.repositories);
  return {
    schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
    theme: normalizeTheme(record.theme),
    sidebarCollapsed:
      typeof record.sidebarCollapsed === 'boolean'
        ? record.sidebarCollapsed
        : DEFAULT_TASK_MANAGER_APP_SETTINGS.sidebarCollapsed,
    showMascot:
      typeof record.showMascot === 'boolean'
        ? record.showMascot
        : DEFAULT_TASK_MANAGER_APP_SETTINGS.showMascot,
    firstLaunchSetupCompleted:
      typeof record.firstLaunchSetupCompleted === 'boolean'
        ? record.firstLaunchSetupCompleted
        : DEFAULT_TASK_MANAGER_APP_SETTINGS.firstLaunchSetupCompleted,
    disabledRuntimeIds: normalizeRuntimeIds(record.disabledRuntimeIds),
    defaultRuntimeId: normalizeOptionalString(record.defaultRuntimeId) ?? CODEX_RUNTIME_ID,
    defaultModel: normalizeOptionalString(record.defaultModel),
    defaultModelProvider: normalizeOptionalString(record.defaultModelProvider),
    defaultReasoningEffort: normalizeOptionalString(record.defaultReasoningEffort),
    promptRefinementModel: normalizeOptionalString(record.promptRefinementModel),
    promptRefinementRuntimeId: normalizeOptionalString(record.promptRefinementRuntimeId),
    promptRefinementModelProvider: normalizeOptionalString(
      record.promptRefinementModelProvider
    ),
    reviewModel: normalizeOptionalString(record.reviewModel),
    reviewRuntimeId: normalizeOptionalString(record.reviewRuntimeId),
    reviewModelProvider: normalizeOptionalString(record.reviewModelProvider),
    reviewReasoningEffort: normalizeOptionalString(record.reviewReasoningEffort),
    codexExternalTools: normalizeCodexExternalTools(record.codexExternalTools),
    externalExecutables: normalizeExternalExecutables(record.externalExecutables),
    runtimeExecutablePaths: normalizeRuntimeExecutablePaths(record.runtimeExecutablePaths),
    repositories
  };
}

function assertSupportedSchemaVersion(value: unknown): void {
  if (value === undefined) return;
  if (value !== TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported app settings schema ${String(value)}. This build accepts only schema ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION}.`
    );
  }
}

function assertPersistedSettingsSchema(value: unknown): void {
  if (!isRecord(value) || value.schemaVersion !== TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported app settings schema ${String(isRecord(value) ? value.schemaVersion : undefined)}. This build accepts only schema ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION}.`
    );
  }
}

export function mergeAppSettings(
  current: TaskManagerAppSettings,
  input: UpdateAppSettingsRequest
): TaskManagerAppSettings {
  const patch: Partial<TaskManagerAppSettings> = {};
  if (input.theme !== undefined) {
    patch.theme = normalizeTheme(input.theme);
  }
  if (input.sidebarCollapsed !== undefined) {
    patch.sidebarCollapsed = input.sidebarCollapsed === true;
  }
  if (input.showMascot !== undefined) {
    patch.showMascot = input.showMascot === true;
  }
  if (input.firstLaunchSetupCompleted !== undefined) {
    patch.firstLaunchSetupCompleted = input.firstLaunchSetupCompleted === true;
  }
  if (input.disabledRuntimeIds !== undefined) {
    patch.disabledRuntimeIds = normalizeRuntimeIds(input.disabledRuntimeIds);
  }
  if (input.defaultRuntimeId !== undefined) {
    patch.defaultRuntimeId = normalizeOptionalString(input.defaultRuntimeId) ?? CODEX_RUNTIME_ID;
  }
  if ('defaultModel' in input) {
    patch.defaultModel = normalizeOptionalString(input.defaultModel);
  }
  if ('defaultModelProvider' in input) {
    patch.defaultModelProvider = normalizeOptionalString(input.defaultModelProvider);
  }
  if ('defaultReasoningEffort' in input) {
    patch.defaultReasoningEffort = normalizeOptionalString(input.defaultReasoningEffort);
  }
  if ('promptRefinementModel' in input) {
    patch.promptRefinementModel = normalizeOptionalString(input.promptRefinementModel);
  }
  if ('promptRefinementRuntimeId' in input) {
    patch.promptRefinementRuntimeId = normalizeOptionalString(input.promptRefinementRuntimeId);
  }
  if ('promptRefinementModelProvider' in input) {
    patch.promptRefinementModelProvider = normalizeOptionalString(
      input.promptRefinementModelProvider
    );
  }
  if ('reviewModel' in input) {
    patch.reviewModel = normalizeOptionalString(input.reviewModel);
  }
  if ('reviewRuntimeId' in input) {
    patch.reviewRuntimeId = normalizeOptionalString(input.reviewRuntimeId);
  }
  if ('reviewModelProvider' in input) {
    patch.reviewModelProvider = normalizeOptionalString(input.reviewModelProvider);
  }
  if ('reviewReasoningEffort' in input) {
    patch.reviewReasoningEffort = normalizeOptionalString(input.reviewReasoningEffort);
  }
  if (input.codexExternalTools) {
    patch.codexExternalTools = normalizeCodexExternalTools({
      ...current.codexExternalTools,
      ...input.codexExternalTools
    });
  }
  if (input.externalExecutables) {
    patch.externalExecutables = normalizeExternalExecutables({
      ...current.externalExecutables,
      ...input.externalExecutables
    });
  }
  if (input.runtimeExecutablePaths) {
    patch.runtimeExecutablePaths = normalizeRuntimeExecutablePaths({
      ...current.runtimeExecutablePaths,
      ...input.runtimeExecutablePaths
    });
  }
  if (input.repositories) {
    patch.repositories = normalizeRepositories({
      ...current.repositories,
      ...input.repositories
    });
  }
  return normalizeAppSettings({
    ...current,
    ...patch
  });
}

function normalizeTheme(value: unknown): TaskManagerThemePreference {
  return value === 'light' || value === 'dark' || value === 'device' ? value : 'device';
}

function normalizeCodexExternalTools(value: unknown): CodexExternalToolSettings {
  const record = isRecord(value) ? value : {};
  return {
    webSearchMode:
      record.webSearchMode === 'cached' || record.webSearchMode === 'live'
        ? record.webSearchMode
        : 'disabled',
    mcpServers: record.mcpServers === 'all' ? 'all' : 'disabled',
    apps: record.apps === 'enabled' ? 'enabled' : 'disabled'
  };
}

function normalizeExternalExecutables(value: unknown): ExternalExecutablePathSettings {
  const record = isRecord(value) ? value : {};
  return {
    gitExecutablePath: normalizeExecutablePath(record.gitExecutablePath),
    codexExecutablePath: normalizeExecutablePath(record.codexExecutablePath),
    ghExecutablePath: normalizeExecutablePath(record.ghExecutablePath)
  };
}

function normalizeRuntimeExecutablePaths(
  value: unknown
): TaskManagerAppSettings['runtimeExecutablePaths'] {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([runtimeId, executable]) => {
      const normalizedRuntimeId = normalizeOptionalString(runtimeId);
      if (!normalizedRuntimeId || normalizedRuntimeId !== runtimeId) {
        return [];
      }
      return [[runtimeId, normalizeExecutablePath(executable)]];
    })
  );
}

function normalizeRuntimeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((candidate) => normalizeOptionalString(candidate)));
}

function normalizeRepositories(value: unknown): TaskManagerRepositorySettings {
  const record = isRecord(value) ? value : {};
  const knownPaths = Array.isArray(record.knownPaths)
    ? uniqueStrings(record.knownPaths.map((candidate) => normalizeOptionalString(candidate)))
    : [];
  const selectedPath = normalizeOptionalString(record.selectedPath) ?? null;
  return {
    knownPaths,
    selectedPath
  };
}

function normalizeExecutablePath(value: unknown): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(settings: TaskManagerAppSettings): TaskManagerAppSettings {
  return structuredClone(settings);
}
