import { describe, expect, it } from 'vitest';
import type {
  AgentAssignmentSnapshot,
  ContextSnapshotRecord,
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseDeliveryStatus,
  DiscourseJobResult,
  DiscourseJobRole,
  DiscourseJobStatus,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord,
  DiscourseWaveStatus
} from '../../shared/discourse';
import {
  assertContextSnapshotTransition,
  assertContextSnapshotRecord,
  assertDiscourseDeliveryTransition,
  assertDiscourseJobRecord,
  assertDiscourseJobTransition,
  assertDiscourseWaveRecord,
  assertDiscourseWaveTransition,
  deriveDiscourseWaveAggregate,
  isEligibleDiscourseConcern,
  reconcileDiscourseDelivery,
  resolveContextSnapshot,
  resolveDiscourseIdempotency,
  assertDiscourseMessageAppend
} from './DiscourseState';

describe('discourse state transitions', () => {
  it('enumerates every context snapshot transition and keeps resolved snapshots immutable', () => {
    const states = ['RESOLVING', 'READY', 'PARTIAL', 'BLOCKED'] as const;
    const allowed = {
      RESOLVING: ['READY', 'PARTIAL', 'BLOCKED'],
      READY: [],
      PARTIAL: [],
      BLOCKED: []
    } satisfies Record<(typeof states)[number], readonly (typeof states)[number][]>;

    expectTransitionMatrix(states, allowed, assertContextSnapshotTransition);

    const snapshot = contextSnapshot();
    const resolved = resolveContextSnapshot(snapshot, 'READY', '2026-07-13T10:01:00.000Z');
    expect(resolved).toMatchObject({
      status: 'READY',
      recordRevision: 2,
      sources: snapshot.sources
    });
    expect(snapshot.status).toBe('RESOLVING');
    expect(snapshot).not.toHaveProperty('resolvedAt');
    expect(() => resolveContextSnapshot(resolved, 'PARTIAL', 'later')).toThrow(
      'Invalid context snapshot transition'
    );
  });

  it('enumerates every response-wave transition', () => {
    const states = [
      'PLANNED',
      'SNAPSHOTTING',
      'QUEUED',
      'RUNNING',
      'STOP_REQUESTED',
      'STOPPING',
      'RECOVERY_REQUIRED',
      'SETTLED'
    ] as const;
    const allowed = {
      PLANNED: ['SNAPSHOTTING', 'STOP_REQUESTED', 'SETTLED'],
      SNAPSHOTTING: ['QUEUED', 'STOP_REQUESTED', 'RECOVERY_REQUIRED', 'SETTLED'],
      QUEUED: ['RUNNING', 'STOP_REQUESTED', 'SETTLED'],
      RUNNING: ['STOP_REQUESTED', 'RECOVERY_REQUIRED', 'SETTLED'],
      STOP_REQUESTED: ['STOPPING', 'RECOVERY_REQUIRED', 'SETTLED'],
      STOPPING: ['RECOVERY_REQUIRED', 'SETTLED'],
      RECOVERY_REQUIRED: ['RUNNING', 'STOPPING', 'SETTLED'],
      SETTLED: []
    } satisfies Record<DiscourseWaveStatus, readonly DiscourseWaveStatus[]>;

    expectTransitionMatrix(states, allowed, assertDiscourseWaveTransition);
  });

  it('enumerates every agent-job transition without a waiting-for-input state', () => {
    const states = [
      'QUEUED',
      'RESOLVING_CONTEXT',
      'STARTING',
      'RUNNING',
      'CANCEL_REQUESTED',
      'RECOVERY_REQUIRED',
      'COMPLETED',
      'FAILED',
      'CANCELED',
      'CONTEXT_STALE'
    ] as const;
    const allowed = {
      QUEUED: ['RESOLVING_CONTEXT', 'CANCELED'],
      RESOLVING_CONTEXT: ['STARTING', 'CANCEL_REQUESTED', 'FAILED', 'CONTEXT_STALE'],
      STARTING: ['RUNNING', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED', 'FAILED', 'CONTEXT_STALE'],
      RUNNING: [
        'CANCEL_REQUESTED',
        'RECOVERY_REQUIRED',
        'COMPLETED',
        'FAILED',
        'CONTEXT_STALE'
      ],
      CANCEL_REQUESTED: ['RECOVERY_REQUIRED', 'COMPLETED', 'CANCELED'],
      RECOVERY_REQUIRED: ['COMPLETED', 'FAILED', 'CANCELED'],
      COMPLETED: [],
      FAILED: [],
      CANCELED: [],
      CONTEXT_STALE: []
    } satisfies Record<DiscourseJobStatus, readonly DiscourseJobStatus[]>;

    expectTransitionMatrix(states, allowed, assertDiscourseJobTransition);
  });

  it('enumerates provider delivery transitions and permits only explicit ambiguous reconciliation', () => {
    const states = [
      'NOT_SENT',
      'SENDING',
      'ACKNOWLEDGED',
      'NOT_DELIVERED',
      'AMBIGUOUS',
      'TERMINAL'
    ] as const;
    const allowed = {
      NOT_SENT: ['SENDING'],
      SENDING: ['ACKNOWLEDGED', 'NOT_DELIVERED', 'AMBIGUOUS'],
      ACKNOWLEDGED: ['TERMINAL'],
      NOT_DELIVERED: [],
      AMBIGUOUS: [],
      TERMINAL: []
    } satisfies Record<DiscourseDeliveryStatus, readonly DiscourseDeliveryStatus[]>;

    expectTransitionMatrix(states, allowed, assertDiscourseDeliveryTransition);
    expect(() => reconcileDiscourseDelivery('AMBIGUOUS', 'ACKNOWLEDGED')).not.toThrow();
    expect(() => reconcileDiscourseDelivery('SENDING', 'ACKNOWLEDGED')).toThrow(
      'Only ambiguous delivery'
    );
  });
});

describe('discourse record invariants', () => {
  it('requires complete settlement evidence only on settled waves', () => {
    expect(() =>
      assertDiscourseWaveRecord({
        ...wave('DIRECT'),
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: 'COMPLETE',
        settlementReason: 'COMPLETED',
        settledAt: '2026-07-13T10:02:00.000Z'
      })
    ).not.toThrow();
    expect(() =>
      assertDiscourseWaveRecord({ ...wave('DIRECT'), outcome: 'COMPLETE' })
    ).toThrow('Only a settled discourse wave');
    expect(() =>
      assertDiscourseWaveRecord({
        ...wave('DIRECT'),
        status: 'SETTLED',
        outcome: 'COMPLETE'
      })
    ).toThrow('requires an outcome');
    expect(() =>
      assertDiscourseWaveRecord({
        ...wave('DIRECT'),
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: 'COMPLETE',
        settlementReason: 'FAILED',
        settledAt: '2026-07-13T10:02:00.000Z'
      })
    ).toThrow('Invalid discourse wave settlement');
    expect(() =>
      assertDiscourseWaveRecord({ ...wave('DIRECT'), phase: 'COMPLETE' })
    ).toThrow('active discourse wave');
  });

  it('allows typed results only on completed jobs and binds each result to its role', () => {
    expect(() => assertDiscourseJobRecord(answerJob())).not.toThrow();
    expect(() =>
      assertDiscourseJobRecord(
        job('lead', 'ANSWER', 'RUNNING', {
          kind: 'CONTRIBUTION',
          outputMessageId: 'message-lead'
        })
      )
    ).toThrow('Only a completed discourse job');
    expect(() =>
      assertDiscourseJobRecord(
        job('reviewer', 'CRITIQUE', 'COMPLETED', {
          kind: 'CONTRIBUTION',
          outputMessageId: 'message-reviewer'
        })
      )
    ).toThrow('require a REVIEW result');
    expect(() =>
      assertDiscourseJobRecord(
        reviewJob('reviewer', 'NO_CONCERN_FOUND', { requiredAccessAvailable: false })
      )
    ).toThrow('must abstain');
    expect(() =>
      assertDiscourseJobRecord(
        job('lead', 'ANSWER', 'COMPLETED', {
          kind: 'CONTRIBUTION',
          outputMessageId: '   '
        })
      )
    ).toThrow('nonblank output');
  });

  it('validates immutable context resolution manifests before they become usable', () => {
    const optionalMetadata = {
      ...contextSnapshot(),
      sources: [
        {
          contextLinkId: 'context-link-1',
          entityKind: 'REPOSITORY' as const,
          entityId: 'repository-1',
          labelSnapshot: 'Repository',
          required: false,
          availability: 'AVAILABLE' as const,
          accessMode: 'METADATA_ONLY' as const,
          exclusionReasons: ['Secondary roots are metadata-only.']
        }
      ],
      budget: {
        ...contextSnapshot().budget,
        sourceCount: 1
      }
    };
    expect(
      resolveContextSnapshot(optionalMetadata, 'PARTIAL', '2026-07-13T10:01:00.000Z')
        .status
    ).toBe('PARTIAL');
    expect(() =>
      assertContextSnapshotRecord({
        ...contextSnapshot(),
        sources: [optionalMetadata.sources[0]!, optionalMetadata.sources[0]!],
        budget: { ...contextSnapshot().budget, sourceCount: 2 }
      })
    ).toThrow('unique by context link');

    const requiredMissing = {
      ...optionalMetadata,
      sources: [{ ...optionalMetadata.sources[0]!, required: true }]
    };
    expect(() =>
      resolveContextSnapshot(requiredMissing, 'PARTIAL', '2026-07-13T10:01:00.000Z')
    ).toThrow('only optional degraded');
    expect(
      resolveContextSnapshot(
        requiredMissing,
        'BLOCKED',
        '2026-07-13T10:01:00.000Z',
        {
          code: 'CONTEXT_UNAVAILABLE',
          message: 'Required repository is unavailable.',
          category: 'CONTEXT',
          retryable: true
        }
      ).status
    ).toBe('BLOCKED');
  });

  it('makes concern materiality explicit and keeps redundancy separate', () => {
    expect(isEligibleDiscourseConcern(concern())).toBe(true);
    expect(isEligibleDiscourseConcern(concern({ confidence: 'LOW' }))).toBe(false);
    expect(isEligibleDiscourseConcern(concern({ evidenceStatus: 'SPECULATIVE' }))).toBe(false);
    expect(isEligibleDiscourseConcern(concern({ redundantOfConcernId: 'concern-older' }))).toBe(
      false
    );
  });

  it('replays only an identical client operation and rejects key reuse with changed content', () => {
    expect(
      resolveDiscourseIdempotency({
        clientOperationId: 'operation-1',
        requestFingerprint: 'fingerprint-1'
      })
    ).toBe('NEW');
    expect(
      resolveDiscourseIdempotency({
        existingOperation: {
          clientOperationId: 'operation-1',
          requestFingerprint: 'fingerprint-1'
        },
        clientOperationId: 'operation-1',
        requestFingerprint: 'fingerprint-1'
      })
    ).toBe('REPLAY');
    expect(() =>
      resolveDiscourseIdempotency({
        existingOperation: {
          clientOperationId: 'operation-1',
          requestFingerprint: 'fingerprint-1'
        },
        clientOperationId: 'operation-1',
        requestFingerprint: 'fingerprint-changed'
      })
    ).toThrow('REQUEST_CONFLICT');
  });

  it('enforces append-only ordinals, one-level replies, and same-author corrections', () => {
    const root = message('message-1', 1);
    const reply = message('message-2', 2, { replyToMessageId: root.id });
    expect(() =>
      assertDiscourseMessageAppend({
        conversationId: 'conversation-1',
        latestOrdinal: 1,
        existingMessages: [root],
        message: reply
      })
    ).not.toThrow();
    expect(() =>
      assertDiscourseMessageAppend({
        conversationId: 'conversation-1',
        latestOrdinal: 2,
        existingMessages: [root, reply],
        message: message('message-3', 3, { replyToMessageId: reply.id })
      })
    ).toThrow('one visible nesting level');
    expect(() =>
      assertDiscourseMessageAppend({
        conversationId: 'conversation-1',
        latestOrdinal: 1,
        existingMessages: [root],
        message: {
          ...message('message-agent', 2, { supersedesMessageId: root.id }),
          author: {
            kind: 'AGENT',
            stableParticipantId: 'lead',
            participantRevisionId: 'revision-lead',
            displayNameSnapshot: 'Lead'
          },
          clientMessageId: undefined,
          requestFingerprint: undefined
        }
      })
    ).toThrow('cannot change the author kind');
  });
});

describe('discourse wave aggregation', () => {
  it('makes any child recovery requirement authoritative for the parent', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('PANEL'),
        jobs: [job('panel-1', 'ANSWER', 'RECOVERY_REQUIRED')]
      })
    ).toEqual({ status: 'RECOVERY_REQUIRED' });
  });

  it('blocks downstream work when terminal freshness cannot be inspected', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('DIRECT'),
        jobs: [{ ...answerJob(), freshnessAtCompletion: 'UNKNOWN' }]
      })
    ).toEqual({ status: 'RECOVERY_REQUIRED' });
  });

  it('preserves a completion that wins a cancel race but starts no downstream work', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: { ...wave('DIRECT'), status: 'STOP_REQUESTED' },
        jobs: [answerJob()]
      })
    ).toEqual({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'STOPPED' });
    expect(
      deriveDiscourseWaveAggregate({
        wave: { ...wave('DIRECT'), status: 'STOP_REQUESTED' },
        jobs: [job('lead', 'ANSWER', 'CANCELED')]
      })
    ).toEqual({
      status: 'SETTLED',
      outcome: 'CANCELED',
      settlementReason: 'USER_CANCELED'
    });
  });

  it('settles stale before dispatch without treating it as an agent failure', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('DIRECT'),
        jobs: [job('lead', 'ANSWER', 'QUEUED')],
        contextChangedBeforeStart: true
      })
    ).toEqual({
      status: 'SETTLED',
      outcome: 'STALE',
      settlementReason: 'CONTEXT_CHANGED'
    });
  });

  it('completes Team only after full required review coverage', () => {
    const jobs = [
      answerJob(),
      reviewJob('skeptic', 'NO_CONCERN_FOUND'),
      reviewJob('verifier', 'NO_CONCERN_FOUND')
    ];
    expect(deriveDiscourseWaveAggregate({ wave: wave('TEAM'), jobs })).toEqual({
      status: 'SETTLED',
      outcome: 'COMPLETE',
      settlementReason: 'COMPLETED'
    });
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: [jobs[0]!, jobs[1]!, reviewJob('verifier', 'ABSTAINED')]
      })
    ).toEqual({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'COMPLETED' });
  });

  it('requires one successful correction for eligible Team concerns', () => {
    const concernRecord = concern();
    const baseJobs = [
      answerJob(),
      reviewJob('skeptic', 'CONCERNS', { concernIds: [concernRecord.id] }),
      reviewJob('verifier', 'NO_CONCERN_FOUND')
    ];
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: baseJobs,
        concerns: [concernRecord]
      })
    ).toEqual({ status: 'RUNNING', nextPhase: 'CORRECT' });
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: [...baseJobs, correctionJob('REVISED')],
        concerns: [concernRecord]
      })
    ).toEqual({ status: 'SETTLED', outcome: 'COMPLETE', settlementReason: 'COMPLETED' });
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: [...baseJobs, correctionJob('ABSTAINED')],
        concerns: [concernRecord]
      })
    ).toEqual({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'FAILED' });
  });

  it('keeps Panel responses independent and reports partial coverage', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('PANEL'),
        jobs: [answerJob('panel-1'), job('panel-2', 'ANSWER', 'FAILED')]
      })
    ).toEqual({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: 'FAILED' });
  });

  it('does not complete Panel until every frozen assignment has a job', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('PANEL'),
        jobs: [answerJob('panel-1')]
      })
    ).toEqual({ status: 'RUNNING', nextPhase: 'ANSWER' });
  });

  it('rejects rogue, duplicate, and optional policy assignments', () => {
    expect(() =>
      deriveDiscourseWaveAggregate({
        wave: wave('DIRECT'),
        jobs: [answerJob('rogue')]
      })
    ).toThrow('immutable assignment');
    expect(() =>
      deriveDiscourseWaveAggregate({
        wave: wave('DIRECT'),
        jobs: [answerJob(), { ...answerJob(), id: 'job-lead-duplicate' }]
      })
    ).toThrow('duplicate jobs');
    const direct = wave('DIRECT');
    expect(() =>
      deriveDiscourseWaveAggregate({
        wave: {
          ...direct,
          assignments: [
            ...direct.assignments,
            { ...assignment('optional', 'ANSWER'), required: false }
          ]
        },
        jobs: [answerJob()]
      })
    ).toThrow('Optional discourse assignments');
  });

  it('preserves an answer whose context changed during execution and stops Team review', () => {
    expect(
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: [{ ...answerJob(), freshnessAtCompletion: 'CHANGED_DURING_JOB' }]
      })
    ).toEqual({
      status: 'SETTLED',
      outcome: 'STALE',
      settlementReason: 'CONTEXT_CHANGED'
    });
  });

  it('rejects concern ids that are missing or attributed to another review job', () => {
    expect(() =>
      deriveDiscourseWaveAggregate({
        wave: wave('TEAM'),
        jobs: [
          answerJob(),
          reviewJob('skeptic', 'CONCERNS', { concernIds: ['concern-missing'] }),
          reviewJob('verifier', 'NO_CONCERN_FOUND')
        ]
      })
    ).toThrow('unknown discourse concern');
  });
});

