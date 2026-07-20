import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRefinementCommand,
  PromptRefinementService,
  PromptRefinementTerminationUnconfirmedError
} from './PromptRefinementService';

describe('PromptRefinementService', () => {
  it('uses a repository-inspecting model response for the refined prompt', async () => {
    let capturedRepositoryPath = '';
    let capturedInstruction = '';
    let capturedModel = '';
    const service = new PromptRefinementService(async ({ repositoryPath, instruction, model }) => {
      capturedRepositoryPath = repositoryPath;
      capturedInstruction = instruction;
      capturedModel = model ?? '';
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
    });

    const refined = await service.refine(
      '/tmp/example repo',
      'add github sync badges',
      'gpt-5.3-codex-spark'
    );

    expect(refined.source).toBe('model');
    expect(refined.titleSuggestion).toBe('Add GitHub sync badges');
    expect(refined.prompt).toContain('src/renderer/ui/StatusBadge.tsx');
    expect(capturedRepositoryPath).toBe('/tmp/example repo');
    expect(capturedModel).toBe('gpt-5.3-codex-spark');
    expect(capturedInstruction).toContain('inspect the repository with read-only commands');
    expect(capturedInstruction).toContain('## Acceptance criteria');
    expect(capturedInstruction).toContain('Verification must name concrete commands');
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
    expect(refined.prompt).toContain('test: vitest run');
    expect(refined.prompt).toContain('## Acceptance criteria');
    expect(refined.prompt).toContain('Run relevant repository scripts named above');
  });

  it('does not launch another refinement after process termination becomes unconfirmed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-prompt-'));
    let launches = 0;
    const service = new PromptRefinementService(async () => {
      launches += 1;
      throw new PromptRefinementTerminationUnconfirmedError(
        new Error('simulated process-tree failure')
      );
    });

    expect((await service.refine(dir, 'first refinement')).source).toBe(
      'deterministic-fallback'
    );
    expect((await service.refine(dir, 'second refinement')).source).toBe(
      'deterministic-fallback'
    );
    expect(launches).toBe(1);
  });

  it('configures the default refinement model with low reasoning and read-only repository access', () => {
    const command = buildRefinementCommand('/tmp/example repo');

    expect(command).toEqual({
      executable: 'codex',
      argv: [
        '--ask-for-approval',
        'never',
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
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
    const command = buildRefinementCommand('/tmp/example repo', 'gpt-5.3-codex-spark');

    expect(command.argv).toContain('gpt-5.3-codex-spark');
  });

  it('propagates fail-closed MCP discovery to browser-dev refinement runners', async () => {
    let observed = false;
    const service = new PromptRefinementService(async ({ failClosedMcpDiscovery }) => {
      observed = failClosedMcpDiscovery === true;
      return JSON.stringify({ titleSuggestion: 'Safe refinement', prompt: 'Safe prompt' });
    });

    await service.refine(
      '/tmp/example repo',
      'refine safely',
      undefined,
      undefined,
      {
        webSearchMode: 'disabled',
        mcpServers: 'disabled',
        apps: 'disabled'
      },
      true
    );

    expect(observed).toBe(true);
  });
});
