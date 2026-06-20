import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRefinementCommand,
  PromptRefinementService
} from './PromptRefinementService';

describe('PromptRefinementService', () => {
  it('uses a repository-inspecting model response for the refined prompt', async () => {
    let capturedRepositoryPath = '';
    let capturedInstruction = '';
    const service = new PromptRefinementService(async ({ repositoryPath, instruction }) => {
      capturedRepositoryPath = repositoryPath;
      capturedInstruction = instruction;
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

    const refined = await service.refine('/tmp/example repo', 'add github sync badges');

    expect(refined.source).toBe('model');
    expect(refined.titleSuggestion).toBe('Add GitHub sync badges');
    expect(refined.prompt).toContain('src/renderer/ui/StatusBadge.tsx');
    expect(capturedRepositoryPath).toBe('/tmp/example repo');
    expect(capturedInstruction).toContain('inspect the repository with read-only commands');
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

  it('configures GPT-5.4 mini with low reasoning and read-only repository access', () => {
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
        'gpt-5.4-mini',
        '-c',
        'model_reasoning_effort="low"',
        '-'
      ]
    });
  });
});
