import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CodexAppsMode,
  CodexMcpServersMode,
  CodexWebSearchMode
} from '../../shared/agent';
import { resolveCodexExternalToolConfigOverrides } from '../agent/codex/CodexToolConfig';
import {
  buildRefinementCommand,
  PromptRefinementService
} from './PromptRefinementService';

const WEB_SEARCH_MODES: CodexWebSearchMode[] = ['disabled', 'cached', 'live'];
const MCP_SERVER_MODES: CodexMcpServersMode[] = ['disabled', 'all'];
const APP_MODES: CodexAppsMode[] = ['disabled', 'enabled'];
const SAMPLE_MCP_DISABLE_OVERRIDE =
  'mcp_servers.docs={enabled=false, command="docs-mcp", args=["--stdio"]}';

describe('PromptRefinementService', () => {
  it('uses a model response with precomputed repository context for the refined prompt', async () => {
    let capturedRepositoryPath = '';
    let capturedInstruction = '';
    let capturedModel = '';
    let capturedToolSettings: unknown;
    const service = new PromptRefinementService(
      async ({ repositoryPath, instruction, model, toolSettings }) => {
        capturedRepositoryPath = repositoryPath;
        capturedInstruction = instruction;
        capturedModel = model ?? '';
        capturedToolSettings = toolSettings;
        return JSON.stringify({
          titleSuggestion: 'Add GitHub sync badges',
          prompt: [
            '## Goal',
            'Add GitHub sync badges.',
            '## Repository context',
            'Update `src/renderer/ui/StatusBadge.tsx` using contracts from `src/shared/contracts.ts`.',
            '## Constraints',
            'Preserve the status model.',
            '## Acceptance criteria',
            'The badges render persisted GitHub state.',
            '## Verification',
            'Run `npm test` and `npm run typecheck`.'
          ].join('\n\n')
        });
      }
    );

    const refined = await service.refine(
      '/tmp/example repo',
      'add github sync badges',
      'gpt-5.3-codex-spark',
      { webSearchMode: 'cached', mcpServers: 'all', apps: 'enabled' }
    );

    expect(refined.source).toBe('model');
    expect(refined.titleSuggestion).toBe('Add GitHub sync badges');
    expect(refined.prompt).toContain('src/renderer/ui/StatusBadge.tsx');
    expect(capturedRepositoryPath).toBe('/tmp/example repo');
    expect(capturedModel).toBe('gpt-5.3-codex-spark');
    expect(capturedToolSettings).toEqual({
      webSearchMode: 'cached',
      mcpServers: 'all',
      apps: 'enabled'
    });
    expect(capturedInstruction).toContain('Do not run commands');
    expect(capturedInstruction).toContain('Repository context:');
    expect(capturedInstruction).toContain('## Acceptance criteria');
  });

  it('falls back to repository metadata when model refinement fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-prompt-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'task-manager-test', scripts: { test: 'vitest run' } }),
      'utf8'
    );
    await fs.writeFile(path.join(dir, 'README.md'), '# Test project\nA small repo.\n', 'utf8');

    const refined = await new PromptRefinementService(async () => {
      throw new Error('model unavailable');
    }).refine(dir, 'add github sync badges');

    expect(refined.source).toBe('deterministic-fallback');
    expect(refined.titleSuggestion).toBe('add github sync badges');
    expect(refined.prompt).toContain('## Goal');
    expect(refined.prompt).toContain('task-manager-test');
    expect(refined.prompt).toContain('## Acceptance criteria');
  });

  it('configures Spark with low reasoning and read-only repository access', () => {
    const command = buildRefinementCommand('/tmp/example repo');

    expect(command).toEqual({
      executable: 'codex',
      argv: [
        '--ask-for-approval',
        'never',
        'exec',
        '--json',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--cd',
        '/tmp/example repo',
        '--model',
        'gpt-5.3-codex-spark',
        '-c',
        'model_reasoning_effort="low"',
        '-c',
        'features.apps=false',
        '-c',
        'web_search="disabled"',
        '-'
      ]
    });
  });

  it('uses the selected refinement model when one is provided', () => {
    const command = buildRefinementCommand('/tmp/example repo', 'gpt-5.5');

    expect(command.argv).toContain('gpt-5.5');
    expect(command.argv).not.toContain('gpt-5.3-codex-spark');
  });

  it('passes every external tool config variation through to the refinement command', async () => {
    for (const webSearchMode of WEB_SEARCH_MODES) {
      for (const mcpServers of MCP_SERVER_MODES) {
        for (const apps of APP_MODES) {
          const configOverrides = await resolveCodexExternalToolConfigOverrides({
            executable: '/not/used/when/overrides/are/provided',
            cwd: process.cwd(),
            settings: {
              webSearchMode,
              mcpServers,
              apps
            },
            mcpServerConfigOverrides: [SAMPLE_MCP_DISABLE_OVERRIDE]
          });
          const command = buildRefinementCommand(
            '/tmp/example repo',
            'gpt-5.3-codex-spark',
            configOverrides
          );

          expect(configArgs(command.argv)).toEqual([
            'model_reasoning_effort="low"',
            `features.apps=${apps === 'enabled' ? 'true' : 'false'}`,
            `web_search="${webSearchMode}"`,
            ...(mcpServers === 'disabled' ? [SAMPLE_MCP_DISABLE_OVERRIDE] : [])
          ]);
        }
      }
    }
  });
});

function configArgs(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '-c') {
      const value = argv[index + 1];
      if (value) {
        values.push(value);
      }
    }
  }
  return values;
}
