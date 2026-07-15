import crypto from 'node:crypto';
import path from 'node:path';
import {
  AGENT_RUNTIME_LIMITS,
  agentOwnerScopeKey,
  agentRunScopeBelongsToOwner,
  type AgentExecutionContext,
  type AgentOwnerScope,
  type AgentRunScope,
  type AgentSessionAccessEpoch
} from '../../shared/agentRuntime';

const SHA256 = /^[a-f0-9]{64}$/u;

export function createAgentSessionAccessEpoch(input: {
  owner: AgentOwnerScope;
  sessionId: string;
  epoch: number;
  providerId: string;
  model: string;
  executionContext: AgentExecutionContext;
  createdAt?: string;
}): AgentSessionAccessEpoch {
  assertAgentOwnerScope(input.owner);
  assertBoundedIdentifier(input.sessionId, 'session id');
  assertBoundedIdentifier(input.providerId, 'provider id');
  assertBoundedIdentifier(input.model, 'model');
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new Error('Agent session access epoch must be a positive integer.');
  }
  const descriptor = normalizedExecutionDescriptor({
    owner: input.owner,
    providerId: input.providerId,
    model: input.model,
    executionContext: input.executionContext
  });
  return {
    owner: clone(input.owner),
    sessionId: input.sessionId,
    epoch: input.epoch,
    executionProfileHash: crypto
      .createHash('sha256')
      .update(stableStringify(descriptor))
      .digest('hex'),
    primaryCwd: descriptor.primaryCwd,
    providerId: input.providerId,
    model: input.model,
    createdAt: requireTimestamp(input.createdAt ?? new Date().toISOString())
  };
}

export function assertAgentOwnerScope(scope: AgentOwnerScope): void {
  if (scope.kind === 'TASK') {
    assertBoundedIdentifier(scope.taskId, 'task owner id');
    return;
  }
  assertBoundedIdentifier(scope.conversationId, 'conversation owner id');
  assertBoundedIdentifier(scope.stableParticipantId, 'participant owner id');
}

export function assertAgentRunScope(
  scope: AgentRunScope,
  owner: AgentOwnerScope
): void {
  assertAgentOwnerScope(owner);
  if (!agentRunScopeBelongsToOwner(scope, owner)) {
    throw new Error('Agent run scope does not belong to its durable owner.');
  }
  if (scope.kind === 'TASK') {
    assertBoundedIdentifier(scope.taskId, 'task run id');
    assertBoundedIdentifier(scope.iterationId, 'task iteration id');
    assertBoundedIdentifier(scope.worktreeId, 'task worktree id');
    return;
  }
  assertBoundedIdentifier(scope.conversationId, 'discourse conversation id');
  assertBoundedIdentifier(scope.waveId, 'discourse wave id');
  assertBoundedIdentifier(scope.jobId, 'discourse job id');
  assertBoundedIdentifier(scope.contextSnapshotId, 'discourse context snapshot id');
  assertBoundedIdentifier(scope.attemptId, 'discourse attempt id');
}

export function assertAccessEpochMatches(input: {
  epoch: AgentSessionAccessEpoch;
  owner: AgentOwnerScope;
  sessionId: string;
}): void {
  assertAgentOwnerScope(input.epoch.owner);
  if (
    agentOwnerScopeKey(input.epoch.owner) !== agentOwnerScopeKey(input.owner) ||
    input.epoch.sessionId !== input.sessionId ||
    !Number.isSafeInteger(input.epoch.epoch) ||
    input.epoch.epoch < 1 ||
    !SHA256.test(input.epoch.executionProfileHash) ||
    !path.isAbsolute(input.epoch.primaryCwd) ||
    !input.epoch.providerId ||
    !input.epoch.model
  ) {
    throw new Error('Agent session access epoch does not match its session owner.');
  }
  requireTimestamp(input.epoch.createdAt);
}

export function assertDiscourseExecutionContext(context: AgentExecutionContext): void {
  normalizedExecutionDescriptor({
    owner: {
      kind: 'DISCOURSE',
      conversationId: 'validation-conversation',
      stableParticipantId: 'validation-participant'
    },
    providerId: 'validation-provider',
    model: 'validation-model',
    executionContext: context
  });
  if (context.attestation.status !== 'ATTESTED') {
    throw new Error('Discourse execution requires a provider-attested access boundary.');
  }
  if (
    context.externalTools.network ||
    context.externalTools.webSearch !== 'disabled' ||
    context.externalTools.mcpServers ||
    context.externalTools.apps ||
    context.externalTools.dynamicTools
  ) {
    throw new Error('Discourse execution requires network and external tools to be disabled.');
  }
  if (
    context.modelSettings.sandbox !== 'READ_ONLY' ||
    context.modelSettings.approvalPolicy !== 'NEVER'
  ) {
    throw new Error('Discourse execution requires read-only access and no approvals.');
  }
}

