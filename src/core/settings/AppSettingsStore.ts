import crypto from 'node:crypto';
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
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
import type { UpdateAppSettingsRequest } from '../../shared/contracts';
import { syncDirectoryIfSupported } from '../filesystem/secureFilesystem';

export interface AppSettingsStorage {
  initializeRepositories(
    migrate: RepositorySettingsMigration
  ): Promise<void>;
  get(): Promise<TaskManagerAppSettings>;
  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings>;
  setSelectedRepositoryId(repositoryId: string | null): Promise<TaskManagerAppSettings>;
}

export interface LegacyRepositorySettings {
  knownPaths: string[];
  selectedPath: string | null;
}

export type RepositorySettingsMigration = (
  legacy: LegacyRepositorySettings
) => Promise<{ selectedRepositoryId: string | null }>;

export class AppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private loaded = false;
  private initPromise?: Promise<void>;
  private repositoryMigration?: RepositorySettingsMigration;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initializeRepositories(migrate: RepositorySettingsMigration): Promise<void> {
    if (this.repositoryMigration && this.repositoryMigration !== migrate) {
      throw new Error('App settings repository migration was configured more than once.');
    }
    this.repositoryMigration = migrate;
    await this.init();
  }

  async get(): Promise<TaskManagerAppSettings> {
    await this.init();
    return cloneSettings(this.settings);
  }

  async update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    await this.init();
    this.settings = mergeAppSettings(this.settings, input);
    await this.persistQueued();
    return cloneSettings(this.settings);
  }

  async setSelectedRepositoryId(
    repositoryId: string | null
  ): Promise<TaskManagerAppSettings> {
    await this.init();
    this.settings = normalizeAppSettings({
      ...this.settings,
      repositories: { selectedRepositoryId: normalizeRepositoryId(repositoryId) }
    });
    await this.persistQueued();
    return cloneSettings(this.settings);
  }

  private async init(): Promise<void> {
    if (this.loaded) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
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
    assertSupportedSettingsSchema(parsed);
    if (settingsSchemaVersion(parsed) < TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION) {
      if (!this.repositoryMigration) {
        throw new Error(
          'Task Monki app settings require repository-registry migration before they can be loaded.'
        );
      }
      const legacy = readLegacyRepositorySettings(parsed);
      await this.ensurePreV4Backup(raw);
      const migrated = await this.repositoryMigration(legacy);
      const record = isRecord(parsed) ? parsed : {};
      this.settings = normalizeAppSettings({
        ...record,
        firstLaunchSetupCompleted:
          typeof record.firstLaunchSetupCompleted === 'boolean'
            ? record.firstLaunchSetupCompleted
            : Boolean(legacy.selectedPath || legacy.knownPaths.length > 0),
        repositories: {
          selectedRepositoryId: migrated.selectedRepositoryId
        }
      });
      await this.persist();
    } else {
      this.settings = normalizeAppSettings(parsed);
    }

    this.loaded = true;
  }

  private async persistQueued(): Promise<void> {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => this.persist());
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const tmpPath = path.join(
      directory,
      `.${path.basename(this.filePath)}-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmpPath, this.filePath);
      await syncDirectoryIfSupported(directory);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
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

  private async ensurePreV4Backup(raw: string): Promise<void> {
    const backupPath = `${this.filePath}.pre-v4-backup`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const handle = await fs.open(backupPath, 'wx', 0o600);
      try {
        await handle.writeFile(raw, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await fs.readFile(backupPath, 'utf8');
      if (existing !== raw) {
        throw new Error(
          'The pre-v4 app-settings backup does not match the settings being migrated. Preserve both files and resolve the conflict before retrying.'
        );
      }
    }
  }
}

function assertSupportedSettingsSchema(value: unknown): void {
  if (!isRecord(value) || value.schemaVersion === undefined) return;
  if (typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion)) {
    throw new Error('Task Monki app settings contain an invalid schema version.');
  }
  if (value.schemaVersion < 1) {
    throw new Error('Task Monki app settings contain an invalid schema version.');
  }
  if (value.schemaVersion > TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `Task Monki app settings schema ${value.schemaVersion} is newer than this app supports. Upgrade Task Monki or restore a compatible backup.`
    );
  }
}

function settingsSchemaVersion(value: unknown): number {
  if (!isRecord(value) || value.schemaVersion === undefined) return 3;
  return value.schemaVersion as number;
}

export class MemoryAppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings;

  constructor(initialSettings: Partial<TaskManagerAppSettings> = {}) {
    this.settings = normalizeAppSettings(initialSettings);
  }

  initializeRepositories(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<TaskManagerAppSettings> {
    return Promise.resolve(cloneSettings(this.settings));
  }

  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    this.settings = mergeAppSettings(this.settings, input);
    return Promise.resolve(cloneSettings(this.settings));
  }


  setSelectedRepositoryId(repositoryId: string | null): Promise<TaskManagerAppSettings> {
    this.settings = normalizeAppSettings({
      ...this.settings,
      repositories: { selectedRepositoryId: normalizeRepositoryId(repositoryId) }
    });
    return Promise.resolve(cloneSettings(this.settings));
  }
}

export function normalizeAppSettings(value: unknown): TaskManagerAppSettings {
  const record = isRecord(value) ? value : {};
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
    firstLaunchSetupCompleted: normalizeFirstLaunchSetupCompleted(
      record.firstLaunchSetupCompleted,
      repositories
    ),
    defaultModel: normalizeOptionalString(record.defaultModel),
    defaultReasoningEffort: normalizeOptionalString(record.defaultReasoningEffort),
    promptRefinementModel: normalizeOptionalString(record.promptRefinementModel),
    reviewModel: normalizeOptionalString(record.reviewModel),
    reviewReasoningEffort: normalizeOptionalString(record.reviewReasoningEffort),
    codexExternalTools: normalizeCodexExternalTools(record.codexExternalTools),
    externalExecutables: normalizeExternalExecutables(record.externalExecutables),
    repositories
  };
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
  if ('defaultModel' in input) {
    patch.defaultModel = normalizeOptionalString(input.defaultModel);
  }
  if ('defaultReasoningEffort' in input) {
    patch.defaultReasoningEffort = normalizeOptionalString(input.defaultReasoningEffort);
  }
  if ('promptRefinementModel' in input) {
    patch.promptRefinementModel = normalizeOptionalString(input.promptRefinementModel);
  }
  if ('reviewModel' in input) {
    patch.reviewModel = normalizeOptionalString(input.reviewModel);
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

function normalizeRepositories(value: unknown): TaskManagerRepositorySettings {
  const record = isRecord(value) ? value : {};
  return {
    selectedRepositoryId: normalizeRepositoryId(record.selectedRepositoryId)
  };
}

function normalizeFirstLaunchSetupCompleted(
  value: unknown,
  repositories: TaskManagerRepositorySettings
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return Boolean(repositories.selectedRepositoryId);
}

function normalizeRepositoryId(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  if (Buffer.byteLength(normalized, 'utf8') > 256) {
    throw new Error('Selected repository id exceeds its safety limit.');
  }
  return normalized;
}

function readLegacyRepositorySettings(value: unknown): LegacyRepositorySettings {
  const repositories = isRecord(value) && isRecord(value.repositories)
    ? value.repositories
    : {};
  return {
    knownPaths: Array.isArray(repositories.knownPaths)
      ? uniqueStrings(
          repositories.knownPaths.map((candidate) => normalizeOptionalString(candidate))
        )
      : [],
    selectedPath: normalizeOptionalString(repositories.selectedPath) ?? null
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
