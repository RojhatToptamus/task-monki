import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqliteTaskStore } from '../storage/SqliteTaskStore';
import {
  DISCOURSE_LIMITS,
  type ContextGenerationFingerprint,
  type ConversationContextReferenceSnapshot,
  type DiscourseContextPreview,
  type DiscourseContextPreviewReference,
  type DiscourseContextSelection,
  type DiscourseContextSelectionSnapshot,
  type DiscourseMentionRepositoryEntry,
  type DiscourseMentionTaskEntry
} from '../../shared/discourse';
import type { Repository, Task, TaskSnapshot } from '../../shared/contracts';
import { inspectGitWorkingTreeFingerprint } from '../git/GitSnapshotService';

const PREVIEW_TTL_MS = 2 * 60 * 1_000;

export interface ResolvedDiscourseContextReference {
  snapshot: DiscourseContextSelectionSnapshot;
  preview: Omit<DiscourseContextPreviewReference, 'scope'>;
  canonicalRoot?: string;
  repositoryId?: string;
  generation?: ContextGenerationFingerprint;
  recordedContext?: string;
}

interface ResolvedRepository {
  repositoryId: string;
  record: Repository;
  canonicalRealPath: string;
}

/**
 * Core-owned context authority. Renderer labels and paths are never accepted;
 * every selection is resolved from durable task/repository IDs on each use.
 */
