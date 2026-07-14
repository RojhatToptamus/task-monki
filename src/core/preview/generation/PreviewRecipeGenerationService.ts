import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  type PreviewExecutionPlan,
  type PreviewRecipeGenerationDraft,
  type PreviewRecipeGenerationReport,
  type PreviewRecipeGenerationSnapshot,
  type PreviewRecipeValidation
} from '../../../shared/contracts';
import {
  CodexEphemeralRunError,
  startCodexEphemeralReadOnlyRun,
  type CodexEphemeralReadOnlyRun
} from '../../agent/codex/CodexEphemeralReadOnlyRunner';
import {
  MAX_PREVIEW_RECIPE_BYTES,
  PREVIEW_RECIPE_PATH,
  parsePreviewRecipe
} from '../PreviewRecipeLoader';
import {
  buildPreviewRecipeGenerationInstruction,
  PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION
} from './PreviewRecipeGenerationSupport';
import { preparePreviewRecipeEvidenceBundle } from './PreviewRecipeEvidenceBundle';

const GENERATION_TIMEOUT_MS = 120_000;
const MAX_REPORT_ITEMS = 40;
const MAX_REPORT_TEXT_BYTES = 1_200;
const SECRET_ENV_KEY = /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;

export interface PreviewRecipeGenerationRunRequest {
  cwd: string;
  instruction: string;
  model: string;
  codexExecutable?: string;
}

export type PreviewRecipeGenerationRunner = (
  request: PreviewRecipeGenerationRunRequest
) => Promise<CodexEphemeralReadOnlyRun>;

interface ActiveGeneration {
  id: string;
  canceled: boolean;
  run?: CodexEphemeralReadOnlyRun;
  settled?: Promise<PreviewRecipeGenerationSnapshot>;
}

interface ParsedAgentGeneration {
  status: 'draft' | 'insufficient-evidence';
  yaml?: string;
  report: PreviewRecipeGenerationReport;
}

class InvalidAgentGenerationError extends Error {}

export class PreviewRecipeGenerationService {
  private readonly states = new Map<string, PreviewRecipeGenerationSnapshot>();
  private readonly operations = new Map<string, ActiveGeneration>();
  private shuttingDown = false;

  constructor(
    private readonly runAgent: PreviewRecipeGenerationRunner = runPreviewRecipeAgent
  ) {}

  get(taskId: string): PreviewRecipeGenerationSnapshot {
    return structuredClone(
      this.states.get(taskId) ?? { taskId, status: 'EMPTY' }
    );
  }

