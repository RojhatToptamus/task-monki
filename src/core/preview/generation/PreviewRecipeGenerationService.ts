import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAlias, isScalar, parseDocument, visit } from 'yaml';
import { parsePreviewSpec, type PreviewSpec } from 'previewhost';
import type {
  PreviewRecipeGenerationDraft,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation,
  PreviewRecipeValidationIssue
} from '../../../shared/contracts';
import {
  analyzePreviewFrameworkCapabilities,
  inspectPreviewFrameworkRepositoryFacts,
  type PreviewFrameworkCapabilities
} from './PreviewFrameworkCapabilities';
import { configurationFormatReason } from '../ApplicationPreviewConfiguration';
import { readPreviewRecipeFile, writeReviewedPreviewRecipe, type PreviewRecipeFile } from './PreviewRecipeFile';

export const PREVIEW_RECIPE_PATH = 'preview.yaml';
const MAX_PREVIEW_RECIPE_BYTES = 65_536;
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const SECRET_ENV_KEY = /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;
type Configuration = ReturnType<typeof parsePreviewSpec>;

/** A configuration the Preview agent submits for review, with its own account of it. */
export interface PreviewRecipeProposal {
  taskId: string;
  worktreePath: string;
  yaml: string;
  summary: string;
  notes: string[];
}

export type PreviewRecipeProposalResult =
  | { status: 'READY'; draft: PreviewRecipeGenerationDraft }
  | { status: 'INVALID'; issues: PreviewRecipeValidationIssue[] };

/** What a draft was checked against; later edits are revalidated against the same facts and file. */
interface DraftValidationAuthority {
  taskId: string;
  worktreePath: string;
  originalFile?: PreviewRecipeFile;
  capabilities: PreviewFrameworkCapabilities;
}

/**
 * Holds the Preview agent's configuration proposals until the user saves or discards them.
 * A proposal is validated against the Preview contract and the worktree's framework facts the
 * moment it is submitted, so the agent learns the exact problem and the user only ever reviews
 * a valid draft. Nothing here writes the worktree except the explicit acceptance.
 */
export class PreviewRecipeGenerationService {
  private readonly states = new Map<string, PreviewRecipeGenerationSnapshot>();
  private readonly draftValidationAuthority = new Map<string, DraftValidationAuthority>();

  get(taskId: string): PreviewRecipeGenerationSnapshot {
    return structuredClone(this.states.get(taskId) ?? { taskId, status: 'EMPTY' });
  }

  async propose(input: PreviewRecipeProposal): Promise<PreviewRecipeProposalResult> {
    const worktreePath = await fs.realpath(input.worktreePath);
    const [originalFile, capabilities] = await Promise.all([
      readPreviewRecipeFile(worktreePath),
      readPreviewFrameworkCapabilities(worktreePath)
    ]);
    const validation = validateProposedPreviewRecipe(input.yaml, capabilities);
    if (validation.status !== 'VALID') return validation;
    const report = { summary: input.summary.trim(), notes: input.notes.map((note) => note.trim()).filter(Boolean) };
    if ([report.summary, ...report.notes].some(looksLikeSecret)) {
      return invalid('SECRET_LITERAL', 'The summary or notes contain a secret-like value. Name secrets; never write their values.');
    }
    const draft: PreviewRecipeGenerationDraft = {
      id: randomUUID(),
      taskId: input.taskId,
      yaml: input.yaml,
      report,
      validation,
      generatedAt: new Date().toISOString(),
      fileName: originalFile?.name ?? PREVIEW_RECIPE_PATH,
      replacesExistingFile: !!originalFile
    };
    this.clearDraftAuthority(input.taskId);
    this.draftValidationAuthority.set(draft.id, { taskId: input.taskId, worktreePath, originalFile, capabilities });
    this.states.set(input.taskId, { taskId: input.taskId, status: 'READY', draft });
    return { status: 'READY', draft: structuredClone(draft) };
  }

  /** The file the draft was written against, so the editor can show what changes. */
  reviewedFile(taskId: string, draftId: string): PreviewRecipeFile | undefined {
    const authority = this.requireAuthority(taskId, draftId);
    return authority.originalFile ? { ...authority.originalFile } : undefined;
  }

