import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PreviewPlanRecord, WorktreeRecord } from '../../shared/contracts';
import type { Task, TaskIteration } from '../../shared/contracts';
import type { ParsedPreviewRecipe } from './PreviewRecipeLoader';
import { canonicalProspectivePath, isPathWithin } from './PreviewPaths';

export interface ResolvePreviewPlanInput {
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
  parsed: ParsedPreviewRecipe;
  now?: string;
}

export class PreviewPlanResolver {
  async resolve(input: ResolvePreviewPlanInput): Promise<PreviewPlanRecord> {
    const worktreeRoot = await canonicalProspectivePath(input.worktree.worktreePath);
    for (const node of [
      ...input.parsed.executionPlan.jobs,
      ...input.parsed.executionPlan.services
    ]) {
      const cwd = await canonicalProspectivePath(path.join(worktreeRoot, node.cwd));
      if (!isPathWithin(worktreeRoot, cwd)) {
        throw new Error(`Preview node ${node.id} cwd escapes the task worktree.`);
      }
    }

    return {
      id: randomUUID(),
      taskId: input.task.id,
      iterationId: input.iteration.id,
      worktreeId: input.worktree.id,
      recipePath: '.taskmonki/preview.yaml',
      recipeVersion: 1,
      recipeDigest: input.parsed.recipeDigest,
      executionDigest: input.parsed.executionDigest,
      executionPlan: input.parsed.executionPlan,
      warnings: [
        'Native preview commands run as your local user and are not sandboxed.',
        'Commands may access the network; Task Monki does not enforce a no-network mode in Phase 1.',
        'Environment values in this recipe are repository-visible literals; secret inputs are unsupported.'
      ],
      createdAt: input.now ?? new Date().toISOString()
    };
  }
}