function expectTransitionMatrix<T extends string>(
  states: readonly T[],
  allowed: Readonly<Record<T, readonly T[]>>,
  assertTransition: (current: T, next: T) => void
): void {
  for (const current of states) {
    for (const next of states) {
      if (allowed[current].includes(next)) {
        expect(() => assertTransition(current, next), `${current} -> ${next}`).not.toThrow();
      } else {
        expect(() => assertTransition(current, next), `${current} -> ${next}`).toThrow('Invalid');
      }
    }
  }
}

function wave(policy: DiscourseResponseWaveRecord['policy']): DiscourseResponseWaveRecord {
  const assignments =
    policy === 'TEAM'
      ? [
          assignment('lead', 'ANSWER'),
          assignment('skeptic', 'CRITIQUE'),
          assignment('verifier', 'CRITIQUE')
        ]
      : policy === 'PANEL'
        ? [assignment('panel-1', 'ANSWER'), assignment('panel-2', 'ANSWER')]
        : [
            assignment(
              'lead',
              policy === 'TARGETED_REVIEW'
                ? 'CRITIQUE'
                : policy === 'TARGETED_REPLY'
                  ? 'TARGETED_REPLY'
                  : policy === 'SYNTHESIS'
                    ? 'SYNTHESIZE'
                    : 'ANSWER'
            )
          ];
  return {
    id: 'wave-1',
    conversationId: 'conversation-1',
    triggerMessageId: 'message-user',
    policy,
    policyVersion: 1,
    assignments,
    sourceMessageIds: ['message-user'],
    plannedContextRevisionId: 'context-revision-1',
    contextSnapshotId: 'context-snapshot-1',
    attempt: 1,
    recordRevision: 1,
    status: 'RUNNING',
    phase: 'ANSWER',
    clientOperationId: 'operation-1',
    requestFingerprint: 'fingerprint-1',
    dispatchGate: {
      status: 'READY',
      previewFingerprint: 'preview-fingerprint-1',
      confirmedAtRevision: 1
    },
    createdAt: '2026-07-13T10:00:00.000Z'
  };
}

