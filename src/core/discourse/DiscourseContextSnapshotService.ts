import type { AgentExecutionContext, AgentAttestedReadRoot } from '../../shared/agentRuntime';
import type { AgentExecutionSettings } from '../../shared/agent';
import {
  DISCOURSE_LIMITS,
  type AgentAssignmentSnapshot,
  type ContextSnapshotRecord,
  type ContextSnapshotSourceRecord,
  type ConversationContextRevisionRecord,
  type DiscourseContextPreview,
  type DiscourseMessageRecord
} from '../../shared/discourse';
import { assessDiscourseJobBudget } from './DiscourseBudget';
import type { DiscourseJobBudgetAssessment } from './DiscourseBudget';
import type { DiscoursePromptAssembly } from './DiscoursePromptBuilder';
import type {
  DiscourseContextResolver,
  ResolvedDiscourseContextReference
} from './DiscourseContextResolver';
import type { DiscourseWorkspace } from './DiscourseWorkspace';

const DEFAULT_MODEL_CONTEXT_TOKENS = 128_000;

export interface DiscourseReadOnlyExecutionScopeInput {
  sessionId: string;
  runtimeId: string;
  primaryCwd: string;
  readRoots: AgentAttestedReadRoot[];
  modelSettings: AgentExecutionSettings;
  clientOperationId: string;
}

export type BuildDiscourseExecutionContext = (
  input: DiscourseReadOnlyExecutionScopeInput
) => Promise<AgentExecutionContext>;

export interface PreparedDiscourseContextSnapshot {
  snapshot: ContextSnapshotRecord;
  preview: DiscourseContextPreview;
  executionContext?: AgentExecutionContext;
  prompt: string;
}

