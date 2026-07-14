import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  type CodexExternalToolSettings,
  type RefinePromptResponse
} from '../../shared/contracts';
import {
  codexExternalToolConfigOverrides
} from '../agent/codex/CodexToolConfig';
import {
  buildCodexEphemeralReadOnlyCommand,
  startCodexEphemeralReadOnlyRun
} from '../agent/codex/CodexEphemeralReadOnlyRunner';
import {
  buildPromptRefinementFallbackPrompt,
  buildPromptRefinementInstruction
} from '../../shared/promptTemplates';

const REFINEMENT_REASONING_EFFORT = 'low';
const REFINEMENT_TIMEOUT_MS = 90_000;

export interface PromptRefinementRunRequest {
  repositoryPath: string;
  instruction: string;
  model?: string;
  codexExecutable?: string;
  toolSettings?: CodexExternalToolSettings;
  failClosedMcpDiscovery?: boolean;
}

export type PromptRefinementRunner = (request: PromptRefinementRunRequest) => Promise<string>;

export class PromptRefinementService {
  constructor(private readonly runModel: PromptRefinementRunner = runCodexRefinement) {}

  async refine(
    repositoryPath: string,
    input: string,
    model?: string,
    codexExecutable?: string,
    toolSettings?: CodexExternalToolSettings,
    failClosedMcpDiscovery = false
  ): Promise<RefinePromptResponse> {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('Prompt text is required.');
    }

    try {
      const modelOutput = await this.runModel({
        repositoryPath,
        instruction: buildPromptRefinementInstruction(trimmed),
        model,
        codexExecutable,
        toolSettings,
        failClosedMcpDiscovery
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

export function buildRefinementCommand(
  repositoryPath: string,
  model = DEFAULT_PROMPT_REFINEMENT_MODEL,
  configOverrides: readonly string[] = codexExternalToolConfigOverrides(
    DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS
  ),
  executable = 'codex'
): {
  executable: string;
  argv: string[];
} {
  if (!repositoryPath.trim()) {
    throw new Error('Repository path is required.');
  }
  const selectedModel = model.trim() || DEFAULT_PROMPT_REFINEMENT_MODEL;

  return buildCodexEphemeralReadOnlyCommand({
    cwd: repositoryPath,
    model: selectedModel,
    reasoningEffort: REFINEMENT_REASONING_EFFORT,
    configOverrides,
    executable
  });
}

async function runCodexRefinement({
  repositoryPath,
  instruction,
  model,
  codexExecutable,
  toolSettings,
  failClosedMcpDiscovery
}: PromptRefinementRunRequest): Promise<string> {
  const run = await startCodexEphemeralReadOnlyRun({
    cwd: repositoryPath,
    instruction,
    model: model?.trim() || DEFAULT_PROMPT_REFINEMENT_MODEL,
    reasoningEffort: REFINEMENT_REASONING_EFFORT,
    timeoutMs: REFINEMENT_TIMEOUT_MS,
    codexExecutable,
    toolSettings,
    failClosedMcpDiscovery
  });
  return run.result;
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
  const prompt = buildPromptRefinementFallbackPrompt({
    titleSuggestion,
    userRequest: input,
    repositoryContext: context
  });

  return {
    prompt,
    titleSuggestion,
    source: 'deterministic-fallback'
  };
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
      const scripts = Object.entries(data.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .slice(0, 8)
        .map(([name, command]) => `${name}: ${command.replace(/\s+/g, ' ').trim()}`);
      if (scripts.length > 0) {
        lines.push(`- Available npm scripts: ${scripts.join('; ')}`);
      }
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
