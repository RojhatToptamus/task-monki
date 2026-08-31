import type {
  CodexExternalToolSettings,
  ExternalExecutablePathSettings,
  TaskManagerAppSettings,
  TaskManagerThemePreference,
  TaskManagerThemePreset
} from '../../shared/agent';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  isTaskManagerThemePreset,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
import type { UpdateAppSettingsRequest } from '../../shared/contracts';
import {
  AppDatabase,
  AppDatabaseTransaction,
  type SqlRowValue
} from '../storage/sqlite/AppDatabase';

export interface AppSettingsStorage {
  get(): Promise<TaskManagerAppSettings>;
  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings>;
}

export class AppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS;
  private recordRevision = 0;
  private loaded = false;
  private initialization?: Promise<void>;

  constructor(
    private readonly database: AppDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(): Promise<TaskManagerAppSettings> {
    await this.init();
    return this.database.read((reader) => {
      const local =
        reader instanceof AppDatabaseTransaction
          ? reader.getLocal<SettingsTransactionState>(this)
          : undefined;
      return cloneSettings(local?.settings ?? this.settings);
    });
  }

  async update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    await this.init();
    return this.database.write((transaction) => {
      const local = transaction.getOrCreateLocal<SettingsTransactionState>(this, () => {
        const state: SettingsTransactionState = {
          settings: cloneSettings(this.settings),
          recordRevision: this.recordRevision,
          publishRegistered: false
        };
        return state;
      });
      if (!local.publishRegistered) {
        local.publishRegistered = true;
        transaction.afterCommit(() => {
          this.settings = cloneSettings(local.settings);
          this.recordRevision = local.recordRevision;
        });
      }
      const candidate = mergeAppSettings(local.settings, input);
      const nextRevision = local.recordRevision + 1;
      const result = transaction.run(
        `UPDATE app_settings
         SET record_revision = ?, settings_json = ?, updated_at = ?
         WHERE singleton_id = 1 AND record_revision = ?`,
        [nextRevision, JSON.stringify(candidate), this.now(), local.recordRevision]
      );
      if (Number(result.changes) !== 1) {
        throw new Error('Application settings changed before they could be updated.');
      }
      local.settings = candidate;
      local.recordRevision = nextRevision;
      return cloneSettings(candidate);
    });
  }

  private async init(): Promise<void> {
    if (this.loaded) return;
    if (this.database.hasCurrentWriteTransaction()) {
      throw new Error(
        'Application settings must be initialized before joining an outer database transaction.'
      );
    }
    this.initialization ??= this.initialize().finally(() => {
      this.initialization = undefined;
    });
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    const stored = await this.database.read((reader) =>
      reader.get<{
        record_revision: SqlRowValue;
        settings_json: SqlRowValue;
      }>(
        `SELECT record_revision, settings_json
         FROM app_settings
         WHERE singleton_id = 1`
      )
    );
    if (!stored) {
      const defaults = normalizeAppSettings(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      await this.database.write((transaction) => {
        transaction.run(
          `INSERT INTO app_settings (
             singleton_id, record_revision, settings_json, updated_at
           ) VALUES (1, 0, ?, ?)
           ON CONFLICT(singleton_id) DO NOTHING`,
          [JSON.stringify(defaults), this.now()]
        );
      });
      const created = await this.database.read((reader) =>
        reader.get<{ record_revision: SqlRowValue; settings_json: SqlRowValue }>(
          `SELECT record_revision, settings_json
           FROM app_settings
           WHERE singleton_id = 1`
        )
      );
      if (!created) throw new Error('Application settings could not be initialized.');
      this.loadStoredSettings(created);
    } else {
      this.loadStoredSettings(stored);
    }
    this.loaded = true;
  }

  private loadStoredSettings(stored: {
    record_revision: SqlRowValue;
    settings_json: SqlRowValue;
  }): void {
    if (
      typeof stored.record_revision !== 'number' ||
      !Number.isSafeInteger(stored.record_revision) ||
      stored.record_revision < 0 ||
      typeof stored.settings_json !== 'string'
    ) {
      throw new Error('Stored application settings metadata is invalid.');
    }
    this.settings = normalizeAppSettings(JSON.parse(stored.settings_json) as unknown);
    this.recordRevision = stored.record_revision;
  }
}

