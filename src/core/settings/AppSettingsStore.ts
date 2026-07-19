import type {
  CodexExternalToolSettings,
  ExternalExecutablePathSettings,
  TaskManagerAppSettings,
  TaskManagerThemePreference
} from '../../shared/agent';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION
} from '../../shared/agent';
import type { UpdateAppSettingsRequest } from '../../shared/contracts';
import {
  readPrivateFile,
  writePrivateFileAtomically
} from '../filesystem/secureFilesystem';

const MAX_APP_SETTINGS_FILE_BYTES = 1024 * 1024;

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
    this.settings = mergeAppSettings(this.settings, input);
    await this.persistQueued();
    return cloneSettings(this.settings);
  }

  private async init(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let raw: Buffer;
    try {
      raw = await readPrivateFile(this.filePath, MAX_APP_SETTINGS_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.settings = normalizeAppSettings(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      await this.persist();
      this.loaded = true;
      return;
    }

    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    this.settings = normalizeAppSettings(JSON.parse(decoded) as unknown);

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
    await writePrivateFileAtomically(
      this.filePath,
      `${JSON.stringify(this.settings, null, 2)}\n`
    );
  }

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
        'Delete the local app settings and restart; migrations are intentionally not supported.'
    );
  }
  const record = value;
  if (!isCurrentAppSettingsRecord(record)) {
    throw new Error(
      `Task Monki app settings schema ${TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION} is invalid. ` +
        'Delete the local app settings and restart; fallback values are intentionally not applied.'
    );
  }
  return {
    schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
    theme: record.theme,
    sidebarCollapsed: record.sidebarCollapsed,
    showMascot: record.showMascot,
    firstLaunchSetupCompleted: record.firstLaunchSetupCompleted,
    defaultModel: record.defaultModel,
    defaultReasoningEffort: record.defaultReasoningEffort,
    promptRefinementModel: record.promptRefinementModel,
    reviewModel: record.reviewModel,
    reviewReasoningEffort: record.reviewReasoningEffort,
    codexExternalTools: { ...record.codexExternalTools },
    externalExecutables: { ...record.externalExecutables },
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
  if (input.sidebarCollapsed !== undefined) {
    patch.sidebarCollapsed = requireBoolean(input.sidebarCollapsed, 'sidebarCollapsed');
  }
  if (input.showMascot !== undefined) {
    patch.showMascot = requireBoolean(input.showMascot, 'showMascot');
  }
  if (input.firstLaunchSetupCompleted !== undefined) {
    patch.firstLaunchSetupCompleted = requireBoolean(
      input.firstLaunchSetupCompleted,
      'firstLaunchSetupCompleted'
    );
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
    'sidebarCollapsed',
    'showMascot',
    'firstLaunchSetupCompleted',
    'defaultModel',
    'defaultReasoningEffort',
    'promptRefinementModel',
    'reviewModel',
    'reviewReasoningEffort',
    'codexExternalTools',
    'externalExecutables',
    'selectedRepositoryId',
    'previewGateway'
  ]);
  const optionalStrings = [
    record.defaultModel,
    record.defaultReasoningEffort,
    record.promptRefinementModel,
    record.reviewModel,
    record.reviewReasoningEffort
  ];
  const tools = record.codexExternalTools;
  const executables = record.externalExecutables;
  const previewGateway = record.previewGateway;
  return (
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    (record.theme === 'light' || record.theme === 'dark' || record.theme === 'device') &&
    typeof record.sidebarCollapsed === 'boolean' &&
    typeof record.showMascot === 'boolean' &&
    typeof record.firstLaunchSetupCompleted === 'boolean' &&
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
    isCanonicalNullableString(record.selectedRepositoryId) &&
    isRecord(previewGateway) &&
    Object.keys(previewGateway).length === 1 &&
    (previewGateway.port === null ||
      (Number.isInteger(previewGateway.port) &&
        Number(previewGateway.port) >= 10_000 &&
        Number(previewGateway.port) <= 65_535))
  );
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
