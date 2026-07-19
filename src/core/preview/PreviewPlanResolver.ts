import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  PreviewAttachmentPlan,
  PreviewExecutionPlan,
  PreviewLocalAttachmentRequirement,
  PreviewOciEngineCapability,
  PreviewPlanRecord,
  WorktreeRecord
} from '../../shared/contracts';
import type { Task, TaskIteration } from '../../shared/contracts';
import {
  activePreviewAttachmentIds,
  activePreviewLocalAttachmentRequirements,
  previewExecutionDigest,
  type ParsedPreviewRecipe
} from './PreviewRecipeLoader';
import { canonicalProspectivePath, isPathWithin } from './PreviewPaths';
import { OciEngineAdapter } from './runtime/OciEngineAdapter';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewComposeInspector } from './compose/PreviewComposeInspector';
import { previewComposeProjectName } from './compose/PreviewComposeIdentity';

export interface ResolvePreviewPlanInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  parsed: ParsedPreviewRecipe;
  now?: string;
}

export class PreviewPlanResolver {
  constructor(
    private readonly ociEngine?: OciEngineAdapter,
    private readonly store?: FileTaskStore,
    private readonly composeInspector?: PreviewComposeInspector
  ) {}

  async resolve(input: ResolvePreviewPlanInput): Promise<PreviewPlanRecord> {
    const worktreeRoot = await canonicalProspectivePath(input.worktree.worktreePath);
    for (const node of [
      ...input.parsed.executionPlan.jobs,
      ...input.parsed.executionPlan.services,
      ...input.parsed.executionPlan.workers
    ]) {
      const cwd = await canonicalProspectivePath(path.join(worktreeRoot, node.cwd));
      if (!isPathWithin(worktreeRoot, cwd)) {
        throw new Error(`Preview node ${node.id} cwd escapes the task worktree.`);
      }
      for (const probe of [
        'ready' in node ? node.ready : undefined,
        'liveness' in node ? node.liveness?.probe : undefined
      ]) {
        if (probe?.type !== 'argv') continue;
        const probeCwd = await canonicalProspectivePath(path.join(worktreeRoot, probe.cwd));
        if (!isPathWithin(worktreeRoot, probeCwd)) {
          throw new Error(`Preview probe for ${node.id} escapes the task worktree.`);
        }
      }
    }

    let executionPlan = await this.resolveLocalAttachments(input.task.id, input.parsed.executionPlan);
    const selectedScenario = executionPlan.scenarios.find(
      (scenario) => scenario.id === executionPlan.selectedScenarioId
    );
    const activeResourceIds = new Set(selectedScenario?.resources ?? []);
    const activeResources = executionPlan.resources.filter((resource) => activeResourceIds.has(resource.id));
    const hasOciResources = activeResources.length > 0 || executionPlan.adapter === 'COMPOSE';
    const ociCapability: PreviewOciEngineCapability | undefined = hasOciResources
      ? await this.ociEngine?.probe() ?? {
          status: 'ENGINE_MISSING',
          supportsMemoryLimit: false,
          supportsCpuLimit: false,
          supportsPidsLimit: false,
          reason: 'No Docker-compatible OCI engine adapter is configured.'
        }
      : undefined;
    assertRequestedLimitsSupported(activeResources, ociCapability);
    if (executionPlan.adapter === 'COMPOSE') {
      if (!executionPlan.compose) throw new Error('Compose preview declaration is missing.');
      if (ociCapability?.status !== 'READY' || !ociCapability.identity) {
        throw new Error(ociCapability?.reason ?? 'A ready Docker engine is required to inspect Compose previews.');
      }
      if (!this.composeInspector) throw new Error('Compose preview inspection is unavailable.');
      const inspection = await this.composeInspector.inspect({
        sourceRoot: worktreeRoot,
        contextName: ociCapability.identity.contextName,
        projectName: previewComposeProjectName(input.task.id),
        plan: executionPlan.compose
      });
      executionPlan = {
        ...executionPlan,
        compose: { ...executionPlan.compose, inspection }
      };
    }
    return {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      recipePath: '.taskmonki/preview.yaml',
      recipeVersion: 1,
      recipeDigest: input.parsed.recipeDigest,
      executionDigest: ociCapability
        ? digestOciAuthority(previewExecutionDigest(executionPlan), ociCapability)
        : previewExecutionDigest(executionPlan),
      executionPlan,
      ociCapability,
      warnings: [
        'Native preview commands run as your local user and are not sandboxed.',
        'Commands may access the network; Task Monki does not enforce a no-network mode.',
        'Private input values are delivered only to the explicitly approved recipients that name them.',
        'Attached dependencies are non-owned; Task Monki never stops, resets, deletes, migrates, or reconciles them.',
        ...(executionPlan.adapter === 'COMPOSE' ? [
          'Compose previews use one serialized task-scoped project; route downtime begins when activation starts.',
          'Failed Compose activation preserves verified volumes but does not automatically restore the previous application.',
          'Task Monki never delivers private-vault values to Compose.'
        ] : []),
        ...ociWarnings(activeResources, ociCapability)
      ],
      createdAt: input.now ?? new Date().toISOString()
    };
  }

