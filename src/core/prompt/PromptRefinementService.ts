import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutionSettings, AgentModel } from '../../shared/agent';
import {
  type PromptRefinementEvidence,
  type RefinePromptResponse
} from '../../shared/contracts';
import { buildPromptRefinementInstruction } from '../../shared/promptTemplates';
import {
  verifyAgentTurnAttachments,
  type AgentTurnAttachment
} from '../agent/AgentAttachmentDelivery';
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
  result: Promise<string>;
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

  constructor(private readonly runModel: PromptRefinementRunner) {}

  async refine(input: PromptRefinementInput): Promise<RefinePromptResponse> {
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
      const attachments = await verifyAgentTurnAttachments(input.attachments ?? []);
      const nativeImageIds = nativeImageAttachmentIds(
        userRequest,
        attachments,
        input.refinementModel
      );
      const attachmentContext = attachments.map((attachment, index) => {
        const providedAsImage = nativeImageIds.has(attachment.attachmentId);
        const canReadAsText = attachment.kind === 'text';
        return {
          id: attachment.attachmentId,
          referenceLabel: `Attachment ${index + 1} (${attachment.displayName})`,
          displayName: attachment.displayName,
          kind: attachment.kind,
          mediaType: attachment.mediaType,
          byteCount: attachment.byteCount,
          ...(canReadAsText ? { readOnlyPath: attachment.path } : {}),
          providedAsImage
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

      const modelOutput = await run.result;
      if (active.canceled) throw new PromptRefinementCanceledError();
      let refined: Awaited<ReturnType<typeof parseModelRefinement>>;
      try {
        refined = await parseModelRefinement({
          output: modelOutput,
          repositoryPath: input.repositoryPath,
          attachments: attachmentContext
        });
      } catch (cause) {
        throw new PromptRefinementResponseValidationError(cause);
      }
      const relevantImagesNotInspectable = attachments.some(
        (attachment) =>
          attachment.kind === 'image' &&
          imageAttachmentLooksRelevant(userRequest, attachment.displayName) &&
          !nativeImageIds.has(attachment.attachmentId)
      );
      return {
        ...refined,
        source: 'model',
        ...(relevantImagesNotInspectable
          ? {
              warning: `${input.refinementModel.displayName} cannot inspect the relevant image attachment directly. The image remains attached to the downstream task and was referenced without claiming to understand its contents.`
            }
          : {})
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
    readOnlyPath?: string;
    providedAsImage: boolean;
  }[];
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
  for (const id of attachmentIdsInspected) {
    const attachment = attachmentsById.get(id);
    if (
      !attachment ||
      (attachment.kind === 'image' && !attachment.providedAsImage) ||
      (attachment.kind === 'text' && !attachment.readOnlyPath)
    ) {
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
    input.attachments.some(
      (attachment) => attachment.readOnlyPath && prompt.includes(attachment.readOnlyPath)
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

function nativeImageAttachmentIds(
  userRequest: string,
  attachments: readonly AgentTurnAttachment[],
  model: AgentModel
): Set<string> {
  const supportsImages = model.inputModalities.some(
    (modality) => modality.toLowerCase() === 'image'
  );
  if (!supportsImages) return new Set();
  return new Set(
    attachments
      .filter(
        (attachment) =>
          attachment.kind === 'image' &&
          imageAttachmentLooksRelevant(userRequest, attachment.displayName)
      )
      .map((attachment) => attachment.attachmentId)
  );
}

export function imageAttachmentLooksRelevant(
  userRequest: string,
  displayName: string
): boolean {
  const normalized = userRequest.toLocaleLowerCase('en-US');
  return (
    normalized.includes(displayName.toLocaleLowerCase('en-US')) ||
    /^(?:please\s+)?(?:fix|change|update|match|make)\s+(?:this|that|it)\b/u.test(
      normalized.trim()
    ) ||
    /\b(attach(?:ed|ment)?|image|screenshot|screen|mockup|design|visual|ui|ux|layout|style|color|colour|icon|photo|diagram|shown|look|pixel|responsive|frontend|page|button|modal|panel)\b/u.test(
      normalized
    )
  );
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