function assignment(id: string, role: DiscourseJobRole): AgentAssignmentSnapshot {
  return {
    stableParticipantId: id,
    participantRevisionId: `revision-${id}`,
    agentProfileId: `profile-${id}`,
    profileRevision: 1,
    displayNameSnapshot: id,
    runtimeId: 'codex',
    model: 'gpt-test',
    modelProvider: 'openai',
    configuredRole: role === 'CRITIQUE' ? 'VERIFIER' : 'LEAD',
    roleContractVersion: 1,
    roleContractHash: 'role-contract-hash',
    assignmentRole:
      role === 'CRITIQUE'
        ? 'REVIEWER'
        : role === 'TARGETED_REPLY'
          ? 'RESPONDENT'
          : role === 'SYNTHESIZE'
            ? 'SYNTHESIZER'
            : id.startsWith('panel-')
              ? 'PANELIST'
              : 'PRIMARY',
    required: true
  };
}

function job(
  id: string,
  role: DiscourseJobRole,
  status: DiscourseJobStatus,
  result?: DiscourseJobResult
): DiscourseAgentJobRecord {
  const terminal = ['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(status);
  return {
    id: `job-${id}`,
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    assignment: assignment(id, role),
    role,
    phase: 1,
    targetMessageIds: role === 'CRITIQUE' ? ['message-lead'] : [],
    visibleMessageIds: ['message-user'],
    contextSnapshotId: 'context-snapshot-1',
    attemptId: `attempt-${id}`,
    generationKey: `generation-${id}`,
    recordRevision: 1,
    status,
    delivery:
      status === 'COMPLETED'
        ? 'TERMINAL'
        : status === 'RUNNING' || status === 'CANCEL_REQUESTED'
          ? 'ACKNOWLEDGED'
          : status === 'STARTING'
            ? 'SENDING'
            : status === 'RECOVERY_REQUIRED'
              ? 'AMBIGUOUS'
              : 'NOT_SENT',
    result,
    ...(status === 'COMPLETED' && role !== 'COMPACT_HISTORY'
      ? { freshnessAtCompletion: 'FRESH' as const }
      : {}),
    ...(status === 'FAILED'
      ? {
          error: {
            code: 'INTERNAL_FAILURE' as const,
            message: 'The test job failed.',
            category: 'INTERNAL' as const,
            retryable: false
          }
        }
      : {}),
    createdAt: '2026-07-13T10:00:00.000Z',
    finishedAt:
      terminal
        ? '2026-07-13T10:01:00.000Z'
        : undefined
  };
}

function answerJob(id = 'lead'): DiscourseAgentJobRecord {
  return job(id, 'ANSWER', 'COMPLETED', {
    kind: 'CONTRIBUTION',
    outputMessageId: `message-${id}`
  });
}

function reviewJob(
  id: string,
  outcome: 'CONCERNS' | 'NO_CONCERN_FOUND' | 'ABSTAINED',
  overrides: Partial<Extract<DiscourseJobResult, { kind: 'REVIEW' }>> = {}
): DiscourseAgentJobRecord {
  return job(id, 'CRITIQUE', 'COMPLETED', {
    kind: 'REVIEW',
    outcome,
    reviewedScope: 'message-lead',
    limitations: outcome === 'ABSTAINED' ? ['Required source unavailable.'] : [],
    requiredAccessAvailable: outcome !== 'ABSTAINED',
    concernIds: [],
    ...overrides
  });
}

function correctionJob(
  outcome: Extract<DiscourseJobResult, { kind: 'CORRECTION' }>['outcome']
): DiscourseAgentJobRecord {
  return {
    ...job('lead', 'CORRECT', 'COMPLETED', {
      kind: 'CORRECTION',
      outcome,
      limitations: outcome === 'ABSTAINED' ? ['Unable to verify the target.'] : [],
      ...(outcome === 'ABSTAINED' ? {} : { outputMessageId: 'message-lead-correction' })
    }),
    id: 'job-lead-correction',
    attemptId: 'attempt-lead-correction',
    generationKey: 'generation-lead-correction'
  };
}

function concern(
  overrides: Partial<DiscourseConcernRecord> = {}
): DiscourseConcernRecord {
  return {
    id: 'concern-1',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    reviewJobId: 'job-skeptic',
    reviewerParticipantRevisionId: 'revision-skeptic',
    targetMessageId: 'message-lead',
    targetClaim: 'The response makes a material claim.',
    category: 'CORRECTNESS',
    severity: 'MATERIAL',
    confidence: 'HIGH',
    evidenceStatus: 'OBSERVED_CONTEXT',
    reason: 'The inspected source contradicts the claim.',
    evidence: 'source.ts records the opposite value.',
    suggestedResolution: 'Revise the claim to match the source.',
    requiredAccessAvailable: true,
    recordRevision: 1,
    createdAt: '2026-07-13T10:01:00.000Z',
    ...overrides
  };
}

function contextSnapshot(): ContextSnapshotRecord {
  return {
    id: 'context-snapshot-1',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    contextRevisionId: 'context-revision-1',
    recordRevision: 1,
    status: 'RESOLVING',
    sources: [],
    transcriptOrdinals: [1],
    attachmentIds: [],
    budget: {
      inputBytes: 100,
      estimatedInputTokens: 25,
      reservedOutputTokens: 1000,
      sourceCount: 0
    },
    exclusions: [],
    contextSchemaVersion: 1,
    promptPolicyVersion: 1,
    createdAt: '2026-07-13T10:00:00.000Z'
  };
}

function message(
  id: string,
  ordinal: number,
  overrides: Partial<DiscourseMessageRecord> = {}
): DiscourseMessageRecord {
  return {
    id,
    conversationId: 'conversation-1',
    ordinal,
    author: { kind: 'USER' },
    body: 'Message body',
    status: 'VISIBLE',
    sourceMessageIds: [],
    clientMessageId: `client-${id}`,
    requestFingerprint: `fingerprint-${id}`,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides
  };
}