export class DiscourseContextResolver {
  constructor(
    private readonly taskStore: SqliteTaskStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async catalogEntries(): Promise<{
    tasks: DiscourseMentionTaskEntry[];
    repositories: DiscourseMentionRepositoryEntry[];
  }> {
    const snapshot = await this.taskStore.snapshot();
    const repositoryById = new Map(
      snapshot.repositories.map((repository) => [repository.id, repository])
    );
    const taskCounts = new Map<string, number>();
    for (const task of snapshot.tasks) {
      taskCounts.set(task.repositoryId, (taskCounts.get(task.repositoryId) ?? 0) + 1);
    }
    return {
      tasks: snapshot.tasks
        .map((task): DiscourseMentionTaskEntry => {
          const repository = repositoryById.get(task.repositoryId);
          return {
            id: task.id,
            title: task.title,
            repositoryId: task.repositoryId,
            repositoryName: repository?.name ?? 'Unknown repository',
            workflowPhase: task.workflowPhase,
            availability: 'AVAILABLE',
            archived: task.workflowPhase === 'ARCHIVED'
          };
        })
        .sort((left, right) => right.id.localeCompare(left.id)),
      repositories: snapshot.repositories
        .map((repository): DiscourseMentionRepositoryEntry => ({
          id: repository.id,
          displayName: repository.name,
          displayPath: repository.path,
          taskCount: taskCounts.get(repository.id) ?? 0,
          availability: repository.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
          accessMode: repository.status === 'AVAILABLE' ? 'FILESYSTEM_READ' : 'UNAVAILABLE',
          ...(repository.error
            ? { unavailableReason: repository.error }
            : {})
        }))
        .sort((left, right) => compareCodeUnits(left.displayName, right.displayName))
    };
  }

  async resolveSelections(
    selections: readonly DiscourseContextSelection[]
  ): Promise<ResolvedDiscourseContextReference[]> {
    if (selections.length > DISCOURSE_LIMITS.maxContextReferencesPerWave) {
      throw new Error(
        `Discourse context is limited to ${DISCOURSE_LIMITS.maxContextReferencesPerWave} references.`
      );
    }
    const unique = dedupeSelections(selections);
    const snapshot = await this.taskStore.snapshot();
    const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const repositories = new Map(
      snapshot.repositories.map((repository) => [repository.id, repository])
    );
    const liveGitGenerations = new Map<string, Promise<string>>();
    const liveGitGeneration = (canonicalRoot: string): Promise<string> => {
      const existing = liveGitGenerations.get(canonicalRoot);
      if (existing) return existing;
      const inspection = inspectGitWorkingTreeFingerprint(canonicalRoot).catch((cause) => {
        throw new Error(
          'Could not inspect live Git working-tree state for discourse context.',
          { cause }
        );
      });
      liveGitGenerations.set(canonicalRoot, inspection);
      return inspection;
    };
    const resolved: ResolvedDiscourseContextReference[] = [];
    for (const selection of unique) {
      if (selection.entityKind === 'TASK') {
        const task = tasks.get(selection.entityId);
        if (!task) throw new Error(`Unknown discourse task context id: ${selection.entityId}`);
        const repository = await resolveRepository(
          repositories.get(task.repositoryId)
        );
        const taskContext = await this.resolveTask(
          task,
          snapshot,
          repository,
          liveGitGeneration
        );
        resolved.push(taskContext);
        continue;
      }
      if (selection.entityKind !== 'REPOSITORY') {
        throw new Error('Discourse context entity kind is invalid.');
      }
      const repository = repositories.get(selection.entityId);
      if (!repository) {
        throw new Error(`Unknown discourse repository context id: ${selection.entityId}`);
      }
      const resolvedRepository = await resolveRepository(repository);
      resolved.push({
        snapshot: {
          entityKind: 'REPOSITORY',
          entityId: repository.id,
          labelSnapshot: repository.name,
          availability: resolvedRepository ? 'AVAILABLE' : 'UNAVAILABLE'
        },
        preview: {
          entityKind: 'REPOSITORY',
          entityId: repository.id,
          labelSnapshot: repository.name,
          availability: resolvedRepository ? 'AVAILABLE' : 'UNAVAILABLE',
          repositoryId: repository.id,
          repositoryName: repository.name,
          accessMode: resolvedRepository ? 'FILESYSTEM_READ' : 'UNAVAILABLE',
          ...(resolvedRepository ? { readScope: 'REPOSITORY' as const } : {}),
          exclusionReasons: resolvedRepository ? [] : ['Repository is unavailable.']
        },
        recordedContext: JSON.stringify({
          repository: { id: repository.id, name: repository.name, branch: repository.branch,
            headSha: repository.headSha, status: repository.status, checkedAt: repository.checkedAt },
          scope: 'Selected repository only. Task descriptions, other worktrees, attachments, and provider transcripts are not included.'
        }),
        ...(resolvedRepository
          ? {
              canonicalRoot: resolvedRepository.canonicalRealPath,
              repositoryId: repository.id,
              generation: repositoryGeneration(
                resolvedRepository,
                await liveGitGeneration(resolvedRepository.canonicalRealPath)
              )
            }
          : {})
      });
    }
    return resolved;
  }

  async preview(input: {
    pinned: readonly ConversationContextReferenceSnapshot[];
    messageContext: readonly DiscourseContextSelection[];
  }): Promise<DiscourseContextPreview> {
    const combined = dedupeSelections([
      ...input.pinned.map((reference) => ({
        entityKind: reference.entityKind,
        entityId: reference.entityId
      })),
      ...input.messageContext
    ]);
    const resolved = await this.resolveSelections(combined);
    return this.previewResolved(resolved, input.pinned);
  }

  previewResolved(
    resolved: readonly ResolvedDiscourseContextReference[],
    pinned: readonly ConversationContextReferenceSnapshot[]
  ): DiscourseContextPreview {
    const pinnedKeys = new Set(
      pinned.map((reference) => `${reference.entityKind}:${reference.entityId}`)
    );
    const rootOrder = uniqueStrings(
      resolved.flatMap((reference) =>
        reference.canonicalRoot ? [reference.canonicalRoot] : []
      )
    );
    const allowedRoots = new Set(rootOrder.slice(0, DISCOURSE_LIMITS.maxFilesystemRootsPerWave));
    const exclusions: string[] = [];
    const references = resolved.map((reference): DiscourseContextPreviewReference => {
      const effectiveRoot = reference.canonicalRoot;
      const overflow = Boolean(effectiveRoot && !allowedRoots.has(effectiveRoot));
      if (overflow) {
        exclusions.push(
          `${reference.snapshot.labelSnapshot} is metadata-only because the response exceeds the ${DISCOURSE_LIMITS.maxFilesystemRootsPerWave}-repository read limit.`
        );
      }
      return {
        ...reference.preview,
        scope: pinnedKeys.has(`${reference.snapshot.entityKind}:${reference.snapshot.entityId}`)
          ? 'PINNED'
          : 'MESSAGE',
        accessMode: overflow ? 'METADATA_ONLY' : reference.preview.accessMode,
        readScope: overflow ? undefined : reference.preview.readScope,
        exclusionReasons: overflow
          ? [...reference.preview.exclusionReasons, 'Filesystem root limit reached.']
          : reference.preview.exclusionReasons
      };
    });
    const createdAt = this.now();
    const descriptor = {
      version: 1,
      references: references.map((reference) => ({
        entityKind: reference.entityKind,
        entityId: reference.entityId,
        scope: reference.scope,
        availability: reference.availability,
        accessMode: reference.accessMode
      })),
      generations: resolved.map((reference) => reference.generation?.value ?? null),
      recordedContent: resolved.map((reference) => reference.recordedContext ?? null),
      roots: [...allowedRoots].map((root) => sha256(root)),
      exclusions
    };
    return {
      fingerprint: sha256(stableStringify(descriptor)),
      expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString(),
      references,
      deduplicatedRepositoryIds: uniqueStrings(
        resolved.flatMap((reference) => reference.repositoryId ? [reference.repositoryId] : [])
      ),
      filesystemRootCount: allowedRoots.size,
      metadataOnly: references.some((reference) => reference.accessMode !== 'FILESYSTEM_READ'),
      policy: {
        filesystem: 'READ_ONLY',
        writes: false,
        network: false,
        externalTools: false,
        approvals: 'NEVER'
      },
      exclusions
    };
  }

  private async resolveTask(
    task: Task,
    snapshot: TaskSnapshot,
    repository: ResolvedRepository | undefined,
    liveGitGeneration: (canonicalRoot: string) => Promise<string>
  ): Promise<ResolvedDiscourseContextReference> {
    const worktree = task.currentWorktreeId
      ? snapshot.worktrees.find(
          (candidate) => candidate.id === task.currentWorktreeId && candidate.taskId === task.id &&
            candidate.repositoryId === task.repositoryId
        )
      : undefined;
    // An unavailable task worktree must not silently grant the repository checkout instead.
    const root = task.currentWorktreeId
      ? worktree?.status === 'PRESENT'
        ? await fs.realpath(worktree.worktreePath).catch(() => undefined)
        : undefined
      : repository?.canonicalRealPath;
    const repositoryId = task.repositoryId;
    const repositoryName = repository?.record.name ?? 'Unknown repository';
    const git = worktree ? snapshot.gitSnapshots
      .filter((candidate) => candidate.worktreeId === worktree.id)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0] : undefined;
    const recordedContext = JSON.stringify({
      task: { id: task.id, title: task.title, description: task.prompt,
        phase: task.workflowPhase, resolution: task.resolution, updatedAt: task.updatedAt },
      repository: { id: repositoryId, name: repositoryName },
      worktree: worktree ? { id: worktree.id, branch: worktree.branchName, status: worktree.status } : null,
      recordedGit: git ? { id: git.id, headSha: git.headSha, branch: git.branch,
        status: git.status, diffStat: git.diffStat, capturedAt: git.capturedAt } : null,
      recordedDelivery: { pullRequest: task.projection.githubPullRequest,
        pullRequestNumber: task.projection.githubPullRequestNumber,
        pullRequestUrl: task.projection.githubPullRequestUrl, ciChecks: task.projection.ciChecks,
        reviews: task.projection.reviews, merge: task.projection.merge },
      agentReview: task.projection.agentReview ?? null,
      providerReportedRunStatus: task.projection.agentRun,
      limitations: [
        'Recorded observations are not a fresh test or review. Agent review content is advice, not verified correctness.',
        'Attachments, local test output, provider transcripts, and other tasks are not included automatically.'
      ]
    });
    const availability = 'AVAILABLE' as const;
    return {
      snapshot: {
        entityKind: 'TASK',
        entityId: task.id,
        labelSnapshot: task.title,
        availability
      },
      preview: {
        entityKind: 'TASK',
        entityId: task.id,
        labelSnapshot: task.title,
        availability,
        ...(repositoryId ? { repositoryId } : {}),
        repositoryName,
        taskTitle: task.title,
        taskWorkflowPhase: task.workflowPhase,
        accessMode: root ? 'FILESYSTEM_READ' : 'METADATA_ONLY',
        ...(root ? { readScope: worktree ? 'TASK_WORKTREE' as const : 'REPOSITORY' as const } : {}),
        exclusionReasons: root ? [] : ['Task information is available, but its repository or worktree is unavailable. No files are granted.']
      },
      recordedContext,
      ...(root ? { canonicalRoot: root } : {}),
      ...(repositoryId ? { repositoryId } : {}),
      generation: taskGeneration(
        task,
        snapshot,
        repository,
        root ? await liveGitGeneration(root) : undefined
      )
    };
  }
}