  private async resolveLocalAttachments(
    taskId: string,
    plan: PreviewExecutionPlan
  ): Promise<PreviewExecutionPlan> {
    const activeIds = new Set(activePreviewAttachmentIds(plan));
    const requirementsById = new Map(
      activePreviewLocalAttachmentRequirements(plan).map((requirement) => [
        requirement.attachmentId,
        requirement
      ])
    );
    const missing: PreviewLocalAttachmentRequirement[] = [];
    const attachments: PreviewAttachmentPlan[] = [];
    for (const attachment of plan.attachments ?? []) {
      if (attachment.target.type !== 'local' || !activeIds.has(attachment.id)) {
        attachments.push(attachment);
        continue;
      }
      const binding = await this.store?.getPreviewLocalBinding(taskId, attachment.id);
      if (!binding) {
        const requirement = requirementsById.get(attachment.id);
        if (!requirement) {
          throw new Error(`Local binding authority is unavailable for attachment ${attachment.id}.`);
        }
        missing.push(requirement);
        attachments.push(attachment);
        continue;
      }
      assertTargetMatchesAttachment(attachment, binding.target);
      attachments.push({ ...attachment, target: binding.target } as PreviewAttachmentPlan);
    }
    if (missing.length > 0) {
      throw new PreviewLocalBindingRequiredError(plan.selectedScenarioId, missing);
    }
    return { ...plan, attachments };
  }
}

export class PreviewLocalBindingRequiredError extends Error {
  constructor(
    readonly selectedScenarioId: string,
    readonly requirements: PreviewLocalAttachmentRequirement[]
  ) {
    super(`Local preview bindings are required for: ${requirements.map((item) => item.attachmentId).join(', ')}.`);
  }
}

function assertTargetMatchesAttachment(
  attachment: PreviewAttachmentPlan,
  target: import('../../shared/contracts').PreviewResolvedAttachmentTarget
): void {
  const matches =
    attachment.type === 'http'
      ? target.type === 'task-preview-route' || (target.type === 'endpoint' && 'scheme' in target)
      : attachment.type === 'tcp'
        ? target.type === 'endpoint' && !('scheme' in target) && !('database' in target)
        : attachment.type === 'postgres'
          ? target.type === 'endpoint' && 'database' in target && typeof target.database === 'string'
          : target.type === 'endpoint' && 'database' in target && typeof target.database === 'number';
  if (!matches) throw new Error(`Local binding for attachment ${attachment.id} has the wrong target type.`);
}

function assertRequestedLimitsSupported(
  resources: import('../../shared/contracts').PreviewOciResourcePlan[],
  capability: PreviewOciEngineCapability | undefined
): void {
  if (resources.length === 0 || capability?.status !== 'READY') return;
  for (const resource of resources) {
    if (resource.limits.cpus !== undefined && !capability.supportsCpuLimit) {
      throw new Error(`OCI resource ${resource.id} requests CPU enforcement that the selected engine cannot provide.`);
    }
    if (resource.limits.memoryMb !== undefined && !capability.supportsMemoryLimit) {
      throw new Error(`OCI resource ${resource.id} requests memory enforcement that the selected engine cannot provide.`);
    }
    if (resource.limits.pids !== undefined && !capability.supportsPidsLimit) {
      throw new Error(`OCI resource ${resource.id} requests PID enforcement that the selected engine cannot provide.`);
    }
  }
}

function digestOciAuthority(
  executionDigest: string,
  capability: PreviewOciEngineCapability
): string {
  return createHash('sha256').update(JSON.stringify({
    executionDigest,
    contextName: capability.contextName ?? null,
    endpointDigest: capability.identity?.endpointDigest ?? null,
    engineId: capability.identity?.engineId ?? null,
    status: capability.status
  })).digest('hex');
}

function ociWarnings(
  resources: import('../../shared/contracts').PreviewOciResourcePlan[],
  capability: PreviewOciEngineCapability | undefined
): string[] {
  if (resources.length === 0) return [];
  const warnings = [
    'Managed OCI resources run on the selected local Docker-compatible engine and may pull images from the network.'
  ];
  if (capability?.status === 'READY' && capability.identity) {
    warnings.push(
      `OCI context ${JSON.stringify(capability.identity.contextName)} targets engine ${capability.identity.engineId} (${capability.identity.operatingSystem}/${capability.identity.architecture}).`
    );
  } else {
    warnings.push(capability?.reason ?? 'The selected OCI engine is unavailable.');
  }
  for (const resource of resources) {
    if (!resource.image.includes('@sha256:')) {
      warnings.push(`OCI resource ${resource.id} uses mutable image reference ${JSON.stringify(resource.image)}.`);
    }
    if (resource.limits.diskMb !== undefined) {
      warnings.push(
        `OCI resource ${resource.id} requests ${resource.limits.diskMb} MB of data storage; local volume disk size is advisory because Docker local volumes do not provide a portable hard quota.`
      );
    }
    if (resource.limits.memoryMb === undefined || resource.limits.cpus === undefined) {
      warnings.push(`OCI resource ${resource.id} has no complete CPU and memory limit.`);
    }
  }
  return warnings;
}