  generate(input: {
    taskId: string;
    worktreePath: string;
    model?: string;
    codexExecutable?: string;
    onUpdate?: (state: PreviewRecipeGenerationSnapshot) => void;
  }): Promise<PreviewRecipeGenerationSnapshot> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Preview recipe generation is shutting down.'));
    }
    const active = this.operations.get(input.taskId);
    if (active?.settled) return active.settled;
    if (
      input.model !== undefined &&
      (!input.model.trim() || Buffer.byteLength(input.model, 'utf8') > 160 || /[\0\r\n]/.test(input.model))
    ) {
      return Promise.reject(new Error('The selected Preview generation model is invalid.'));
    }

    const operation: ActiveGeneration = {
      id: randomUUID(),
      canceled: false
    };
    this.operations.set(input.taskId, operation);
    const startedAt = new Date().toISOString();
    this.publish(
      {
        taskId: input.taskId,
        status: 'GENERATING',
        stage: 'PREPARING_EVIDENCE',
        draft: this.states.get(input.taskId)?.draft,
        startedAt
      },
      input.onUpdate
    );
    const settled = this.completeGeneration(operation, { ...input, startedAt });
    operation.settled = settled;
    return settled;
  }

  validate(taskId: string, draftId: string, yaml: string): PreviewRecipeValidation {
    const draft = this.states.get(taskId)?.draft;
    if (!draft || draft.id !== draftId) {
      throw new Error('The Preview recipe draft is no longer current.');
    }
    return validatePreviewRecipeDraft(yaml);
  }

  async writeAcceptedRecipe(input: {
    taskId: string;
    draftId: string;
    yaml: string;
    worktreePath: string;
  }): Promise<void> {
    if (this.operations.has(input.taskId)) {
      throw new Error('Wait for Preview recipe generation to finish before accepting a draft.');
    }
    const state = this.states.get(input.taskId);
    if (!state?.draft || state.draft.id !== input.draftId) {
      throw new Error('The Preview recipe draft is no longer current.');
    }
    const validation = validatePreviewRecipeDraft(input.yaml);
    if (validation.status !== 'VALID') {
      throw new Error(validation.issues[0]?.message ?? 'The Preview recipe is invalid.');
    }
    await writeNewPreviewRecipe(input.worktreePath, input.yaml);
  }

  completeAcceptance(taskId: string): PreviewRecipeGenerationSnapshot {
    this.states.delete(taskId);
    return { taskId, status: 'EMPTY' };
  }

  async discard(
    taskId: string,
    onUpdate?: (state: PreviewRecipeGenerationSnapshot) => void
  ): Promise<PreviewRecipeGenerationSnapshot> {
    const operation = this.operations.get(taskId);
    if (operation) {
      operation.canceled = true;
      await operation.run?.cancel().catch(() => undefined);
    }
    const empty = { taskId, status: 'EMPTY' as const };
    this.states.delete(taskId);
    onUpdate?.(structuredClone(empty));
    await operation?.settled?.catch(() => undefined);
    return empty;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const operations = [...this.operations.values()];
    for (const operation of operations) {
      operation.canceled = true;
    }
    await Promise.allSettled(
      operations.map(async (operation) => {
        await operation.run?.cancel();
        await operation.settled;
      })
    );
    this.operations.clear();
    this.states.clear();
  }

  private async completeGeneration(
    operation: ActiveGeneration,
    input: {
      taskId: string;
      worktreePath: string;
      model?: string;
      codexExecutable?: string;
      onUpdate?: (state: PreviewRecipeGenerationSnapshot) => void;
      startedAt: string;
    }
  ): Promise<PreviewRecipeGenerationSnapshot> {
    const previousDraft = this.states.get(input.taskId)?.draft;
    let evidence: Awaited<ReturnType<typeof preparePreviewRecipeEvidenceBundle>> | undefined;
    try {
      await assertPreviewRecipeMissing(input.worktreePath);
      evidence = await preparePreviewRecipeEvidenceBundle(input.worktreePath);
      this.assertCurrent(input.taskId, operation);
      this.publish(
        {
          taskId: input.taskId,
          status: 'GENERATING',
          stage: 'GENERATING_DRAFT',
          draft: previousDraft,
          startedAt: input.startedAt
        },
        input.onUpdate
      );
      const run = await this.runAgent({
        cwd: evidence.directoryPath,
        instruction: buildPreviewRecipeGenerationInstruction({
          evidenceFileName: evidence.fileName
        }),
        model: input.model?.trim() || DEFAULT_PROMPT_REFINEMENT_MODEL,
        codexExecutable: input.codexExecutable
      });
      operation.run = run;
      if (operation.canceled) await run.cancel();
      const output = await run.result;
      this.assertCurrent(input.taskId, operation);
      this.publish(
        {
          taskId: input.taskId,
          status: 'GENERATING',
          stage: 'VALIDATING_DRAFT',
          draft: previousDraft,
          startedAt: input.startedAt
        },
        input.onUpdate
      );
      let parsed: ParsedAgentGeneration;
      try {
        parsed = parseAgentGeneration(output, evidence.includedPaths);
      } catch {
        throw new InvalidAgentGenerationError();
      }
      parsed.report.omissions = uniqueBoundedStrings([
        ...evidence.safeOmissions,
        ...parsed.report.omissions
      ]);
      if (parsed.status === 'insufficient-evidence') {
        return this.finish(
          input.taskId,
          operation,
          {
            taskId: input.taskId,
            status: 'NEEDS_INPUT',
            report: parsed.report,
            draft: previousDraft,
            failureCode: 'INSUFFICIENT_EVIDENCE',
            message: 'The agent did not find enough evidence for a safe Preview recipe.'
          },
          input.onUpdate
        );
      }
      const validation = validatePreviewRecipeDraft(parsed.yaml ?? '');
      if (validation.status !== 'VALID') {
        return this.finish(
          input.taskId,
          operation,
          {
            taskId: input.taskId,
            status: 'FAILED',
            report: parsed.report,
            draft: previousDraft,
            failureCode: 'INVALID_AGENT_OUTPUT',
            message: validation.issues[0]?.message ?? 'The generated recipe was invalid.'
          },
          input.onUpdate
        );
      }
      const draft: PreviewRecipeGenerationDraft = {
        id: randomUUID(),
        taskId: input.taskId,
        yaml: parsed.yaml!,
        report: parsed.report,
        validation,
        generatedAt: new Date().toISOString()
      };
      return this.finish(
        input.taskId,
        operation,
        { taskId: input.taskId, status: 'READY', draft },
        input.onUpdate
      );
    } catch (error) {
      if (operation.canceled) {
        const current = this.operations.get(input.taskId);
        if (current !== operation) return this.get(input.taskId);
        return this.finish(
          input.taskId,
          operation,
          { taskId: input.taskId, status: 'EMPTY' },
          input.onUpdate
        );
      }
      const classified = classifyGenerationFailure(error);
      return this.finish(
        input.taskId,
        operation,
        {
          taskId: input.taskId,
          status: 'FAILED',
          draft: previousDraft,
          failureCode: classified.code,
          message: classified.message
        },
        input.onUpdate
      );
    } finally {
      await evidence?.dispose().catch(() => undefined);
      if (this.operations.get(input.taskId) === operation) {
        this.operations.delete(input.taskId);
      }
    }
  }

  private assertCurrent(taskId: string, operation: ActiveGeneration): void {
    if (operation.canceled || this.operations.get(taskId) !== operation) {
      throw new CodexEphemeralRunError('CANCELED', 'The agent generation was canceled.');
    }
  }

  private finish(
    taskId: string,
    operation: ActiveGeneration,
    state: PreviewRecipeGenerationSnapshot,
    onUpdate?: (state: PreviewRecipeGenerationSnapshot) => void
  ): PreviewRecipeGenerationSnapshot {
    if (this.operations.get(taskId) !== operation) return this.get(taskId);
    return this.publish(state, onUpdate);
  }

  private publish(
    state: PreviewRecipeGenerationSnapshot,
    onUpdate?: (state: PreviewRecipeGenerationSnapshot) => void
  ): PreviewRecipeGenerationSnapshot {
    const snapshot = structuredClone(state);
    if (snapshot.status === 'EMPTY') this.states.delete(snapshot.taskId);
    else this.states.set(snapshot.taskId, snapshot);
    onUpdate?.(structuredClone(snapshot));
    return snapshot;
  }
}

