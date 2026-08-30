import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS } from '../../shared/contracts';
import { DesignClientToolBridge } from '../design/DesignClientToolBridge';
import { AppEventBus } from '../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { createBuiltInAgentRuntimes } from './AgentRuntimeComposition';

describe('built-in agent runtime composition', () => {
  it('shares one Design tool bridge and skill root with non-Codex adapters', () => {
    const root = path.resolve('/tmp/task-monki-runtime-composition');
    const store = new FileTaskStore(path.join(root, 'tasks'));
    const runtimeStore = new FileAgentRuntimeStore(path.join(root, 'runtime'));
    const taskRuntime = runtimeStore.taskAgentRuntimeAccess();
    const designToolBridge = Object.create(
      DesignClientToolBridge.prototype
    ) as DesignClientToolBridge;
    const adapters = createBuiltInAgentRuntimes(
      store,
      taskRuntime,
      runtimeStore,
      new AppEventBus(),
      {
        cwd: root,
        browserDevBoundary: false,
        codexToolSettings: DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
        designSkillRoot: '/app/design-skills',
        designToolBridge
      }
    );

    for (const adapter of adapters.filter(
      (candidate) => candidate.descriptor.id !== 'codex'
    )) {
      const options = (
        adapter as unknown as {
          options: {
            designSkillRoot?: string;
            designClientToolBridge?: DesignClientToolBridge;
          };
        }
      ).options;
      expect(options.designSkillRoot).toBe('/app/design-skills');
      expect(options.designClientToolBridge).toBe(designToolBridge);
    }
  });
});