interface SettingsTransactionState {
  settings: TaskManagerAppSettings;
  recordRevision: number;
  publishRegistered: boolean;
}

export class MemoryAppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings;

  constructor(initialSettings: Partial<TaskManagerAppSettings> = {}) {
    this.settings = normalizeAppSettings({
      ...structuredClone(DEFAULT_TASK_MANAGER_APP_SETTINGS),
      ...initialSettings,
      schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
    });
  }

  get(): Promise<TaskManagerAppSettings> {
    return Promise.resolve(cloneSettings(this.settings));
  }

  async update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    this.settings = mergeAppSettings(this.settings, input);
    return cloneSettings(this.settings);
  }
}

export function normalizeAppSettings(value: unknown): TaskManagerAppSettings {
  if (!isRecord(value) || value.schemaVersion !== TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION) {
    const schemaVersion = isRecord(value) ? value.schemaVersion : undefined;
    throw new Error(
      `Unsupported Task Monki app settings schema ${String(schemaVersion)}. ` +
        'Reset the local application settings or restore a compatible backup.'
    );
  }
  const record = value;
  if (!isCurrentAppSettingsRecord(record)) {
    throw new Error(
      `Task Monki app settings schema ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION} is invalid. ` +
        'Reset the local application settings or restore a backup; fallback values are intentionally not applied.'
    );
  }
  return {
    schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
    theme: record.theme,
    themePreset: record.themePreset,
    sidebarCollapsed: record.sidebarCollapsed,
    showMascot: record.showMascot,
    autoInstallUpdatesOnQuit: record.autoInstallUpdatesOnQuit,
    firstLaunchSetupCompleted: record.firstLaunchSetupCompleted,
    disabledRuntimeIds: [...record.disabledRuntimeIds],
    defaultRuntimeId: record.defaultRuntimeId,
    defaultModel: record.defaultModel,
    defaultModelProvider: record.defaultModelProvider,
    defaultReasoningEffort: record.defaultReasoningEffort,
    promptRefinementModel: record.promptRefinementModel,
    promptRefinementRuntimeId: record.promptRefinementRuntimeId,
    promptRefinementModelProvider: record.promptRefinementModelProvider,
    previewRecipeGenerationModel: record.previewRecipeGenerationModel,
    previewRecipeGenerationRuntimeId: record.previewRecipeGenerationRuntimeId,
    previewRecipeGenerationModelProvider:
      record.previewRecipeGenerationModelProvider,
    reviewModel: record.reviewModel,
    reviewRuntimeId: record.reviewRuntimeId,
    reviewModelProvider: record.reviewModelProvider,
    reviewReasoningEffort: record.reviewReasoningEffort,
    codexExternalTools: { ...record.codexExternalTools },
    externalExecutables: { ...record.externalExecutables },
    runtimeExecutablePaths: { ...record.runtimeExecutablePaths },
    selectedRepositoryId: record.selectedRepositoryId,
    previewGateway: { ...record.previewGateway }
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
  if (input.themePreset !== undefined) {
    patch.themePreset = normalizeThemePreset(input.themePreset);
  }
  if (input.sidebarCollapsed !== undefined) {
    patch.sidebarCollapsed = requireBoolean(input.sidebarCollapsed, 'sidebarCollapsed');
  }
  if (input.showMascot !== undefined) {
    patch.showMascot = requireBoolean(input.showMascot, 'showMascot');
  }
  if (input.autoInstallUpdatesOnQuit !== undefined) {
    patch.autoInstallUpdatesOnQuit = requireBoolean(
      input.autoInstallUpdatesOnQuit,
      'autoInstallUpdatesOnQuit'
    );
  }
  if (input.firstLaunchSetupCompleted !== undefined) {
    patch.firstLaunchSetupCompleted = requireBoolean(
      input.firstLaunchSetupCompleted,
      'firstLaunchSetupCompleted'
    );
  }
  if (input.disabledRuntimeIds !== undefined) {
    patch.disabledRuntimeIds = normalizeRuntimeIds(input.disabledRuntimeIds);
  }
  if (input.defaultRuntimeId !== undefined) {
    patch.defaultRuntimeId = requireString(input.defaultRuntimeId, 'defaultRuntimeId');
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
  if ('previewRecipeGenerationModel' in input) {
    patch.previewRecipeGenerationModel = normalizeOptionalString(
      input.previewRecipeGenerationModel
    );
  }
  if ('previewRecipeGenerationRuntimeId' in input) {
    patch.previewRecipeGenerationRuntimeId = normalizeOptionalString(
      input.previewRecipeGenerationRuntimeId
    );
  }
  if ('previewRecipeGenerationModelProvider' in input) {
    patch.previewRecipeGenerationModelProvider = normalizeOptionalString(
      input.previewRecipeGenerationModelProvider
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
  if (input.codexExternalTools !== undefined) {
    if (!isRecord(input.codexExternalTools)) {
      throw new Error('codexExternalTools must be an object.');
    }
    patch.codexExternalTools = normalizeCodexExternalTools({
      ...current.codexExternalTools,
      ...input.codexExternalTools
    });
  }
  if (input.externalExecutables !== undefined) {
    if (!isRecord(input.externalExecutables)) {
      throw new Error('externalExecutables must be an object.');
    }
    patch.externalExecutables = normalizeExternalExecutables({
      ...current.externalExecutables,
      ...input.externalExecutables
    });
  }
  if (input.runtimeExecutablePaths !== undefined) {
    if (!isRecord(input.runtimeExecutablePaths)) {
      throw new Error('runtimeExecutablePaths must be an object.');
    }
    patch.runtimeExecutablePaths = normalizeRuntimeExecutablePaths({
      ...current.runtimeExecutablePaths,
      ...input.runtimeExecutablePaths
    });
  }
  if ('selectedRepositoryId' in input) {
    patch.selectedRepositoryId = normalizeOptionalString(input.selectedRepositoryId) ?? null;
  }
  if (input.previewGateway) {
    patch.previewGateway = normalizePreviewGateway({
      ...current.previewGateway,
      ...input.previewGateway
    });
  }
  return normalizeAppSettings({
    ...current,
    ...patch
  });
}

function normalizeTheme(value: unknown): TaskManagerThemePreference {
  if (value !== 'light' && value !== 'dark' && value !== 'device') {
    throw new Error('Theme must be light, dark, or device.');
  }
  return value;
}

function normalizeThemePreset(value: unknown): TaskManagerThemePreset {
  if (!isTaskManagerThemePreset(value)) {
    throw new Error('Theme preset is not supported.');
  }
  return value;
}

function normalizeCodexExternalTools(value: unknown): CodexExternalToolSettings {
  if (!isRecord(value)) {
    throw new Error('Codex external tool settings are invalid.');
  }
  if (
    !['disabled', 'cached', 'live'].includes(String(value.webSearchMode)) ||
    !['disabled', 'all'].includes(String(value.mcpServers)) ||
    !['disabled', 'enabled'].includes(String(value.apps))
  ) {
    throw new Error('Codex external tool settings are invalid.');
  }
  return {
    webSearchMode: value.webSearchMode as CodexExternalToolSettings['webSearchMode'],
    mcpServers: value.mcpServers as CodexExternalToolSettings['mcpServers'],
    apps: value.apps as CodexExternalToolSettings['apps']
  };
}

function normalizeExternalExecutables(value: unknown): ExternalExecutablePathSettings {
  if (!isRecord(value)) {
    throw new Error('External executable settings are invalid.');
  }
  return {
    gitExecutablePath: normalizeExecutablePath(value.gitExecutablePath),
    codexExecutablePath: normalizeExecutablePath(value.codexExecutablePath),
    ghExecutablePath: normalizeExecutablePath(value.ghExecutablePath)
  };
}

function normalizeRuntimeExecutablePaths(
  value: unknown
): TaskManagerAppSettings['runtimeExecutablePaths'] {
  if (!isRecord(value)) {
    throw new Error('Runtime executable settings are invalid.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([runtimeId, executable]) => [
      requireString(runtimeId, 'Runtime id'),
      normalizeExecutablePath(executable)
    ])
  );
}

function normalizeRuntimeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('disabledRuntimeIds must be an array.');
  }
  return [...new Set(value.map((runtimeId) => requireString(runtimeId, 'Runtime id')))];
}

function normalizePreviewGateway(value: unknown): TaskManagerAppSettings['previewGateway'] {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new Error('Preview gateway settings are invalid.');
  }
  const port = value.port;
  if (port !== null && (!Number.isInteger(port) || Number(port) < 10_000 || Number(port) > 65_535)) {
    throw new Error('Preview gateway port must be null or an integer from 10000 to 65535.');
  }
  return { port: port === null ? null : Number(port) };
}

