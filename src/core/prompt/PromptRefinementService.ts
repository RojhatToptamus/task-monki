import fs from 'node:fs/promises';
import path from 'node:path';
import type { RefinePromptResponse } from '../../shared/contracts';

export class PromptRefinementService {
  async refine(repositoryPath: string, input: string): Promise<RefinePromptResponse> {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('Prompt text is required.');
    }

    const context = await readRepositoryContext(repositoryPath);
    const titleSuggestion = titleFromInput(trimmed);
    const prompt = [
      `# Task: ${titleSuggestion}`,
      '',
      '## Goal',
      trimmed,
      '',
      '## Repository context',
      context,
      '',
      '## Constraints',
      '- Work only inside the task worktree created by this app.',
      '- Keep the change scoped to the requested task.',
      '- Do not push, merge, close PRs, delete branches, or change repository settings.',
      '- Preserve existing architecture and status-model boundaries.',
      '',
      '## Acceptance criteria',
      '- Implement the requested behavior with the smallest coherent change.',
      '- Preserve existing tests unless a test update is required by the requested behavior.',
      '- Add focused tests only where they prove core behavior or prevent a likely regression.',
      '- Update relevant phase/status docs when the change affects the delivery plan.',
      '',
      '## Verification',
      '- Run the configured task test command when practical.',
      '- Report what changed, what was verified, and any remaining limitations.',
      ''
    ].join('\n');

    return {
      prompt,
      titleSuggestion,
      source: 'deterministic'
    };
  }
}

async function readRepositoryContext(repositoryPath: string): Promise<string> {
  const [packageJson, readme] = await Promise.all([
    readJsonFile(path.join(repositoryPath, 'package.json')),
    readFirstExistingText([
      path.join(repositoryPath, 'README.md'),
      path.join(repositoryPath, 'readme.md')
    ])
  ]);

  const lines: string[] = [];
  if (packageJson && typeof packageJson === 'object') {
    const data = packageJson as Record<string, unknown>;
    if (typeof data.name === 'string') {
      lines.push(`- Project/package name: ${data.name}`);
    }
    if (typeof data.description === 'string') {
      lines.push(`- Description: ${data.description}`);
    }
    if (data.scripts && typeof data.scripts === 'object') {
      lines.push(`- Available npm scripts: ${Object.keys(data.scripts).slice(0, 8).join(', ')}`);
    }
  }

  if (readme) {
    lines.push(`- README summary: ${readme.replace(/\s+/g, ' ').slice(0, 280)}`);
  }

  return lines.length > 0 ? lines.join('\n') : '- No package metadata or README summary found.';
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readFirstExistingText(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      // continue
    }
  }
  return undefined;
}

function titleFromInput(input: string): string {
  const firstLine = input.split(/\r?\n/).find(Boolean) ?? input;
  const normalized = firstLine.replace(/[.?!]+$/g, '').trim();
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trim()}...`;
}