  /** Revalidates the user's edits with the facts the proposal was checked against. */
  validate(taskId: string, draftId: string, yaml: string): PreviewRecipeValidation {
    return validateProposedPreviewRecipe(yaml, this.requireAuthority(taskId, draftId).capabilities);
  }

  async writeAcceptedRecipe(input: {
    taskId: string;
    draftId: string;
    yaml: string;
    worktreePath: string;
  }): Promise<PreviewRecipeFile['name']> {
    const authority = this.requireAuthority(input.taskId, input.draftId);
    const validation = validateProposedPreviewRecipe(input.yaml, authority.capabilities);
    if (validation.status !== 'VALID') {
      throw new Error(validation.issues[0]?.message ?? 'The Preview recipe is invalid.');
    }
    if ((await fs.realpath(input.worktreePath)) !== authority.worktreePath) {
      throw new Error('The task worktree changed. Ask the agent for a fresh proposal.');
    }
    return writeReviewedPreviewRecipe(input.worktreePath, input.yaml, authority.originalFile);
  }

  completeAcceptance(taskId: string): PreviewRecipeGenerationSnapshot {
    return this.discard(taskId);
  }

  discard(taskId: string): PreviewRecipeGenerationSnapshot {
    this.states.delete(taskId);
    this.clearDraftAuthority(taskId);
    return { taskId, status: 'EMPTY' };
  }

  clearTask(taskId: string): void {
    this.discard(taskId);
  }

  shutdown(): void {
    this.states.clear();
    this.draftValidationAuthority.clear();
  }

  private requireAuthority(taskId: string, draftId: string): DraftValidationAuthority {
    const authority = this.draftValidationAuthority.get(draftId);
    if (!authority || authority.taskId !== taskId || this.states.get(taskId)?.draft?.id !== draftId) {
      throw new Error('The Preview proposal is no longer current.');
    }
    return authority;
  }

  private clearDraftAuthority(taskId: string): void {
    for (const [draftId, entry] of this.draftValidationAuthority) {
      if (entry.taskId === taskId) this.draftValidationAuthority.delete(draftId);
    }
  }
}

/** Framework facts come from the root manifest and lockfile only; the agent reads the rest itself. */
async function readPreviewFrameworkCapabilities(worktreePath: string): Promise<PreviewFrameworkCapabilities> {
  const manifestPath = path.join(worktreePath, 'package.json');
  const stat = await fs.lstat(manifestPath).catch(() => undefined);
  const manifest = stat?.isFile() && stat.size <= MAX_PACKAGE_MANIFEST_BYTES
    ? await fs.readFile(manifestPath, 'utf8').catch(() => undefined)
    : undefined;
  return analyzePreviewFrameworkCapabilities(
    manifest === undefined ? [] : [{ path: 'package.json', content: manifest }],
    await inspectPreviewFrameworkRepositoryFacts(worktreePath)
  );
}

/** The contract every reviewed file must meet, whoever wrote it. */
export function validatePreviewRecipeDraft(yaml: string): PreviewRecipeValidation {
  if (!yaml.trim()) return invalid('EMPTY_RECIPE', 'The Preview recipe is empty.');
  if (Buffer.byteLength(yaml, 'utf8') > MAX_PREVIEW_RECIPE_BYTES) {
    return invalid('RECIPE_TOO_LARGE', 'The Preview recipe exceeds 64 KiB.');
  }
  let plan: Configuration;
  try {
    plan = parseConfiguration(yaml);
  } catch (error) {
    return invalid('INVALID_RECIPE', `The YAML does not match the Preview contract: ${configurationFormatReason(error)}`);
  }
  if (/^tm-[0-9a-f-]{36}$/i.test(plan.name)) {
    return invalid('INVALID_RECIPE', 'Use a readable project name. Task Monki assigns runtime identity separately.');
  }
  if (/\[concealed literal[^\]]*\]|\[credential-like diagnostic withheld\]|\[REDACTED\]/i.test(yaml)) {
    return invalid('INVALID_RECIPE', 'Replace concealed placeholders with an explicit nonsecret value or secret reference before saving.');
  }
  // Name where the problem is, never the value, so the file can be corrected without repeating it.
  const literalKeys = secretLiteralKeys(plan);
  if (literalKeys.length) {
    return invalid('SECRET_LITERAL', `Use a secret reference for ${literalKeys.slice(0, 5).join(', ')}${literalKeys.length > 5 ? ` and ${literalKeys.length - 5} more` : ''}: secret-like environment keys never take a literal value.`);
  }
  if (looksLikeSecret(yaml)) {
    return invalid('SECRET_LITERAL', 'The file contains a credential-like value, such as a private key, an access token or a connection URL with a password. Use a secret reference instead.');
  }
  const bindings = commandNodes(plan).flatMap((node) => commandEnvironments(node).flatMap(Object.values));
  if (plan.type === 'environment') {
    for (const service of Object.values(plan.services)) {
      if ((service.type === 'external-postgres' || service.type === 'external-redis') && service.url) bindings.push(service.url);
    }
  }
  if (bindings.some((value) => typeof value === 'object' && 'fromEnv' in value)) {
    return invalid('INVALID_RECIPE', 'Task Monki does not supply fromEnv inputs. Use a secret reference or an explicit nonsecret value.');
  }
  return { status: 'VALID' };
}

