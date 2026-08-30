import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutionSettings, AgentModel } from '../../shared/agent';
import type { AttachmentSubmissionRecord } from '../../shared/attachments';
import {
  type PromptRefinementEvidence,
  type RefinePromptResponse
} from '../../shared/contracts';
import { buildPromptRefinementInstruction } from '../../shared/promptTemplates';
import type { AgentTurnAttachment } from '../agent/AgentAttachmentDelivery';
const MAX_REFINED_PROMPT_CHARS = 60_000;
const MAX_EVIDENCE_ITEMS = 64;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface PromptRefinementInput {
  requestId: string;
  repositoryPath: string;
  input: string;
  title?: string;
  refinementModel: AgentModel;
  settings: AgentExecutionSettings;
  targetModel?: AgentModel;
  attachments?: readonly AgentTurnAttachment[];
}

export interface PromptRefinementRunRequest {
  requestId: string;
  repositoryPath: string;
  instruction: string;
  refinementModel: AgentModel;
  settings: AgentExecutionSettings;
  attachments: readonly AgentTurnAttachment[];
}

export interface PromptRefinementRun {
  result: Promise<{
    output: string;
    attachmentSubmissions: AttachmentSubmissionRecord[];
  }>;
  cancel(): Promise<void>;
}

export type PromptRefinementRunner = (
  request: PromptRefinementRunRequest
) => Promise<PromptRefinementRun>;

interface ActiveRefinement {
  canceled: boolean;
  starting?: Promise<PromptRefinementRun>;
  run?: PromptRefinementRun;
  cancellation?: Promise<void>;
}

export class PromptRefinementCanceledError extends Error {
  constructor() {
    super('Prompt refinement was canceled.');
    this.name = 'PromptRefinementCanceledError';
  }
}

export class PromptRefinementTerminationUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('Prompt refinement process termination could not be confirmed.', { cause });
    this.name = 'PromptRefinementTerminationUnconfirmedError';
  }
}

class PromptRefinementResponseValidationError extends Error {
  constructor(cause: unknown) {
    super('The refinement model returned a response that could not be validated.', { cause });
    this.name = 'PromptRefinementResponseValidationError';
  }
}

export class PromptRefinementService {
  private terminationFence?: PromptRefinementTerminationUnconfirmedError;
  private readonly active = new Map<string, ActiveRefinement>();
  private accepting = true;
  private shutdownWork?: Promise<void>;

  constructor(private readonly runModel: PromptRefinementRunner) {}

