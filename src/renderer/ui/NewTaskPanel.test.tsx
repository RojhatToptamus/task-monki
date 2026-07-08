import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentModel } from '../../shared/contracts';
import { NewTaskPanel } from './NewTaskPanel';

describe('NewTaskPanel', () => {
  it('shows task-level permission mode and network controls without raw Codex sandbox fields', () => {
    const models: AgentModel[] = [
      {
        id: 'model-1',
        model: 'fake-model',
        displayName: 'Fake model',
        provider: 'openai',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
        inputModalities: ['text']
      }
    ];

    const html = renderToStaticMarkup(
      <NewTaskPanel
        defaultRepositoryPath="/tmp/project"
        models={models}
        onCreate={async () => undefined}
        onRefinePrompt={async () => ({
          titleSuggestion: 'Task',
          prompt: 'Do the task.',
          source: 'deterministic-fallback'
        })}
        onClose={() => undefined}
      />
    );

    expect(html).toContain('Permission mode');
    expect(html).toContain('Ask for approval');
    expect(html).toContain('Approve for me');
    expect(html).toContain('Full access');
    expect(html).toContain('Network access');
    expect(html).not.toContain('Sandbox');
    expect(html).not.toContain('Approval policy');
  });
});