/**
 * The agent's proposal must also respect what Task Monki knows about the framework: no implicit
 * package acquisition, no fixed ports or HTTPS flags, and a reviewed lockfile installation job
 * wherever the trusted Next.js command needs one.
 */
export function validateProposedPreviewRecipe(
  yaml: string,
  capabilities: PreviewFrameworkCapabilities
): PreviewRecipeValidation {
  const validation = validatePreviewRecipeDraft(yaml);
  if (validation.status !== 'VALID') return validation;
  const plan = parseConfiguration(yaml);
  const longNodes = commandNodes(plan).filter((node) => node.type !== 'job');
  if (allCommands(plan).some(isImplicitPackageAcquisition)) {
    return dependencyPreparationRequired(
      'Declare dependency installation as an explicit finite job; implicit npm exec, npx, or dlx acquisition is not allowed.'
    );
  }
  for (const node of longNodes) {
    if (containsExplicitRuntimeConflict(node.command)) {
      return incompatibleCommand(
        `Service ${node.id} fixes a port or enables HTTPS. Preview assigns the port and serves HTTP; remove those flags.`
      );
    }
  }
  const normalizedYaml = yaml.split(/\r?\n/).map((line) => line.trimStart()).join('\n');
  for (const capability of capabilities.analyses) {
    const repositoryScriptNodes = longNodes.filter((node) => equalCommand(node.command, capability.scriptCommand));
    const directFrameworkNodes = longNodes.filter((node) => invokesNextDev(node.command));
    if (!capability.compatiblePreviewCommand) {
      if (repositoryScriptNodes.length > 0 || directFrameworkNodes.length > 0) {
        return dependencyPreparationRequired(
          capability.limitation ?? 'The framework command has no trusted dependency-preparation path.'
        );
      }
      continue;
    }
    if (capability.conflicts.length > 0 && repositoryScriptNodes.length > 0) {
      return incompatibleCommand(
        `The repository script "${capability.repositoryCommand}" conflicts with Preview. Use the compatible command [${capability.compatiblePreviewCommand.join(', ')}] instead.`
      );
    }
    const compatibleNodes = longNodes.filter((node) => equalCommand(node.command, capability.compatiblePreviewCommand!));
    if (directFrameworkNodes.some((node) => !compatibleNodes.includes(node))) {
      return incompatibleCommand(
        `Run the framework exactly as [${capability.compatiblePreviewCommand.join(', ')}]; other direct framework commands are not trusted.`
      );
    }
    if (compatibleNodes.length > 0 && capability.yamlCommentLines && !normalizedYaml.includes(capability.yamlCommentLines.join('\n'))) {
      return incompatibleCommand(
        `Keep this comment above the framework command so the reviewer sees why it differs from the repository script:\n${capability.yamlCommentLines.join('\n')}`
      );
    }
    const preparation = capability.dependencyPreparation;
    if (!preparation || compatibleNodes.length === 0) continue;
    const installJobs = commandNodes(plan).filter(
      (job) => job.type === 'job' && job.cwd === preparation.cwd && equalCommand(job.command, preparation.installCommand)
    );
    if (installJobs.length !== 1) {
      return dependencyPreparationRequired(
        `Add exactly one job in ${preparation.cwd} running [${preparation.installCommand.join(', ')}] so dependencies install from the lockfile.`
      );
    }
    const installJob = installJobs[0];
    if (('dependsOn' in installJob && (installJob.dependsOn?.length ?? 0) > 0) || Object.keys(installJob.env).length > 0) {
      return dependencyPreparationRequired(`The ${installJob.id} install job must not declare dependsOn or env.`);
    }
    if (compatibleNodes.some((node) => node.cwd !== preparation.cwd || !('dependsOn' in node) || !node.dependsOn?.includes(installJob.id))) {
      return dependencyPreparationRequired(
        `Every framework service must run in ${preparation.cwd} and list ${installJob.id} in dependsOn.`
      );
    }
    if (!normalizedYaml.includes(preparation.yamlCommentLines.join('\n'))) {
      return dependencyPreparationRequired(
        `Keep this comment above the ${installJob.id} install command so the reviewer sees what it may run:\n${preparation.yamlCommentLines.join('\n')}`
      );
    }
  }
  return validation;
}