  async refine(input: PromptRefinementInput): Promise<RefinePromptResponse> {
    if (!this.accepting) throw new Error('Prompt refinement is shutting down.');
    const requestId = requireRequestId(input.requestId);
    const userRequest = input.input.trim();
    if (!userRequest) throw new Error('Prompt text is required.');
    if (this.active.has(requestId)) {
      throw new Error('This prompt-refinement request is already running.');
    }
    if (this.terminationFence) {
      return unchangedFallback(input, userRequest, true);
    }

    const active: ActiveRefinement = { canceled: false };
    this.active.set(requestId, active);
    try {
      const attachments = input.attachments ?? [];
      const attachmentContext = attachments.map((attachment, index) => {
        return {
          id: attachment.attachmentId,
          referenceLabel: `Attachment ${index + 1} (${attachment.displayName})`,
          displayName: attachment.displayName,
          kind: attachment.kind,
          mediaType: attachment.mediaType,
          byteCount: attachment.byteCount
        };
      });
      const starting = this.runModel({
        requestId,
        repositoryPath: input.repositoryPath,
        instruction: buildPromptRefinementInstruction({
          userRequest,
          title: input.title,
          refinementModel: input.refinementModel,
          targetModel: input.targetModel,
          attachments: attachmentContext
        }),
        refinementModel: input.refinementModel,
        settings: input.settings,
        attachments
      });
      active.starting = starting;
      const run = await starting;
      active.run = run;
      if (active.canceled) {
        await this.cancelActive(active);
        await run.result.catch(() => undefined);
        throw new PromptRefinementCanceledError();
      }

      const { output: modelOutput, attachmentSubmissions } = await run.result;
      if (active.canceled) throw new PromptRefinementCanceledError();
      let refined: Awaited<ReturnType<typeof parseModelRefinement>>;
      try {
        refined = await parseModelRefinement({
          output: modelOutput,
          repositoryPath: input.repositoryPath,
          attachments: attachmentContext,
          attachmentSubmissions,
          forbiddenManagedPaths: attachments.map((attachment) => attachment.path)
        });
      } catch (cause) {
        throw new PromptRefinementResponseValidationError(cause);
      }
      return {
        ...refined,
        source: 'model'
      };
    } catch (cause) {
      if (active.canceled || cause instanceof PromptRefinementCanceledError) {
        throw new PromptRefinementCanceledError();
      }
      if (cause instanceof PromptRefinementTerminationUnconfirmedError) {
        this.terminationFence = cause;
      }
      return unchangedFallback(input, userRequest, false, cause);
    } finally {
      if (this.active.get(requestId) === active) this.active.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    const active = this.active.get(requireRequestId(requestId));
    if (!active) return;
    active.canceled = true;
    try {
      await this.cancelActive(active);
    } catch (cause) {
      const error =
        cause instanceof PromptRefinementTerminationUnconfirmedError
          ? cause
          : new PromptRefinementTerminationUnconfirmedError(cause);
      this.terminationFence = error;
      throw error;
    }
  }

  beginShutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.accepting = false;
    const work = Promise.allSettled(
      [...this.active.keys()].map((requestId) => this.cancel(requestId))
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
          : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Prompt refinement shutdown cleanup is incomplete.');
      }
    });
    this.shutdownWork = work;
    return work;
  }

  private cancelActive(active: ActiveRefinement): Promise<void> {
    if (active.cancellation) return active.cancellation;
    active.cancellation = (async () => {
      let run = active.run;
      if (!run && active.starting) {
        try {
          run = await active.starting;
        } catch {
          // Setup failed before it returned a process-owning run.
          return;
        }
      }
      await run?.cancel();
    })();
    return active.cancellation;
  }
}

async function parseModelRefinement(input: {
  output: string;
  repositoryPath: string;
  attachments: readonly {
    id: string;
    displayName: string;
    kind: 'image' | 'text';
  }[];
  attachmentSubmissions: readonly AttachmentSubmissionRecord[];
  forbiddenManagedPaths: readonly string[];
}): Promise<Pick<RefinePromptResponse, 'prompt' | 'titleSuggestion' | 'evidence'>> {
  const normalized = input.output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  if (typeof parsed.prompt !== 'string' || typeof parsed.titleSuggestion !== 'string') {
    throw new Error('Prompt refinement response has an invalid shape.');
  }

  const prompt = parsed.prompt.trim();
  const titleSuggestion = parsed.titleSuggestion.trim();
  if (!prompt || prompt.length > MAX_REFINED_PROMPT_CHARS || !titleSuggestion) {
    throw new Error('Prompt refinement response is incomplete.');
  }
  const repositoryInspection = parsed.repositoryInspection;
  if (
    repositoryInspection !== 'none' &&
    repositoryInspection !== 'focused' &&
    repositoryInspection !== 'expanded'
  ) {
    throw new Error('Prompt refinement repository evidence is invalid.');
  }
  const repositoryFilesInspected = stringArray(
    parsed.repositoryFilesInspected,
    'repository files'
  );
  if (
    (repositoryInspection === 'none' && repositoryFilesInspected.length > 0) ||
    (repositoryInspection !== 'none' && repositoryFilesInspected.length === 0)
  ) {
    throw new Error('Prompt refinement repository evidence is inconsistent.');
  }
  await validateRepositoryFiles(input.repositoryPath, repositoryFilesInspected);

  const attachmentIdsInspected = stringArray(
    parsed.attachmentIdsInspected,
    'inspected attachments'
  );
  const attachmentIdsReferenced = stringArray(
    parsed.attachmentIdsReferenced,
    'referenced attachments'
  );
  const attachmentsById = new Map(
    input.attachments.map((attachment) => [attachment.id, attachment])
  );
  const inspectedAttachmentIds = new Set(
    input.attachmentSubmissions.map((submission) => submission.attachmentId)
  );
  for (const id of attachmentIdsInspected) {
    const attachment = attachmentsById.get(id);
    if (!attachment || !inspectedAttachmentIds.has(id)) {
      throw new Error('Prompt refinement claimed attachment evidence it could not inspect.');
    }
  }
  for (const id of attachmentIdsReferenced) {
    const attachment = attachmentsById.get(id);
    if (!attachment) {
      throw new Error('Prompt refinement attachment references are not grounded.');
    }
  }
  if (
    input.forbiddenManagedPaths.some(
      (managedPath) =>
        prompt.includes(managedPath) || titleSuggestion.includes(managedPath)
    )
  ) {
    throw new Error('Prompt refinement exposed an ephemeral attachment path.');
  }

  const evidence: PromptRefinementEvidence = {
    repositoryInspection,
    repositoryFilesInspected,
    attachmentIdsInspected,
    attachmentIdsReferenced
  };
  return {
    prompt,
    titleSuggestion: titleSuggestion.slice(0, 72),
    evidence
  };
}

