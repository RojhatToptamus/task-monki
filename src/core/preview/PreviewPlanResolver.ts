import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  PreviewOciEngineCapability,
  PreviewPlanRecord,
  WorktreeRecord
} from '../../shared/contracts';
import type { Task, TaskIteration } from '../../shared/contracts';
import type { ParsedPreviewRecipe } from './PreviewRecipeLoader';
import { canonicalProspectivePath, isPathWithin } from './PreviewPaths';
import { OciEngineAdapter } from './runtime/OciEngineAdapter';

export interface ResolvePreviewPlanInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  parsed: ParsedPreviewRecipe;
  now?: string;
}

export class PreviewPlanResolver {
  constructor(private readonly ociEngine?: OciEngineAdapter) {}

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

    const hasOciResources = input.parsed.executionPlan.resources.length > 0;
    const ociCapability: PreviewOciEngineCapability | undefined = hasOciResources
      ? await this.ociEngine?.probe() ?? {
          status: 'ENGINE_MISSING',
          supportsMemoryLimit: false,
          supportsCpuLimit: false,
          supportsPidsLimit: false,
          reason: 'No Docker-compatible OCI engine adapter is configured.'
        }
      : undefined;
    return {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      recipePath: '.taskmonki/preview.yaml',
      recipeVersion: 1,
      recipeDigest: input.parsed.recipeDigest,
      executionDigest: hasOciResources
        ? digestOciAuthority(input.parsed.executionDigest, ociCapability!)
        : input.parsed.executionDigest,
      executionPlan: input.parsed.executionPlan,
      ociCapability,
      warnings: [
        'Native preview commands run as your local user and are not sandboxed.',
        'Commands may access the network; Task Monki does not enforce a no-network mode.',
        'Environment values are repository-visible literals or generated non-secret origins; secret inputs are unsupported.',
        ...ociWarnings(input.parsed.executionPlan.resources, ociCapability)
      ],
      createdAt: input.now ?? new Date().toISOString()
    };
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