async function runPreviewRecipeAgent(
  request: PreviewRecipeGenerationRunRequest
): Promise<CodexEphemeralReadOnlyRun> {
  return startCodexEphemeralReadOnlyRun({
    cwd: request.cwd,
    instruction: request.instruction,
    model: request.model,
    reasoningEffort: 'medium',
    timeoutMs: GENERATION_TIMEOUT_MS,
    codexExecutable: request.codexExecutable,
    toolSettings: DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
    failClosedMcpDiscovery: true
  });
}

export function validatePreviewRecipeDraft(yaml: string): PreviewRecipeValidation {
  if (!yaml.trim()) {
    return {
      status: 'INVALID',
      issues: [{ code: 'EMPTY_RECIPE', message: 'The Preview recipe is empty.' }]
    };
  }
  if (Buffer.byteLength(yaml, 'utf8') > MAX_PREVIEW_RECIPE_BYTES) {
    return {
      status: 'INVALID',
      issues: [{ code: 'RECIPE_TOO_LARGE', message: 'The Preview recipe exceeds 64 KiB.' }]
    };
  }
  let plan: PreviewExecutionPlan;
  try {
    plan = parsePreviewRecipe(yaml).executionPlan;
  } catch {
    return {
      status: 'INVALID',
      issues: [
        {
          code: 'INVALID_RECIPE',
          message: 'The YAML does not match the supported Preview recipe contract.'
        }
      ]
    };
  }
  if (looksLikeSecret(yaml) || containsSecretLiteral(plan)) {
    return {
      status: 'INVALID',
      issues: [
        {
          code: 'SECRET_LITERAL',
          message: 'Secret-like environment keys must use a private input reference, never a literal value.'
        }
      ]
    };
  }
  return { status: 'VALID' };
}