function normalizeExecutablePath(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Executable paths must be strings or null.');
  }
  return normalizeOptionalString(value) ?? null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Setting values must be strings or null.');
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} must be a non-empty string.`);
  return normalized;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function isCurrentAppSettingsRecord(
  record: Record<string, unknown>
): record is Record<string, unknown> & TaskManagerAppSettings {
  const allowedKeys = new Set([
    'schemaVersion',
    'theme',
    'themePreset',
    'sidebarCollapsed',
    'showMascot',
    'autoInstallUpdatesOnQuit',
    'firstLaunchSetupCompleted',
    'disabledRuntimeIds',
    'defaultRuntimeId',
    'defaultModel',
    'defaultModelProvider',
    'defaultReasoningEffort',
    'promptRefinementModel',
    'promptRefinementRuntimeId',
    'promptRefinementModelProvider',
    'previewRecipeGenerationModel',
    'previewRecipeGenerationRuntimeId',
    'previewRecipeGenerationModelProvider',
    'reviewModel',
    'reviewRuntimeId',
    'reviewModelProvider',
    'reviewReasoningEffort',
    'codexExternalTools',
    'externalExecutables',
    'runtimeExecutablePaths',
    'selectedRepositoryId',
    'previewGateway'
  ]);
  const optionalStrings = [
    record.defaultModel,
    record.defaultModelProvider,
    record.defaultReasoningEffort,
    record.promptRefinementModel,
    record.promptRefinementRuntimeId,
    record.promptRefinementModelProvider,
    record.previewRecipeGenerationModel,
    record.previewRecipeGenerationRuntimeId,
    record.previewRecipeGenerationModelProvider,
    record.reviewModel,
    record.reviewRuntimeId,
    record.reviewModelProvider,
    record.reviewReasoningEffort
  ];
  const tools = record.codexExternalTools;
  const executables = record.externalExecutables;
  const runtimeExecutablePaths = record.runtimeExecutablePaths;
  const previewGateway = record.previewGateway;
  return (
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    (record.theme === 'light' || record.theme === 'dark' || record.theme === 'device') &&
    isTaskManagerThemePreset(record.themePreset) &&
    typeof record.sidebarCollapsed === 'boolean' &&
    typeof record.showMascot === 'boolean' &&
    typeof record.autoInstallUpdatesOnQuit === 'boolean' &&
    typeof record.firstLaunchSetupCompleted === 'boolean' &&
    Array.isArray(record.disabledRuntimeIds) &&
    record.disabledRuntimeIds.every(isCanonicalRequiredString) &&
    new Set(record.disabledRuntimeIds).size === record.disabledRuntimeIds.length &&
    isCanonicalRequiredString(record.defaultRuntimeId) &&
    optionalStrings.every(isCanonicalOptionalString) &&
    isRecord(tools) &&
    Object.keys(tools).length === 3 &&
    ['disabled', 'cached', 'live'].includes(String(tools.webSearchMode)) &&
    ['disabled', 'all'].includes(String(tools.mcpServers)) &&
    ['disabled', 'enabled'].includes(String(tools.apps)) &&
    isRecord(executables) &&
    Object.keys(executables).length === 3 &&
    isCanonicalNullableString(executables.gitExecutablePath) &&
    isCanonicalNullableString(executables.codexExecutablePath) &&
    isCanonicalNullableString(executables.ghExecutablePath) &&
    isRecord(runtimeExecutablePaths) &&
    Object.entries(runtimeExecutablePaths).every(
      ([runtimeId, executable]) =>
        isCanonicalRequiredString(runtimeId) && isCanonicalNullableString(executable)
    ) &&
    isCanonicalNullableString(record.selectedRepositoryId) &&
    isRecord(previewGateway) &&
    Object.keys(previewGateway).length === 1 &&
    (previewGateway.port === null ||
      (Number.isInteger(previewGateway.port) &&
        Number(previewGateway.port) >= 10_000 &&
        Number(previewGateway.port) <= 65_535))
  );
}

function isCanonicalRequiredString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCanonicalOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.trim() === value);
}

function isCanonicalNullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0 && value.trim() === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(settings: TaskManagerAppSettings): TaskManagerAppSettings {
  return structuredClone(settings);
}