function normalizedExecutionDescriptor(input: {
  owner: AgentOwnerScope;
  providerId: string;
  model: string;
  executionContext: AgentExecutionContext;
}) {
  const context = input.executionContext;
  if (
    context.attestation.status !== 'ATTESTED' &&
    (context.attestation.status === 'LEGACY_UNATTESTED'
      ? !context.attestation.reason.trim()
      : context.attestation.status === 'INHERITED_UNATTESTED'
        ? !context.attestation.parentSessionId.trim() ||
          !context.attestation.reason.trim()
        : true)
  ) {
    throw new Error('Agent execution context attestation metadata is invalid.');
  }
  if (!path.isAbsolute(context.primaryCwd)) {
    throw new Error('Agent execution primary cwd must be absolute.');
  }
  if (Buffer.byteLength(context.primaryCwd, 'utf8') > AGENT_RUNTIME_LIMITS.maxPrimaryCwdBytes) {
    throw new Error('Agent execution primary cwd exceeds its safety limit.');
  }
  if (
    context.readRoots.length < 1 ||
    context.readRoots.length > AGENT_RUNTIME_LIMITS.maxExecutionRoots
  ) {
    throw new Error('Agent execution root count exceeds its safety limit.');
  }
  const readRoots = context.readRoots
    .map((root) => {
      if (!path.isAbsolute(root.canonicalPath)) {
        throw new Error('Agent execution roots must be absolute.');
      }
      return { ...root, canonicalPath: path.resolve(root.canonicalPath) };
    })
    .sort((left, right) => compareCodeUnits(left.canonicalPath, right.canonicalPath));
  if (new Set(readRoots.map((root) => root.canonicalPath)).size !== readRoots.length) {
    throw new Error('Agent execution roots must be unique.');
  }
  for (let index = 0; index < readRoots.length; index += 1) {
    for (let other = index + 1; other < readRoots.length; other += 1) {
      const relative = path.relative(
        readRoots[index]!.canonicalPath,
        readRoots[other]!.canonicalPath
      );
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('Agent execution roots must not overlap.');
      }
    }
  }
  if (!readRoots.some((root) => samePath(root.canonicalPath, context.primaryCwd))) {
    throw new Error('Agent execution roots must include the primary cwd.');
  }
  if (context.managedAttachments.length > AGENT_RUNTIME_LIMITS.maxManagedAttachments) {
    throw new Error('Agent execution attachments exceed their safety limit.');
  }
  const managedAttachments = context.managedAttachments
    .map((attachment) => {
      assertBoundedIdentifier(attachment.attachmentId, 'managed attachment id');
      if (!SHA256.test(attachment.contentSha256)) {
        throw new Error('Managed attachment access requires a SHA-256 digest.');
      }
      if (!Number.isSafeInteger(attachment.byteCount) || attachment.byteCount < 0) {
        throw new Error('Managed attachment access requires a valid byte count.');
      }
      return { ...attachment };
    })
    .sort((left, right) => compareCodeUnits(left.attachmentId, right.attachmentId));
  if (
    new Set(managedAttachments.map((attachment) => attachment.attachmentId)).size !==
    managedAttachments.length
  ) {
    throw new Error('Managed attachment access must not contain duplicates.');
  }
  if (!SHA256.test(context.permissionProfileHash)) {
    throw new Error('Agent execution requires an attested permission-profile hash.');
  }
  assertBoundedText(
    context.clientOperationId,
    AGENT_RUNTIME_LIMITS.maxClientOperationIdBytes,
    'client operation id'
  );
  return {
    formatVersion: 1,
    attestation: context.attestation,
    owner: input.owner,
    providerId: input.providerId,
    model: input.model,
    primaryCwd: path.resolve(context.primaryCwd),
    readRoots,
    managedAttachments,
    permissionProfileHash: context.permissionProfileHash,
    modelSettings: context.modelSettings,
    externalTools: context.externalTools
  };
}

function assertBoundedIdentifier(value: string, label: string): void {
  assertBoundedText(value, AGENT_RUNTIME_LIMITS.maxOwnerIdBytes, label);
  if (/\p{Cc}|\p{Cf}/u.test(value)) {
    throw new Error(`Agent ${label} contains unsafe control characters.`);
  }
}

function assertBoundedText(value: string, maxBytes: number, label: string): void {
  if (!value || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Agent ${label} is empty or exceeds its safety limit.`);
  }
}

function requireTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Agent runtime timestamp is invalid.');
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