function containsSecretLiteral(plan: PreviewExecutionPlan): boolean {
  for (const node of [...plan.jobs, ...plan.services, ...plan.workers]) {
    const environments = [node.env];
    if ('ready' in node) {
      if (node.ready.type === 'argv') environments.push(node.ready.env ?? {});
      if (node.liveness?.probe.type === 'argv') {
        environments.push(node.liveness.probe.env ?? {});
      }
    }
    for (const environment of environments) {
      if (
        Object.entries(environment).some(
          ([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === 'string'
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseAgentGeneration(
  output: string,
  includedPaths: ReadonlySet<string>
): ParsedAgentGeneration {
  const normalized = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const value = JSON.parse(normalized) as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'status',
    'yaml',
    'summary',
    'evidence',
    'assumptions',
    'omissions',
    'unresolvedDecisions'
  ]);
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.schemaVersion !== PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION ||
    (value.status !== 'draft' && value.status !== 'insufficient-evidence')
  ) {
    throw new Error('Invalid agent generation shape.');
  }
  const status = value.status;
  if (
    (status === 'draft' && typeof value.yaml !== 'string') ||
    (status === 'insufficient-evidence' && value.yaml !== null)
  ) {
    throw new Error('Invalid agent generation YAML.');
  }
  const evidence = normalizeEvidence(value.evidence, includedPaths);
  const report: PreviewRecipeGenerationReport = {
    summary: normalizeSafeReportText(value.summary, 'summary'),
    evidence,
    assumptions: normalizeReportList(value.assumptions, 'assumptions'),
    omissions: normalizeReportList(value.omissions, 'omissions'),
    unresolvedDecisions: normalizeReportList(
      value.unresolvedDecisions,
      'unresolvedDecisions'
    )
  };
  if (status === 'draft' && evidence.length === 0) {
    throw new Error('A generated draft requires repository evidence.');
  }
  if (status === 'insufficient-evidence' && report.unresolvedDecisions.length === 0) {
    throw new Error('Insufficient evidence requires an unresolved decision.');
  }
  return {
    status,
    yaml: status === 'draft' ? (value.yaml as string) : undefined,
    report
  };
}

function normalizeEvidence(
  value: unknown,
  includedPaths: ReadonlySet<string>
): PreviewRecipeGenerationReport['evidence'] {
  if (!Array.isArray(value) || value.length > MAX_REPORT_ITEMS) {
    throw new Error('Invalid generation evidence.');
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Invalid generation evidence.');
    }
    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'path' && key !== 'finding')) {
      throw new Error('Invalid generation evidence.');
    }
    const evidencePath = normalizeSafeReportText(record.path, 'evidence path');
    if (
      path.posix.isAbsolute(evidencePath) ||
      evidencePath.includes('\\') ||
      evidencePath.split('/').includes('..') ||
      !includedPaths.has(evidencePath)
    ) {
      throw new Error('Generation evidence references an unavailable path.');
    }
    return {
      path: evidencePath,
      finding: normalizeSafeReportText(record.finding, 'evidence finding')
    };
  });
}

function normalizeReportList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REPORT_ITEMS) {
    throw new Error(`Invalid generation ${context}.`);
  }
  return uniqueBoundedStrings(
    value.map((candidate) => normalizeSafeReportText(candidate, context))
  );
}

function normalizeSafeReportText(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid generation ${context}.`);
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, 'utf8') > MAX_REPORT_TEXT_BYTES ||
    /[\0\r\n]/.test(normalized) ||
    looksLikeSecret(normalized)
  ) {
    throw new Error(`Invalid generation ${context}.`);
  }
  return normalized;
}

function uniqueBoundedStrings(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_REPORT_ITEMS);
}

function looksLikeSecret(value: string): boolean {
  return (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
    /\bgh[opusr]_[A-Za-z0-9]{30,}\b/.test(value) ||
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(value) ||
    /\b(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|credentials?)\s*[:=]\s*["'][^"'`\r\n]{8,}["']/i.test(value) ||
    /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s/]+@/i.test(value)
  );
}

function classifyGenerationFailure(error: unknown): {
  code: 'AGENT_UNAVAILABLE' | 'GENERATION_TIMED_OUT' | 'INVALID_AGENT_OUTPUT';
  message: string;
} {
  if (error instanceof CodexEphemeralRunError && error.code === 'TIMED_OUT') {
    return {
      code: 'GENERATION_TIMED_OUT',
      message: 'The agent did not finish the Preview recipe within two minutes.'
    };
  }
  if (error instanceof InvalidAgentGenerationError) {
    return {
      code: 'INVALID_AGENT_OUTPUT',
      message: 'The agent response did not match the Preview generation contract.'
    };
  }
  return {
    code: 'AGENT_UNAVAILABLE',
    message: 'The Preview recipe agent could not produce a draft.'
  };
}

async function writeNewPreviewRecipe(worktreePath: string, yaml: string): Promise<void> {
  const root = await fs.realpath(path.resolve(worktreePath));
  const recipeDirectory = path.join(root, '.taskmonki');
  try {
    const directoryStat = await fs.lstat(recipeDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('.taskmonki must be a regular directory inside the task worktree.');
    }
    const realDirectory = await fs.realpath(recipeDirectory);
    if (path.dirname(realDirectory) !== root) {
      throw new Error('.taskmonki must remain inside the task worktree.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(recipeDirectory, { mode: 0o700 });
  }

  const recipePath = path.join(root, PREVIEW_RECIPE_PATH);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  try {
    handle = await fs.open(
      recipePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    await handle.writeFile(yaml, 'utf8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'A Preview recipe appeared while this draft was under review. Check that file before replacing anything.'
      );
    }
    if (created) await fs.unlink(recipePath).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPreviewRecipeMissing(worktreePath: string): Promise<void> {
  try {
    await fs.lstat(path.join(worktreePath, PREVIEW_RECIPE_PATH));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A Preview recipe already exists. Check it instead of generating a replacement.');
}