function parseConfiguration(yaml: string): Configuration {
  // Match Previewhost's file loader before accepting text that it will later read.
  const document = parseDocument(yaml, {
    schema: 'core', version: '1.2', stringKeys: true, uniqueKeys: true,
    resolveKnownTags: false, merge: false, customTags: [], prettyErrors: false
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new Error(`${problem.message} (YAML 1.2 only: no duplicate keys, aliases, merge keys or tags)`);
  if (document.directives?.yaml.version !== '1.2') throw new Error('Only YAML 1.2 documents are supported.');
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.tag) throw new Error('Aliases and tags are unsupported.');
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') throw new Error('Merge keys are unsupported.');
    }
  });
  return parsePreviewSpec(document.toJS({ maxAliasCount: 0 }) as PreviewSpec);
}


function commandNodes(spec: Configuration) {
  if (spec.type === 'command') return [{ id: 'app', ...spec }];
  if (spec.type !== 'environment') return [];
  return Object.entries(spec.services).flatMap(([id, service]) =>
    service.type === 'command' || service.type === 'worker' || service.type === 'job' ? [{ id, ...service }] : []
  );
}

function commandEnvironments(node: ReturnType<typeof commandNodes>[number]) {
  const environments = [node.env];
  if ('ready' in node && node.ready?.type === 'command') environments.push(node.ready.env ?? {});
  if ('liveness' in node && node.liveness?.probe.type === 'command') environments.push(node.liveness.probe.env ?? {});
  return environments;
}

function allCommands(plan: Configuration): string[][] {
  return commandNodes(plan).flatMap((node) => [
    node.command,
    ...('ready' in node && node.ready?.type === 'command' ? [node.ready.command] : []),
    ...('liveness' in node && node.liveness?.probe.type === 'command' ? [node.liveness.probe.command] : [])
  ]);
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
  const nextIndex = command.findIndex(
    (argument) => argument === 'next' || argument.endsWith('/next') || argument.endsWith('/next/dist/bin/next')
  );
  return nextIndex >= 0 && command[nextIndex + 1] === 'dev';
}

function containsExplicitRuntimeConflict(command: string[]): boolean {
  const nextIndex = command.findIndex(
    (argument, index) => (argument === 'next' || argument.endsWith('/next')) && command[index + 1] === 'dev'
  );
  if (nextIndex < 0) return false;
  return command.slice(nextIndex + 2).some(
    (argument) =>
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

function invalid(code: PreviewRecipeValidationIssue['code'], message: string): { status: 'INVALID'; issues: PreviewRecipeValidationIssue[] } {
  return { status: 'INVALID', issues: [{ code, message }] };
}

function incompatibleCommand(message: string) {
  return invalid('INCOMPATIBLE_COMMAND', message);
}

function dependencyPreparationRequired(message: string) {
  return invalid('DEPENDENCY_PREPARATION_REQUIRED', message);
}

/** Each `service KEY` whose secret-like key holds a literal string. */
function secretLiteralKeys(plan: Configuration): string[] {
  return [...new Set(commandNodes(plan).flatMap((node) =>
    commandEnvironments(node).flatMap((environment) =>
      Object.entries(environment).filter(([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === 'string').map(([key]) => `${node.id} ${key}`)
    )
  ))];
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
