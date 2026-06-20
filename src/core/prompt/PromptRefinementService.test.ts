import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptRefinementService } from './PromptRefinementService';

describe('PromptRefinementService', () => {
  it('turns a short request into a structured repository-aware prompt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-prompt-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'task-manager-test', scripts: { test: 'vitest run' } }),
      'utf8'
    );
    await fs.writeFile(path.join(dir, 'README.md'), '# Test project\nA small repo.\n', 'utf8');

    const refined = await new PromptRefinementService().refine(dir, 'add github sync badges');

    expect(refined.titleSuggestion).toBe('add github sync badges');
    expect(refined.prompt).toContain('## Goal');
    expect(refined.prompt).toContain('task-manager-test');
    expect(refined.prompt).toContain('## Acceptance criteria');
  });
});
