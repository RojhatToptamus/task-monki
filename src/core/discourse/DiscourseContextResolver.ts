import crypto from 'node:crypto';
import type { FileTaskStore } from '../storage/FileTaskStore';
import type { RepositoryRegistry, ResolvedRepository } from '../repository/RepositoryRegistry';
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
import type { Task, TaskSnapshot } from '../../shared/contracts';
import type { RepositoryCatalogSnapshot } from '../../shared/repositories';
import { inspectGitWorkingTreeFingerprint } from '../git/GitSnapshotService';

const PREVIEW_TTL_MS = 2 * 60 * 1_000;

export interface ResolvedDiscourseContextReference {
  snapshot: DiscourseContextSelectionSnapshot;
  preview: Omit<DiscourseContextPreviewReference, 'scope'>;
  canonicalRoot?: string;
  repositoryId?: string;
  generation?: ContextGenerationFingerprint;
}

/**
 * Core-owned context authority. Renderer labels and paths are never accepted;
 * every selection is resolved from durable task/repository IDs on each use.
 */
export class DiscourseContextResolver {
  constructor(
    private readonly taskStore: FileTaskStore,
    private readonly repositories: RepositoryRegistry,
    private readonly now: () => Date = () => new Date()
  ) {}

  async catalogEntries(): Promise<{
    tasks: DiscourseMentionTaskEntry[];
    repositories: DiscourseMentionRepositoryEntry[];
  }> {
    const snapshot = await this.taskStore.snapshot();
    const catalog = await this.repositories.catalog({
      selectedRepositoryId: null,
      tasks: snapshot.tasks
    });
    const repositoryById = new Map(catalog.repositories.map((repository) => [repository.id, repository]));
    const taskRepositoryIds = new Map(
      catalog.taskAssociations.map((association) => [association.taskId, association.repositoryId])
    );
    return {
      tasks: snapshot.tasks
        .map((task): DiscourseMentionTaskEntry => {
          const repositoryId = taskRepositoryIds.get(task.id);
          const repository = repositoryId ? repositoryById.get(repositoryId) : undefined;
          return {
            id: task.id,
            title: task.title,
            ...(repositoryId ? { repositoryId } : {}),
            repositoryName: repository?.displayName ?? 'Unknown repository',
            workflowPhase: task.workflowPhase,
            availability: repository?.availability === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
            archived: task.workflowPhase === 'ARCHIVED'
          };
        })
        .sort((left, right) => right.id.localeCompare(left.id)),
      repositories: catalog.repositories
        .map((repository): DiscourseMentionRepositoryEntry => ({
          id: repository.id,
          displayName: repository.displayName,
          displayPath: repository.displayPath,
          taskCount: repository.taskCount,
          availability: repository.availability === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
          accessMode: repository.availability === 'AVAILABLE' ? 'FILESYSTEM_READ' : 'UNAVAILABLE',
          ...(repository.unavailableReason
            ? { unavailableReason: repository.unavailableReason }
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
    const [snapshot, repositoryFile] = await Promise.all([
      this.taskStore.snapshot(),
      this.repositories.snapshot()
    ]);
    const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const repositories = new Map(
      repositoryFile.repositories
        .filter((repository) => !repository.removedAt)
        .map((repository) => [repository.id, repository])
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
        const repository = await this.repositories.resolveRecordedPath(task.repositoryPath);
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
      let resolvedRepository: ResolvedRepository | undefined;
      if (repository.availability === 'AVAILABLE') {
        try {
          resolvedRepository = await this.repositories.resolve(repository.id);
        } catch {
          resolvedRepository = undefined;
        }
      }
      resolved.push({
        snapshot: {
          entityKind: 'REPOSITORY',
          entityId: repository.id,
          labelSnapshot: repository.displayName,
          availability: resolvedRepository ? 'AVAILABLE' : 'UNAVAILABLE'
        },
        preview: {
          entityKind: 'REPOSITORY',
          entityId: repository.id,
          labelSnapshot: repository.displayName,
          availability: resolvedRepository ? 'AVAILABLE' : 'UNAVAILABLE',
          repositoryId: repository.id,
          repositoryName: repository.displayName,
          accessMode: resolvedRepository ? 'FILESYSTEM_READ' : 'UNAVAILABLE',
          exclusionReasons: resolvedRepository ? [] : ['Repository is unavailable.']
        },
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
    const pinnedKeys = new Set(
      input.pinned.map((reference) => `${reference.entityKind}:${reference.entityId}`)
    );
    const rootByRepository = new Map<string, string>();
    for (const reference of resolved) {
      if (!reference.repositoryId || !reference.canonicalRoot) continue;
      const existing = rootByRepository.get(reference.repositoryId);
      if (!existing || reference.snapshot.entityKind === 'TASK') {
        rootByRepository.set(reference.repositoryId, reference.canonicalRoot);
      }
    }
    const rootOrder = uniqueStrings(
      resolved.flatMap((reference) =>
        reference.repositoryId && rootByRepository.has(reference.repositoryId)
          ? [rootByRepository.get(reference.repositoryId)!]
          : reference.canonicalRoot
            ? [reference.canonicalRoot]
            : []
      )
    );
    const allowedRoots = new Set(rootOrder.slice(0, DISCOURSE_LIMITS.maxFilesystemRootsPerWave));
    const exclusions: string[] = [];
    const references = resolved.map((reference): DiscourseContextPreviewReference => {
      const effectiveRoot = reference.repositoryId
        ? rootByRepository.get(reference.repositoryId)
        : reference.canonicalRoot;
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
          (candidate) => candidate.id === task.currentWorktreeId && candidate.status === 'PRESENT'
        )
      : undefined;
    const root = worktree?.worktreePath ?? repository?.canonicalRealPath;
    const repositoryId = repository?.repositoryId;
    const repositoryName = repository?.record.displayName ?? 'Unknown repository';
    const availability = root ? 'AVAILABLE' as const : 'UNAVAILABLE' as const;
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
        accessMode: root ? 'FILESYSTEM_READ' : 'UNAVAILABLE',
        exclusionReasons: root ? [] : ['Task repository or worktree is unavailable.']
      },
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
    `objectFormat:${repository.record.identity.objectFormat}`,
    `liveGitDirty:${liveGitGeneration}`,
    ...repository.record.identity.anchorCommits.map((commit) => `anchor:${commit}`)
  ];
  return { algorithm: 'sha256', value: sha256(components.join('\n')), components };
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
