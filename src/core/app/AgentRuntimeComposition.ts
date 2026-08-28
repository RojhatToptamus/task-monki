import type { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import type { TaskManagerAppSettings } from '../../shared/contracts';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import type {
  AgentRuntimeStore,
  TaskAgentRuntimeAccess
} from '../agent/AgentRuntimeStore';
import { AcpRuntimeAdapter } from '../agent/acp/AcpRuntimeAdapter';
import { ACP_RUNTIME_PROFILES } from '../agent/acp/AcpRuntimeProfiles';
import { CodexAppServerAdapter } from '../agent/codex/CodexAppServerAdapter';
import { OpenCodeAdapter } from '../agent/opencode/OpenCodeAdapter';

export interface BuiltInAgentRuntimeOptions {
  cwd: string;
  codexExecutable?: string;
  openCodeExecutable?: string;
  acpExecutablePaths?: Partial<Record<string, string>>;
  browserDevBoundary: boolean;
  codexToolSettings: TaskManagerAppSettings['codexExternalTools'];
  designSkillRoot?: string;
}

export function createBuiltInAgentRuntimes(
  store: FileTaskStore,
  taskRuntime: TaskAgentRuntimeAccess,
  runtimeStore: AgentRuntimeStore,
  events: AppEventBus,
  options: BuiltInAgentRuntimeOptions
): AgentRuntimeAdapter[] {
  const codex = new CodexAppServerAdapter(store, taskRuntime, runtimeStore, events, {
    cwd: options.cwd,
    executable: options.codexExecutable,
    toolSettings: options.codexToolSettings,
    failClosedMcpDiscovery: options.browserDevBoundary,
    enforceBrowserDevBoundary: options.browserDevBoundary,
    designSkillRoot: options.designSkillRoot
  });
  const openCode = new OpenCodeAdapter(taskRuntime, runtimeStore, events, {
    cwd: options.cwd,
    executable: options.openCodeExecutable ?? process.env.TASK_MONKI_OPENCODE_BIN
  });
  const acp = ACP_RUNTIME_PROFILES.map(
    (profile) =>
      new AcpRuntimeAdapter(taskRuntime, runtimeStore, events, profile, {
        cwd: options.cwd,
        executable:
          options.acpExecutablePaths?.[profile.descriptor.id] ??
          process.env[profile.executableEnvironmentKey]
      })
  );
  return [codex, openCode, ...acp];
}

export function findCodexRuntimeAdapter(
  adapters: readonly AgentRuntimeAdapter[]
): CodexAppServerAdapter | undefined {
  return adapters.find(
    (adapter): adapter is CodexAppServerAdapter =>
      adapter instanceof CodexAppServerAdapter
  );
}

export function builtInRuntimeExecutableOverrides(
  openCodePath?: string,
  acpExecutablePaths?: Partial<Record<string, string>>
): Readonly<Record<string, string | undefined>> {
  return {
    opencode: openCodePath ?? process.env.TASK_MONKI_OPENCODE_BIN,
    ...Object.fromEntries(
      ACP_RUNTIME_PROFILES.map((profile) => [
        profile.descriptor.id,
        acpExecutablePaths?.[profile.descriptor.id] ??
          process.env[profile.executableEnvironmentKey]
      ])
    )
  };
}
