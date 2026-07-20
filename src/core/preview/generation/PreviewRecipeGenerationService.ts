import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  type PreviewAttachmentPlan,
  type PreviewEnvironmentValue,
  type PreviewExecutionPlan,
  type PreviewRecipeGenerationDraft,
  type PreviewRecipeGenerationReport,
  type PreviewRecipeGenerationSnapshot,
  type PreviewPublicEnvironmentDecision,
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
  activePreviewAttachmentIds,
  parsePreviewRecipe
} from '../PreviewRecipeLoader';
import {
  buildPreviewRecipeGenerationInstruction,
  PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION
} from './PreviewRecipeGenerationSupport';
import type { PreviewFrameworkCapabilities } from './PreviewFrameworkCapabilities';
import { preparePreviewRecipeEvidenceBundle } from './PreviewRecipeEvidenceBundle';
import type {
  PreviewPublicEnvironmentCandidate,
  PreviewPublicEnvironmentEvidence
} from './PreviewPublicEnvironmentEvidence';

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

interface DraftValidationAuthority {
  taskId: string;
  capabilities: PreviewFrameworkCapabilities;
  publicEnvironmentCandidates: PreviewPublicEnvironmentCandidate[];
  publicEnvironmentDecisions: PreviewPublicEnvironmentDecision[];
}

class InvalidAgentGenerationError extends Error {}