/** Resolves renderer-safe IDs into one immutable, path-free manifest plus an attested run scope. */
export class DiscourseContextSnapshotService {
  constructor(
    private readonly resolver: DiscourseContextResolver,
    private readonly workspace: DiscourseWorkspace,
    private readonly buildExecutionContext: BuildDiscourseExecutionContext,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async prepare(input: {
    conversationId: string;
    waveId: string;
    snapshotId: string;
    contextRevision: ConversationContextRevisionRecord;
    transcript: readonly DiscourseMessageRecord[];
    assignment: AgentAssignmentSnapshot;
    sessionId: string;
    clientOperationId: string;
    buildPrompt(snapshot: ContextSnapshotRecord): DiscoursePromptAssembly;
  }): Promise<PreparedDiscourseContextSnapshot> {
    const selections = input.contextRevision.references.map((reference) => ({
      entityKind: reference.entityKind,
      entityId: reference.entityId
    }));
    const pinned = input.contextRevision.references.filter(
      (reference) => reference.scope === 'PINNED'
    );
    const messageContext = input.contextRevision.references
      .filter((reference) => reference.scope === 'MESSAGE')
      .map((reference) => ({
        entityKind: reference.entityKind,
        entityId: reference.entityId
      }));
    const [resolved, preview] = await Promise.all([
      this.resolver.resolveSelections(selections),
      this.resolver.preview({ pinned, messageContext })
    ]);
    const rootByRepository = preferredRootByRepository(resolved);
    const sourceByKey = new Map(
      resolved.map((reference) => [selectionKey(reference), reference])
    );
    const sources: ContextSnapshotSourceRecord[] = preview.references.map((reference) => {
      const resolvedReference = sourceByKey.get(
        `${reference.entityKind}:${reference.entityId}`
      );
      const required = reference.accessMode !== 'METADATA_ONLY';
      return {
        contextLinkId: input.contextRevision.references.find(
          (candidate) =>
            candidate.entityKind === reference.entityKind &&
            candidate.entityId === reference.entityId
        )!.contextLinkId,
        entityKind: reference.entityKind,
        entityId: reference.entityId,
        labelSnapshot: reference.labelSnapshot,
        required,
        availability: reference.availability,
        accessMode: reference.accessMode,
        ...(reference.repositoryId ? { repositoryId: reference.repositoryId } : {}),
        ...(resolvedReference?.generation ? { generation: resolvedReference.generation } : {}),
        inspectedAt: this.now(),
        exclusionReasons: [...reference.exclusionReasons]
      };
    });
    const unavailable = sources.find(
      (source) => source.availability !== 'AVAILABLE' || source.accessMode === 'UNAVAILABLE'
    );
    const filesystemRoots = uniqueStrings(
      preview.references.flatMap((reference) => {
        if (reference.accessMode !== 'FILESYSTEM_READ') return [];
        const resolvedReference = sourceByKey.get(
          `${reference.entityKind}:${reference.entityId}`
        );
        const root = resolvedReference?.repositoryId
          ? rootByRepository.get(resolvedReference.repositoryId)
          : resolvedReference?.canonicalRoot;
        return root ? [root] : [];
      })
    );
    const scope = await this.executionScope(filesystemRoots, input.assignment);
    const executionContext = unavailable
      ? undefined
      : await this.buildExecutionContext({
          sessionId: input.sessionId,
          runtimeId: input.assignment.runtimeId,
          ...scope,
          clientOperationId: input.clientOperationId
        });
    const createdAt = this.now();
    let snapshot: ContextSnapshotRecord = unavailable
      ? {
          id: input.snapshotId,
          conversationId: input.conversationId,
          waveId: input.waveId,
          contextRevisionId: input.contextRevision.id,
          recordRevision: 1,
          status: 'BLOCKED',
          sources,
          transcriptOrdinals: input.transcript.map((message) => message.ordinal),
          attachmentIds: [],
          budget: emptyBudget(sources.length),
          exclusions: [...preview.exclusions],
          contextSchemaVersion: 1,
          promptPolicyVersion: 1,
          createdAt,
          resolvedAt: createdAt,
          error: {
            code: 'CONTEXT_UNAVAILABLE',
            message: `${unavailable.labelSnapshot} is unavailable.`,
            category: 'CONTEXT',
            retryable: true
          }
        }
      : {
          id: input.snapshotId,
          conversationId: input.conversationId,
          waveId: input.waveId,
          contextRevisionId: input.contextRevision.id,
          recordRevision: 1,
          status: sources.some((source) => source.accessMode !== 'FILESYSTEM_READ')
            ? 'PARTIAL'
            : 'READY',
          sources,
          transcriptOrdinals: input.transcript.map((message) => message.ordinal),
          attachmentIds: [],
          permissionProfileHash: executionContext!.permissionProfileHash,
          budget: emptyBudget(sources.length),
          exclusions: [...preview.exclusions],
          contextSchemaVersion: 1,
          promptPolicyVersion: 1,
          createdAt,
          resolvedAt: createdAt
        };
    const promptAssembly = input.buildPrompt(snapshot);
    let prompt = promptAssembly.prompt;
    const transcriptMeasure = measure(input.transcript.map((message) => message.body).join('\n'));
    const sourceMeasures = sources.map((source) => measure(JSON.stringify(source)));
    const manifestBytes = sourceMeasures.reduce((total, current) => total + current.bytes, 0);
    const hardBlocked =
      transcriptMeasure.bytes > DISCOURSE_LIMITS.maxRecentTranscriptBytes ||
      transcriptMeasure.estimatedTokens > DISCOURSE_LIMITS.maxRecentTranscriptTokens ||
      sourceMeasures.some(
        (source) => source.bytes > DISCOURSE_LIMITS.maxContextManifestBytesPerReference
      ) ||
      manifestBytes > DISCOURSE_LIMITS.maxContextManifestBytesPerWave;
    snapshot = { ...snapshot, budget: frozenContextBudget(promptAssembly) };
    if (hardBlocked) {
      snapshot = {
        ...snapshot,
        status: 'BLOCKED',
        permissionProfileHash: undefined,
        error: {
          code: 'CONTEXT_TOO_LARGE',
          message: 'The discourse response exceeds its bounded prompt budget.',
          category: 'CONTEXT',
          retryable: false
        }
      };
      prompt = '';
      return { snapshot, preview, prompt };
    }
    return { snapshot, preview, executionContext, prompt };
  }

  assessPrompt(
    assembly: DiscoursePromptAssembly,
    cumulativeWaveOutputBytes: number
  ): {
    budget: ContextSnapshotRecord['budget'];
    assessment: DiscourseJobBudgetAssessment;
  } {
    const assessment = assessDiscourseJobBudget({
      modelContextTokens: DEFAULT_MODEL_CONTEXT_TOKENS,
      ...assembly.budgetSections,
      cumulativeWaveOutputBytes
    });
    return {
      budget: {
        inputBytes: assessment.inputBytes,
        estimatedInputTokens: assessment.estimatedInputTokens,
        reservedOutputTokens: assessment.reservedOutputTokens,
        sourceCount: assessment.sourceCount
      },
      assessment
    };
  }

  /** Re-attests a fresh job session against the exact generations frozen by a wave. */
  async executionContextForSnapshot(input: {
    snapshot: ContextSnapshotRecord;
    assignment: AgentAssignmentSnapshot;
    sessionId: string;
    clientOperationId: string;
  }): Promise<AgentExecutionContext> {
    if (!['READY', 'PARTIAL'].includes(input.snapshot.status)) {
      throw new Error('Discourse execution requires a ready frozen context snapshot.');
    }
    const selections = input.snapshot.sources.map((source) => ({
      entityKind: source.entityKind,
      entityId: source.entityId
    }));
    const resolved = await this.resolver.resolveSelections(selections);
    const byKey = new Map(resolved.map((reference) => [selectionKey(reference), reference]));
    for (const source of input.snapshot.sources) {
      const current = byKey.get(`${source.entityKind}:${source.entityId}`);
      if (
        !current ||
        current.snapshot.availability !== source.availability ||
        (current.generation?.value ?? null) !== (source.generation?.value ?? null)
      ) {
        throw new Error('Discourse context changed before the next phase could start.');
      }
    }
    const rootByRepository = preferredRootByRepository(resolved);
    const filesystemRoots = uniqueStrings(
      input.snapshot.sources.flatMap((source) => {
        if (source.accessMode !== 'FILESYSTEM_READ') return [];
        const current = byKey.get(`${source.entityKind}:${source.entityId}`);
        const root = current?.repositoryId
          ? rootByRepository.get(current.repositoryId)
          : current?.canonicalRoot;
        return root ? [root] : [];
      })
    );
    const scope = await this.executionScope(filesystemRoots, input.assignment);
    const executionContext = await this.buildExecutionContext({
      sessionId: input.sessionId,
      runtimeId: input.assignment.runtimeId,
      ...scope,
      clientOperationId: input.clientOperationId
    });
    if (executionContext.permissionProfileHash !== input.snapshot.permissionProfileHash) {
      throw new Error('Discourse read-only permission scope changed after context freezing.');
    }
    return executionContext;
  }

  async freshness(snapshot: ContextSnapshotRecord): Promise<'FRESH' | 'CHANGED_DURING_JOB'> {
    const selections = snapshot.sources.map((source) => ({
      entityKind: source.entityKind,
      entityId: source.entityId
    }));
    const current = await this.resolver.resolveSelections(selections).catch(() => []);
    if (current.length !== snapshot.sources.length) return 'CHANGED_DURING_JOB';
    const byKey = new Map(current.map((reference) => [selectionKey(reference), reference]));
    return snapshot.sources.every((source) => {
      const next = byKey.get(`${source.entityKind}:${source.entityId}`);
      return Boolean(
        next &&
        next.snapshot.availability === source.availability &&
        (next.generation?.value ?? null) === (source.generation?.value ?? null)
      );
    }) ? 'FRESH' : 'CHANGED_DURING_JOB';
  }

  private async executionScope(
    filesystemRoots: readonly string[],
    assignment: AgentAssignmentSnapshot
  ): Promise<{
    primaryCwd: string;
    readRoots: AgentAttestedReadRoot[];
    modelSettings: AgentExecutionSettings;
  }> {
    const primaryCwd = filesystemRoots[0] ?? await this.workspace.prepareEmptyReadOnlyWorkspace();
    const readRoots: AgentAttestedReadRoot[] = filesystemRoots.length > 0
      ? filesystemRoots.map((canonicalPath) => ({
          canonicalPath,
          kind: 'REPOSITORY' as const
        }))
      : [{ canonicalPath: primaryCwd, kind: 'EMPTY_MANAGED' as const }];
    return {
      primaryCwd,
      readRoots,
      modelSettings: discourseExecutionSettings(assignment)
    };
  }
}

export function discourseExecutionSettings(
  assignment: AgentAssignmentSnapshot
): AgentExecutionSettings {
  return {
    model: assignment.model,
    // Runtime catalogs use the runtime id as the durable identity when a
    // model does not expose a provider dimension. Passing that fallback back
    // to the runtime would incorrectly turn `codex` into an explicit App
    // Server provider name.
    ...(assignment.modelProvider !== assignment.runtimeId
      ? { modelProvider: assignment.modelProvider }
      : {}),
    ...(assignment.reasoningEffort
      ? { reasoningEffort: assignment.reasoningEffort }
      : {}),
    ...(assignment.serviceTier
      ? { serviceTier: assignment.serviceTier }
      : {}),
    sandbox: 'READ_ONLY',
    networkAccess: false,
    approvalPolicy: 'NEVER',
    approvalsReviewer: 'user'
  };
}

function preferredRootByRepository(
  resolved: readonly ResolvedDiscourseContextReference[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (const reference of resolved) {
    if (!reference.repositoryId || !reference.canonicalRoot) continue;
    if (!result.has(reference.repositoryId) || reference.snapshot.entityKind === 'TASK') {
      result.set(reference.repositoryId, reference.canonicalRoot);
    }
  }
  return result;
}

function selectionKey(reference: ResolvedDiscourseContextReference): string {
  return `${reference.snapshot.entityKind}:${reference.snapshot.entityId}`;
}

function measure(value: string): { bytes: number; estimatedTokens: number } {
  const bytes = Buffer.byteLength(value, 'utf8');
  return { bytes, estimatedTokens: Math.ceil(bytes / 4) };
}

function emptyBudget(sourceCount: number) {
  return {
    inputBytes: 0,
    estimatedInputTokens: 0,
    reservedOutputTokens: DISCOURSE_LIMITS.defaultReservedOutputTokens,
    sourceCount
  };
}

function frozenContextBudget(
  assembly: DiscoursePromptAssembly
): ContextSnapshotRecord['budget'] {
  const measures = [
    ...assembly.budgetSections.contextReferences,
    assembly.budgetSections.transcript,
    assembly.budgetSections.summary
  ];
  return {
    inputBytes: measures.reduce((total, current) => total + current.bytes, 0),
    estimatedInputTokens: measures.reduce(
      (total, current) => total + current.estimatedTokens,
      0
    ),
    reservedOutputTokens: DISCOURSE_LIMITS.defaultReservedOutputTokens,
    sourceCount: assembly.budgetSections.contextReferences.length
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
