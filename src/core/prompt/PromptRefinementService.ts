import fs from 'node:fs/promises';
import path from 'node:path';
import type { RefinePromptResponse } from '../../shared/contracts';
import { ProcessSupervisor } from '../process/ProcessSupervisor';

const REFINEMENT_MODEL = 'gpt-5.4-mini';
const REFINEMENT_REASONING_EFFORT = 'low';
const REFINEMENT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface PromptRefinementRunRequest {
  repositoryPath: string;
  instruction: string;
}

export type PromptRefinementRunner = (request: PromptRefinementRunRequest) => Promise<string>;

export class PromptRefinementService {
  constructor(private readonly runModel: PromptRefinementRunner = runCodexRefinement) {}

  async refine(repositoryPath: string, input: string): Promise<RefinePromptResponse> {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('Prompt text is required.');
    }

    try {
      const modelOutput = await this.runModel({
        repositoryPath,
        instruction: buildRefinementInstruction(trimmed)
      });
      const refined = parseModelRefinement(modelOutput);
      return {
        ...refined,
        source: 'model'
      };
    } catch {
      return buildDeterministicFallback(repositoryPath, trimmed);
    }
  }
}

export function buildRefinementCommand(repositoryPath: string): {
  executable: string;
  argv: string[];
} {
  if (!repositoryPath.trim()) {
    throw new Error('Repository path is required.');
  }

  return {
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
      repositoryPath,
      '--model',
      REFINEMENT_MODEL,
      '-c',
      `model_reasoning_effort="${REFINEMENT_REASONING_EFFORT}"`,
      '-'
    ]
  };
}

async function runCodexRefinement({
  repositoryPath,
  instruction
}: PromptRefinementRunRequest): Promise<string> {
  const command = buildRefinementCommand(repositoryPath);
  const process = new ProcessSupervisor().start({
    executable: command.executable,
    argv: command.argv,
    cwd: repositoryPath,
    stdin: instruction
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void process.cancel();
      reject(new Error('Prompt refinement timed out.'));
    }, REFINEMENT_TIMEOUT_MS);

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    process.events.on('stdout', (chunk) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
    });
    process.events.on('stderr', (chunk) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
    });
    process.events.once('error', (error) => finish(() => reject(error)));
    process.events.once('close', ({ exitCode, signal }) => {
      finish(() => {
        if (exitCode !== 0) {
          const detail = stderr.trim().slice(-500);
          reject(
            new Error(
              `Prompt refinement process failed (${signal ?? `exit ${exitCode}`})${
                detail ? `: ${detail}` : '.'
              }`
            )
          );
          return;
        }

        const message = extractFinalAgentMessage(stdout);
        if (!message) {
          reject(new Error('Prompt refinement returned no final message.'));
          return;
        }
        resolve(message);
      });
    });
  });
}

function buildRefinementInstruction(input: string): string {
  return [
    'You are refining a software task prompt for the repository in your current working directory.',
    '',
    'Before writing the prompt, inspect the repository with read-only commands. Review the file tree, package/build configuration, relevant implementation files, tests, and documentation. Do not modify any file.',
    '',
    'Return JSON only, with exactly these string fields:',
    '{"titleSuggestion":"...","prompt":"..."}',
    '',
    'The prompt value must be implementation-ready and contain these Markdown headings:',
    '## Goal',
    '## Repository context',
    '## Constraints',
    '## Acceptance criteria',
    '## Verification',
    '',
    'Repository context must name concrete files, modules, symbols, scripts, or architectural boundaries you actually inspected. Do not invent repository facts. Keep the requested scope intact and make acceptance criteria objectively testable.',
    '',
    'User request:',
    input
  ].join('\n');
}

function extractFinalAgentMessage(stdout: string): string | undefined {
  let finalMessage: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: { type?: unknown; text?: unknown };
      };
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        finalMessage = event.item.text;
      }
    } catch {
      // Codex JSONL should be valid, but unrelated non-JSON output is ignored.
    }
  }

  return finalMessage;
}

function parseModelRefinement(output: string): Pick<
  RefinePromptResponse,
  'prompt' | 'titleSuggestion'
> {
  const normalized = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(normalized) as {
    prompt?: unknown;
    titleSuggestion?: unknown;
  };

  if (typeof parsed.prompt !== 'string' || typeof parsed.titleSuggestion !== 'string') {
    throw new Error('Prompt refinement response has an invalid shape.');
  }

  const prompt = parsed.prompt.trim();
  const titleSuggestion = parsed.titleSuggestion.trim();
  const requiredHeadings = [
    '## Goal',
    '## Repository context',
    '## Constraints',
    '## Acceptance criteria',
    '## Verification'
  ];

  if (!titleSuggestion || requiredHeadings.some((heading) => !prompt.includes(heading))) {
    throw new Error('Prompt refinement response is incomplete.');
  }

  return {
    prompt,
    titleSuggestion: titleSuggestion.slice(0, 72)
  };
}

async function buildDeterministicFallback(
  repositoryPath: string,
  input: string
): Promise<RefinePromptResponse> {
  const context = await readRepositoryContext(repositoryPath);
  const titleSuggestion = titleFromInput(input);
  const prompt = [
    `# Task: ${titleSuggestion}`,
    '',
    '## Goal',
    input,
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
    source: 'deterministic-fallback'
  };
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_OUTPUT_BYTES);
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