export class PreviewRecipeGenerationService {
  private readonly states = new Map<string, PreviewRecipeGenerationSnapshot>();
  private readonly operations = new Map<string, ActiveGeneration>();
  private readonly draftValidationAuthority = new Map<string, DraftValidationAuthority>();
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
    const authority = this.draftValidationAuthority.get(draftId);
    if (!authority || authority.taskId !== taskId) {
      throw new Error('The Preview recipe draft is no longer current.');
    }
    return validateAgentGeneratedPreviewRecipeDraft(
      yaml,
      authority.capabilities,
      authority.publicEnvironmentCandidates,
      authority.publicEnvironmentDecisions
    );
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
    const authority = this.draftValidationAuthority.get(input.draftId);
    if (!authority || authority.taskId !== input.taskId) {
      throw new Error('The Preview recipe draft is no longer current.');
    }
    const validation = validateAgentGeneratedPreviewRecipeDraft(
      input.yaml,
      authority.capabilities,
      authority.publicEnvironmentCandidates,
      authority.publicEnvironmentDecisions
    );
    if (validation.status !== 'VALID') {
      throw new Error(validation.issues[0]?.message ?? 'The Preview recipe is invalid.');
    }
    await writeNewPreviewRecipe(input.worktreePath, input.yaml);
  }

  completeAcceptance(taskId: string): PreviewRecipeGenerationSnapshot {
    this.states.delete(taskId);
    this.clearDraftAuthority(taskId);
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
    this.clearDraftAuthority(taskId);
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
    this.draftValidationAuthority.clear();
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
        parsed = parseAgentGeneration(
          output,
          evidence.includedPaths,
          evidence.publicEnvironment
        );
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
      const validation = validateAgentGeneratedPreviewRecipeDraft(
        parsed.yaml ?? '',
        evidence.frameworkCapabilities,
        evidence.publicEnvironment.candidates,
        parsed.report.publicEnvironmentDecisions
      );
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
      const finished = this.finish(
        input.taskId,
        operation,
        { taskId: input.taskId, status: 'READY', draft },
        input.onUpdate
      );
      this.clearDraftAuthority(input.taskId);
      this.draftValidationAuthority.set(draft.id, {
        taskId: input.taskId,
        capabilities: structuredClone(evidence.frameworkCapabilities),
        publicEnvironmentCandidates: structuredClone(evidence.publicEnvironment.candidates),
        publicEnvironmentDecisions: structuredClone(parsed.report.publicEnvironmentDecisions)
      });
      return finished;
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

  private clearDraftAuthority(taskId: string): void {
    for (const [draftId, entry] of this.draftValidationAuthority) {
      if (entry.taskId === taskId) this.draftValidationAuthority.delete(draftId);
    }
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

function validateAgentGeneratedPreviewRecipeDraft(
  yaml: string,
  capabilities: PreviewFrameworkCapabilities,
  candidates: readonly PreviewPublicEnvironmentCandidate[],
  decisions: readonly PreviewPublicEnvironmentDecision[]
): PreviewRecipeValidation {
  const validation = validateGeneratedPreviewRecipeDraft(yaml, capabilities);
  if (validation.status !== 'VALID') return validation;
  const plan = parsePreviewRecipe(yaml).executionPlan;
  const activeAttachmentIds = new Set(activePreviewAttachmentIds(plan));
  const scenario = plan.scenarios.find((candidate) => candidate.id === plan.selectedScenarioId);
  const activeJobIds = new Set([
    ...plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
    ...(scenario?.jobs ?? [])
  ]);
  const activeNodes = [
    ...plan.jobs.filter((job) => activeJobIds.has(job.id)),
    ...plan.services,
    ...plan.workers
  ];
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const decision of decisions) {
    const candidate = candidateById.get(decision.candidateId);
    if (!candidate) return invalidPublicEnvironmentDecision();
    const recipientValues = activeNodes.flatMap((node): PreviewEnvironmentValue[] => {
      const environments = [node.env];
      if ('ready' in node && node.ready.type === 'argv') environments.push(node.ready.env ?? {});
      if ('liveness' in node && node.liveness?.probe.type === 'argv') {
        environments.push(node.liveness.probe.env ?? {});
      }
      return environments.flatMap((environment) =>
        environment[candidate.key] === undefined ? [] : [environment[candidate.key]]
      );
    });
    if (decision.decision === 'HTTP_ATTACHMENT') {
      const attachment = plan.attachments?.find(
        (candidate) => candidate.id === decision.attachmentId
      );
      if (
        !decision.attachmentId || recipientValues.length === 0 ||
        recipientValues.some(
          (value) =>
            typeof value === 'string' || value.type !== 'attached-http-origin' ||
            value.attachment !== decision.attachmentId
        ) ||
        !activeAttachmentIds.has(decision.attachmentId) ||
        attachment?.type !== 'http' ||
        !publicTargetMatchesPolicy(attachment.target, candidate)
      ) return invalidPublicEnvironmentDecision();
    } else if (decision.decision === 'SOURCE_DEFAULT') {
      if (!candidate.sourceDefault || recipientValues.length > 0) {
        return invalidPublicEnvironmentDecision();
      }
    } else if (recipientValues.length > 0) {
      return invalidPublicEnvironmentDecision();
    }
  }
  return validation;
}

function publicTargetMatchesPolicy(
  target: PreviewAttachmentPlan['target'],
  candidate: PreviewPublicEnvironmentCandidate
): boolean {
  if (target.type === 'local') return true;
  if (
    candidate.targetPolicy.kind !== 'LITERAL_ALLOWED' ||
    target.type !== 'endpoint' ||
    !('scheme' in target)
  ) return false;
  const evidenced = candidate.targetPolicy.publicHttpTarget;
  return target.scheme === evidenced.scheme && target.host === evidenced.host &&
    target.port === evidenced.port && target.basePath === evidenced.basePath;
}

function invalidPublicEnvironmentDecision(): PreviewRecipeValidation {
  return {
    status: 'INVALID',
    issues: [{
      code: 'PUBLIC_ENVIRONMENT_DECISION_INVALID',
      message: 'The generated public environment decision does not match the Preview recipe.'
    }]
  };
}

function validateGeneratedPreviewRecipeDraft(
  yaml: string,
  capabilities: PreviewFrameworkCapabilities
): PreviewRecipeValidation {
  const validation = validatePreviewRecipeDraft(yaml);
  if (validation.status !== 'VALID') return validation;
  const plan = parsePreviewRecipe(yaml).executionPlan;
  const longNodes = [...plan.services, ...plan.workers];
  const commands = longNodes.map((node) => node.command);
  if (generatedCommands(plan).some(isImplicitPackageAcquisition)) {
    return dependencyPreparationRequired(
      'Generated Preview recipes must declare dependency installation as an explicit finite job; implicit npm exec, npx, or dlx acquisition is not allowed.'
    );
  }
  for (const command of commands) {
    if (containsExplicitRuntimeConflict(command)) {
      return incompatibleCommand(
        'The generated command contains a fixed port or HTTPS listener flag that conflicts with Preview.'
      );
    }
  }
  const normalizedYaml = yaml.split(/\r?\n/).map((line) => line.trimStart()).join('\n');
  for (const capability of capabilities.analyses) {
    const repositoryScriptNodes = longNodes.filter((node) =>
      equalCommand(node.command, capability.scriptCommand)
    );
    const directFrameworkNodes = longNodes.filter((node) => invokesNextDev(node.command));
    if (!capability.compatiblePreviewCommand) {
      if (repositoryScriptNodes.length > 0 || directFrameworkNodes.length > 0) {
        return dependencyPreparationRequired(
          capability.limitation ?? 'The generated framework command has no trusted dependency-preparation path.'
        );
      }
      continue;
    }
    if (capability.conflicts.length > 0 && repositoryScriptNodes.length > 0) {
      return incompatibleCommand(
        'The generated command uses a repository script with a known Preview port or protocol conflict.'
      );
    }
    const compatibleNodes = longNodes.filter((node) =>
      equalCommand(node.command, capability.compatiblePreviewCommand!)
    );
    if (
      directFrameworkNodes.length > 0 &&
      directFrameworkNodes.some((node) => !compatibleNodes.includes(node))
    ) {
      return incompatibleCommand(
        'The generated direct framework command does not match the trusted Preview-compatible command.'
      );
    }
    if (
      compatibleNodes.length > 0 &&
      capability.yamlCommentLines &&
      !normalizedYaml.includes(capability.yamlCommentLines.join('\n'))
    ) {
      return incompatibleCommand(
        'The generated Preview-only framework command must retain its compatibility comment.'
      );
    }
    const preparation = capability.dependencyPreparation;
    if (!preparation || compatibleNodes.length === 0) continue;
    const installJobs = plan.jobs.filter((job) =>
      job.role === 'generic' &&
      job.cwd === preparation.cwd &&
      equalCommand(job.command, preparation.installCommand)
    );
    if (installJobs.length !== 1) {
      return dependencyPreparationRequired(
        'The generated framework command requires exactly one generic lockfile installation job in the package root.'
      );
    }
    const installJob = installJobs[0];
    if (Object.keys(installJob.needs).length > 0 || Object.keys(installJob.env).length > 0) {
      return dependencyPreparationRequired(
        'The trusted lockfile installation job must not invent prerequisites or environment overrides.'
      );
    }
    if (
      compatibleNodes.some((node) =>
        node.cwd !== preparation.cwd || node.needs[installJob.id] !== 'succeeded'
      )
    ) {
      return dependencyPreparationRequired(
        'Every generated framework node must explicitly need the lockfile installation job to succeed.'
      );
    }
    if (!normalizedYaml.includes(preparation.yamlCommentLines.join('\n'))) {
      return dependencyPreparationRequired(
        'The generated lockfile installation job must retain its lifecycle-script review comment.'
      );
    }
  }
  return validation;
}

function generatedCommands(plan: PreviewExecutionPlan): string[][] {
  const nodes = [...plan.jobs, ...plan.services, ...plan.workers];
  const commands = nodes.map((node) => node.command);
  for (const node of [...plan.services, ...plan.workers]) {
    if (node.ready.type === 'argv') commands.push(node.ready.command);
    if (node.liveness?.probe.type === 'argv') commands.push(node.liveness.probe.command);
  }
  return commands;
}

function isImplicitPackageAcquisition(command: string[]): boolean {
  return (
    command[0] === 'npx' ||
    (command[0] === 'npm' && command[1] === 'exec') ||
    (command[0] === 'pnpm' && command[1] === 'dlx') ||
    (command[0] === 'yarn' && command[1] === 'dlx')
  );
}

function invokesNextDev(command: string[]): boolean {
  const nextIndex = command.findIndex((argument) =>
    argument === 'next' ||
    argument.endsWith('/next') ||
    argument.endsWith('/next/dist/bin/next')
  );
  return nextIndex >= 0 && command[nextIndex + 1] === 'dev';
}

function containsExplicitRuntimeConflict(command: string[]): boolean {
  const nextIndex = command.findIndex((argument, index) =>
    (argument === 'next' || argument.endsWith('/next')) && command[index + 1] === 'dev'
  );
  if (nextIndex < 0) return false;
  return command.slice(nextIndex + 2).some((argument) =>
    argument === '-p' ||
    argument === '--port' ||
    /^(?:-p=?|--port=)\d+$/.test(argument) ||
    argument === '--experimental-https' ||
    /^--experimental-https-(?:key|cert|ca)(?:=|$)/.test(argument)
  );
}

function equalCommand(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function incompatibleCommand(message: string): PreviewRecipeValidation {
  return { status: 'INVALID', issues: [{ code: 'INCOMPATIBLE_COMMAND', message }] };
}

function dependencyPreparationRequired(message: string): PreviewRecipeValidation {
  return {
    status: 'INVALID',
    issues: [{ code: 'DEPENDENCY_PREPARATION_REQUIRED', message }]
  };
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
  includedPaths: ReadonlySet<string>,
  publicEnvironment: PreviewPublicEnvironmentEvidence
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
    'unresolvedDecisions',
    'publicEnvironmentDecisions'
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
    ),
    publicEnvironmentDecisions: normalizePublicEnvironmentDecisions(
      value.publicEnvironmentDecisions,
      publicEnvironment.candidates
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

function normalizePublicEnvironmentDecisions(
  value: unknown,
  candidates: readonly PreviewPublicEnvironmentCandidate[]
): PreviewPublicEnvironmentDecision[] {
  if (!Array.isArray(value) || value.length !== candidates.length) {
    throw new Error('Every public environment candidate requires one decision.');
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const decisions = value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid public environment decision.');
    const record = item as Record<string, unknown>;
    const allowed = new Set(['candidateId', 'key', 'decision', 'reason', 'attachmentId']);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new Error('Invalid public environment decision.');
    }
    const candidateId = normalizeSafeReportText(record.candidateId, 'candidateId');
    const key = normalizeSafeReportText(record.key, 'public environment key');
    const candidate = candidateById.get(candidateId);
    if (!candidate || candidate.key !== key || seen.has(candidateId)) {
      throw new Error('Invalid public environment decision candidate.');
    }
    seen.add(candidateId);
    const decision = record.decision as PreviewPublicEnvironmentDecision['decision'];
    if (decision !== 'HTTP_ATTACHMENT' && decision !== 'SOURCE_DEFAULT' && decision !== 'OMIT') {
      throw new Error('Invalid public environment decision type.');
    }
    const reason = normalizeSafeReportText(record.reason, 'public environment decision reason');
    const attachmentId = record.attachmentId === undefined
      ? undefined
      : normalizeSafeReportText(record.attachmentId, 'attachmentId');
    if (
      (decision === 'HTTP_ATTACHMENT' && (!attachmentId || !/^[a-z][a-z0-9-]{0,47}$/.test(attachmentId))) ||
      (decision !== 'HTTP_ATTACHMENT' && attachmentId !== undefined) ||
      (decision === 'SOURCE_DEFAULT' && !candidate.sourceDefault)
    ) throw new Error('Invalid public environment decision authority.');
    return { candidateId, key, decision, reason, attachmentId };
  });
  return decisions.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
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