async function validateRepositoryFiles(
  repositoryPath: string,
  relativePaths: readonly string[]
): Promise<void> {
  if (relativePaths.length === 0) return;
  const repositoryRoot = await fs.realpath(repositoryPath);
  for (const relativePath of relativePaths) {
    if (
      path.isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      throw new Error('Prompt refinement repository paths must stay inside the repository.');
    }
    const candidate = await fs.realpath(path.resolve(repositoryRoot, relativePath));
    const relative = path.relative(repositoryRoot, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Prompt refinement repository paths must stay inside the repository.');
    }
    if (!(await fs.stat(candidate)).isFile()) {
      throw new Error('Prompt refinement repository evidence must name inspected files.');
    }
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_EVIDENCE_ITEMS ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`Prompt refinement ${label} evidence is invalid.`);
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Prompt refinement ${label} evidence contains duplicates.`);
  }
  return normalized;
}

function unchangedFallback(
  input: Pick<PromptRefinementInput, 'title'>,
  userRequest: string,
  terminationFenced: boolean,
  cause?: unknown
): RefinePromptResponse {
  return {
    prompt: userRequest,
    titleSuggestion: input.title?.trim() || titleFromInput(userRequest),
    source: 'unchanged-fallback',
    evidence: emptyEvidence(),
    warning: terminationFenced
      ? 'Prompt refinement is temporarily unavailable because a previous refinement process could not be stopped. The original request was kept unchanged.'
      : refinementFailureWarning(cause)
  };
}

function refinementFailureWarning(cause: unknown): string {
  const unchanged = 'The original request was kept unchanged.';
  if (cause instanceof PromptRefinementResponseValidationError) {
    return `The refinement model returned a response Task Monki could not validate. ${unchanged}`;
  }
  return `Prompt refinement could not be completed reliably. ${unchanged}`;
}

function emptyEvidence(): PromptRefinementEvidence {
  return {
    repositoryInspection: 'none',
    repositoryFilesInspected: [],
    attachmentIdsInspected: [],
    attachmentIdsReferenced: []
  };
}

function requireRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!REQUEST_ID.test(normalized)) {
    throw new Error('Prompt refinement request id is invalid.');
  }
  return normalized;
}

function titleFromInput(input: string): string {
  const firstLine = input.split(/\r?\n/u).find(Boolean) ?? input;
  const normalized = firstLine.replace(/[.?!]+$/gu, '').trim();
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trim()}...`;
}
