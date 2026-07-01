import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodexExternalToolSettings,
  ExternalExecutablePathSettings,
  TaskManagerAppSettings,
  TaskManagerRepositorySettings,
  TaskManagerThemePreference
} from '../../shared/agent';
import { DEFAULT_TASK_MANAGER_APP_SETTINGS } from '../../shared/agent';
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
    this.settings = mergeAppSettings(this.settings, input);
    await this.persistQueued();
    return cloneSettings(this.settings);
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

    try {
      this.settings = normalizeAppSettings(JSON.parse(raw) as unknown);
    } catch {
      await this.moveInvalidSettingsFileAside();
      this.settings = normalizeAppSettings(DEFAULT_TASK_MANAGER_APP_SETTINGS);
      await this.persist();
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.settings, null, 2)}\n`, {
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

export class MemoryAppSettingsStore implements AppSettingsStorage {
  private settings: TaskManagerAppSettings;

  constructor(initialSettings: Partial<TaskManagerAppSettings> = {}) {
    this.settings = normalizeAppSettings({
      ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
      ...initialSettings
    });
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
  return {
    schemaVersion: 1,
    theme: normalizeTheme(record.theme),
    sidebarCollapsed:
      typeof record.sidebarCollapsed === 'boolean'
        ? record.sidebarCollapsed
        : DEFAULT_TASK_MANAGER_APP_SETTINGS.sidebarCollapsed,
    defaultModel: normalizeOptionalString(record.defaultModel),
    defaultReasoningEffort: normalizeOptionalString(record.defaultReasoningEffort),
    promptRefinementModel: normalizeOptionalString(record.promptRefinementModel),
    reviewModel: normalizeOptionalString(record.reviewModel),
    reviewReasoningEffort: normalizeOptionalString(record.reviewReasoningEffort),
    codexExternalTools: normalizeCodexExternalTools(record.codexExternalTools),
    externalExecutables: normalizeExternalExecutables(record.externalExecutables),
    repositories: normalizeRepositories(record.repositories)
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