function taskGeneration(
  task: Task,
  snapshot: TaskSnapshot,
  repository: ResolvedRepository | undefined,
  liveGitGeneration: string | undefined
): ContextGenerationFingerprint {
  const worktree = task.currentWorktreeId
    ? snapshot.worktrees.find((candidate) => candidate.id === task.currentWorktreeId)
    : undefined;
  const git = worktree
    ? snapshot.gitSnapshots
        .filter((candidate) => candidate.worktreeId === worktree.id)
        .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0]
    : undefined;
  const components = [
    `task:${task.id}`,
    `taskUpdated:${task.updatedAt}`,
    `phase:${task.workflowPhase}`,
    `worktree:${worktree?.id ?? 'none'}`,
    `storedGitHead:${git?.headSha ?? 'unknown'}`,
    `storedGitDirty:${git?.dirtyFingerprint ?? 'unknown'}`,
    `liveGitDirty:${liveGitGeneration ?? 'unavailable'}`,
    `repository:${repository?.repositoryId ?? 'unavailable'}`
  ];
  return { algorithm: 'sha256', value: sha256(components.join('\n')), components };
}

function repositoryGeneration(
  repository: ResolvedRepository,
  liveGitGeneration: string
): ContextGenerationFingerprint {
  const components = [
    `repository:${repository.repositoryId}`,
    `updated:${repository.record.updatedAt}`,
    `head:${repository.record.headSha ?? 'unknown'}`,
    `status:${repository.record.status}`,
    `liveGitDirty:${liveGitGeneration}`,
    ...repository.record.remotes.map(
      (remote) => `remote:${remote.name}:${remote.url}:${remote.direction}`
    )
  ];
  return { algorithm: 'sha256', value: sha256(components.join('\n')), components };
}

async function resolveRepository(
  repository: Repository | undefined
): Promise<ResolvedRepository | undefined> {
  if (!repository || repository.status !== 'AVAILABLE') return undefined;
  try {
    const canonicalRealPath = await fs.realpath(repository.path);
    if (!path.isAbsolute(canonicalRealPath)) return undefined;
    return {
      repositoryId: repository.id,
      record: repository,
      canonicalRealPath: path.resolve(canonicalRealPath)
    };
  } catch {
    return undefined;
  }
}

function dedupeSelections(
  selections: readonly DiscourseContextSelection[]
): DiscourseContextSelection[] {
  const seen = new Set<string>();
  return selections.flatMap((selection) => {
    if (!selection || !selection.entityId || !['TASK', 'REPOSITORY'].includes(selection.entityKind)) {
      throw new Error('Discourse context selection is invalid.');
    }
    const key = `${selection.entityKind}:${selection.entityId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ entityKind: selection.entityKind, entityId: selection.entityId }];
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
