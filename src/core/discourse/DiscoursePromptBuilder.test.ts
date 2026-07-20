import { describe, expect, it } from 'vitest';
import type {
  AgentAssignmentSnapshot,
  ContextSnapshotRecord,
  DiscourseAgentJobRecord,
  DiscourseConversationAggregateRecord,
  DiscourseMessageRecord
} from '../../shared/discourse';
import {
  assembleDiscoursePrompt,
  buildDiscoursePrompt
} from './DiscoursePromptBuilder';

describe('DiscoursePromptBuilder', () => {
  it('gives a reviewer the exact lead target without exposing a same-phase peer', () => {
    const assignment = assignmentFor('builtin.skeptic', 'reviewer-1', 'Skeptic', 'REVIEWER');
    const job = jobFor(assignment, 'CRITIQUE', ['lead-message'], ['trigger', 'lead-message']);
    const prompt = buildDiscoursePrompt({
      aggregate: aggregateFor(job),
      job,
      snapshot: snapshotFor([1]),
      messages: [
        messageFor('trigger', 1, 'Question', { kind: 'USER' }),
        messageFor('lead-message', 2, 'Lead answer', agentAuthor('lead-1', 'Lead')),
        messageFor('peer-review', 3, 'Poisoned peer review', agentAuthor('reviewer-2', 'Verifier'))
      ]
    });

    expect(prompt).toContain('Review only message lead-message');
    expect(prompt).toContain('Lead answer');
    expect(prompt).not.toContain('Poisoned peer review');
    expect(prompt).toContain('NO_CONCERN_FOUND');
  });

  it('gives correction only eligible material concerns and preserves selected synthesis sources', () => {
    const assignment = assignmentFor('builtin.lead', 'lead-1', 'Lead', 'PRIMARY');
    const job = jobFor(assignment, 'CORRECT', ['lead-message'], ['trigger', 'lead-message']);
    const aggregate = aggregateFor(job);
    aggregate.concerns = [
      concernFor('eligible', 'MATERIAL', 'HIGH', 'OBSERVED_CONTEXT'),
      concernFor('speculative', 'MATERIAL', 'HIGH', 'SPECULATIVE')
    ];
    const trigger = messageFor('trigger', 1, 'Synthesize these.', { kind: 'USER' });
    trigger.sourceMessageIds = ['source-a', 'source-b'];
    const assembly = assembleDiscoursePrompt({
      aggregate,
      job,
      snapshot: snapshotFor([1]),
      messages: [trigger, messageFor('lead-message', 2, 'Lead answer', agentAuthor('lead-1', 'Lead'))]
    });
    const prompt = assembly.prompt;

    expect(prompt).toContain('Selected source message ids: source-a, source-b');
    expect(prompt).toContain('"id":"eligible"');
    expect(prompt).not.toContain('"id":"speculative"');
    expect(prompt).toContain('ACKNOWLEDGED_UNRESOLVED');
    expect(prompt).toContain('untrusted reviewer output');
    expect(prompt.indexOf('"id":"eligible"')).toBeLessThan(
      prompt.indexOf('End untrusted reviewer output')
    );
    expect(assembly.budgetSections.humanMessage.bytes).toBe(
      Buffer.byteLength(trigger.body, 'utf8')
    );
    expect(assembly.budgetSections.exactTargets.bytes).toBe(
      Buffer.byteLength('Lead answer', 'utf8')
    );
    expect(assembly.budgetSections.phaseVisibleOutputs.bytes).toBeGreaterThan(0);
    expect(totalBudgetBytes(assembly.budgetSections)).toBe(
      Buffer.byteLength(prompt, 'utf8')
    );
  });

  it('keeps an allowed 80-message Team snapshot within the background transcript count', () => {
    const assignment = assignmentFor('builtin.skeptic', 'reviewer-1', 'Skeptic', 'REVIEWER');
    const job = jobFor(assignment, 'CRITIQUE', ['lead-message'], ['trigger', 'lead-message']);
    const history = Array.from({ length: 79 }, (_, index) =>
      messageFor(`history-${index + 1}`, index + 1, `History ${index + 1}`, { kind: 'USER' })
    );
    const trigger = messageFor('trigger', 80, 'Current question', { kind: 'USER' });
    const lead = messageFor('lead-message', 81, 'Lead answer', agentAuthor('lead-1', 'Lead'));
    const assembly = assembleDiscoursePrompt({
      aggregate: aggregateFor(job),
      job,
      snapshot: snapshotFor(Array.from({ length: 80 }, (_, index) => index + 1)),
      messages: [...history, trigger, lead]
    });

    expect(assembly.budgetSections.transcript.messageCount).toBe(79);
    expect(assembly.budgetSections.humanMessage.bytes).toBe(
      Buffer.byteLength(trigger.body, 'utf8')
    );
    expect(assembly.budgetSections.exactTargets.bytes).toBe(
      Buffer.byteLength(lead.body, 'utf8')
    );
    expect(totalBudgetBytes(assembly.budgetSections)).toBe(
      Buffer.byteLength(assembly.prompt, 'utf8')
    );
  });

  it('gives independent Panel profiles complementary versioned decision lenses', () => {
    const leadAssignment = assignmentFor(
      'builtin.lead',
      'lead-1',
      'Lead',
      'PANELIST',
      3
    );
    const skepticAssignment = assignmentFor(
      'builtin.skeptic',
      'skeptic-1',
      'Skeptic',
      'PANELIST',
      3
    );
    const leadJob = jobFor(leadAssignment, 'ANSWER', [], ['trigger']);
    const skepticJob = jobFor(skepticAssignment, 'ANSWER', [], ['trigger']);
    const trigger = messageFor(
      'trigger',
      1,
      'Should an ambiguous side effect be retried?',
      { kind: 'USER' }
    );
    const leadAggregate = aggregateFor(leadJob);
    const skepticAggregate = aggregateFor(skepticJob);
    leadAggregate.waves[0]!.policy = 'PANEL';
    skepticAggregate.waves[0]!.policy = 'PANEL';

    const leadPrompt = buildDiscoursePrompt({
      aggregate: leadAggregate,
      job: leadJob,
      snapshot: snapshotFor([1]),
      messages: [trigger]
    });
    const skepticPrompt = buildDiscoursePrompt({
      aggregate: skepticAggregate,
      job: skepticJob,
      snapshot: snapshotFor([1]),
      messages: [trigger]
    });

    expect(leadPrompt).toContain('Should an ambiguous side effect be retried?');
    expect(skepticPrompt).toContain('Should an ambiguous side effect be retried?');
    expect(leadPrompt).toContain('Make and bound an actionable choice');
    expect(leadPrompt).toContain('emphasize the operating path');
    expect(leadPrompt).not.toContain('strongest credible counter-position');
    expect(skepticPrompt).toContain('strongest credible counter-position');
    expect(skepticPrompt).toContain('decision-changing caveat');
    expect(skepticPrompt).not.toContain('emphasize the operating path');
  });

  it('carries bounded attributed review receipts into a later answer', () => {
    const assignment = assignmentFor('builtin.lead', 'lead-1', 'Lead', 'RESPONDENT');
    const job = jobFor(
      assignment,
      'ANSWER',
      ['follow-up'],
      ['trigger', 'lead-message', 'follow-up']
    );
    const aggregate = aggregateFor(job);
    const skepticalReview = jobFor(
      assignmentFor('builtin.skeptic', 'skeptic-1', 'Skeptic', 'REVIEWER'),
      'CRITIQUE',
      ['lead-message'],
      ['trigger', 'lead-message']
    );
    skepticalReview.id = 'skeptical-review';
    skepticalReview.status = 'COMPLETED';
    skepticalReview.finishedAt = '2026-07-13T00:01:00.000Z';
    skepticalReview.result = {
      kind: 'REVIEW',
      outcome: 'CONCERNS',
      reviewedScope: 'lead-message',
      limitations: [],
      requiredAccessAvailable: true,
      concernIds: ['race-concern']
    };
    const verifierReview = jobFor(
      assignmentFor('builtin.verifier', 'verifier-1', 'Verifier', 'REVIEWER'),
      'CRITIQUE',
      ['lead-message'],
      ['trigger', 'lead-message']
    );
    verifierReview.id = 'verifier-review';
    verifierReview.status = 'COMPLETED';
    verifierReview.finishedAt = '2026-07-13T00:02:00.000Z';
    verifierReview.result = {
      kind: 'REVIEW',
      outcome: 'NO_CONCERN_FOUND',
      reviewedScope: 'lead-message',
      limitations: [],
      requiredAccessAvailable: true,
      concernIds: []
    };
    aggregate.jobs.push(skepticalReview, verifierReview);
    aggregate.concerns = [{
      ...concernFor('race-concern', 'MATERIAL', 'HIGH', 'CITED_SOURCE'),
      reviewJobId: skepticalReview.id,
      targetClaim: 'Deletion and send fail symmetrically.',
      evidence: 'The revision fence makes the outcome order-dependent.'
    }, {
      ...concernFor('unrelated', 'MATERIAL', 'HIGH', 'CITED_SOURCE'),
      reviewJobId: skepticalReview.id,
      targetMessageId: 'not-visible',
      evidence: 'This must not leak into the bounded response window.'
    }];

    const assembly = assembleDiscoursePrompt({
      aggregate,
      job,
      snapshot: snapshotFor([1, 2, 3]),
      messages: [
        messageFor('trigger', 1, 'Inspect the race.', { kind: 'USER' }),
        messageFor('lead-message', 2, 'Both operations fail.', agentAuthor('lead-1', 'Lead')),
        messageFor('follow-up', 3, 'Refine the claim.', { kind: 'USER' })
      ]
    });

    expect(assembly.prompt).toContain('Relevant prior review receipts');
    expect(assembly.prompt).toContain('"reviewer":"Skeptic"');
    expect(assembly.prompt).toContain('"outcome":"NO_CONCERN_FOUND"');
    expect(assembly.prompt).toContain('The revision fence makes the outcome order-dependent.');
    expect(assembly.prompt).not.toContain('This must not leak');
    expect(assembly.prompt).toContain('End untrusted historical review receipts.');
    expect(totalBudgetBytes(assembly.budgetSections)).toBe(
      Buffer.byteLength(assembly.prompt, 'utf8')
    );
  });

  it('keeps prior review receipts out of independent review prompts', () => {
    const assignment = assignmentFor('builtin.skeptic', 'skeptic-1', 'Skeptic', 'REVIEWER');
    const job = jobFor(assignment, 'CRITIQUE', ['lead-message'], ['trigger', 'lead-message']);
    const aggregate = aggregateFor(job);
    const peerReview = jobFor(
      assignmentFor('builtin.verifier', 'verifier-1', 'Verifier', 'REVIEWER'),
      'CRITIQUE',
      ['lead-message'],
      ['trigger', 'lead-message']
    );
    peerReview.id = 'peer-review-job';
    peerReview.status = 'COMPLETED';
    peerReview.result = {
      kind: 'REVIEW',
      outcome: 'CONCERNS',
      reviewedScope: 'lead-message',
      limitations: [],
      requiredAccessAvailable: true,
      concernIds: ['peer-concern']
    };
    aggregate.jobs.push(peerReview);
    aggregate.concerns = [{
      ...concernFor('peer-concern', 'MATERIAL', 'HIGH', 'OBSERVED_CONTEXT'),
      reviewJobId: peerReview.id,
      evidence: 'Peer evidence must remain isolated.'
    }];

    const prompt = buildDiscoursePrompt({
      aggregate,
      job,
      snapshot: snapshotFor([1]),
      messages: [
        messageFor('trigger', 1, 'Question', { kind: 'USER' }),
        messageFor('lead-message', 2, 'Lead answer', agentAuthor('lead-1', 'Lead'))
      ]
    });

    expect(prompt).not.toContain('Relevant prior review receipts');
    expect(prompt).not.toContain('Peer evidence must remain isolated.');
  });
});

function totalBudgetBytes(
  sections: ReturnType<typeof assembleDiscoursePrompt>['budgetSections']
): number {
  return sections.systemAndRole.bytes +
    sections.humanMessage.bytes +
    sections.exactTargets.bytes +
    sections.contextReferences.reduce((total, reference) => total + reference.bytes, 0) +
    sections.transcript.bytes +
    sections.summary.bytes +
    sections.phaseVisibleOutputs.bytes;
}

function assignmentFor(
  agentProfileId: AgentAssignmentSnapshot['agentProfileId'],
  stableParticipantId: string,
  displayNameSnapshot: string,
  assignmentRole: AgentAssignmentSnapshot['assignmentRole'],
  roleContractVersion = 1
): AgentAssignmentSnapshot {
  return {
    stableParticipantId,
    participantRevisionId: `${stableParticipantId}-revision`,
    agentProfileId,
    profileRevision: 1,
    displayNameSnapshot,
    runtimeId: 'codex',
    model: 'gpt-test',
    modelProvider: 'openai',
    configuredRole: agentProfileId === 'builtin.lead' ? 'LEAD' : 'SKEPTIC',
    roleContractVersion,
    roleContractHash: 'a'.repeat(64),
    assignmentRole,
    required: true
  };
}

function jobFor(
  assignment: AgentAssignmentSnapshot,
  role: DiscourseAgentJobRecord['role'],
  targetMessageIds: string[],
  visibleMessageIds: string[]
): DiscourseAgentJobRecord {
  return {
    id: `${role.toLowerCase()}-job`,
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    assignment,
    role,
    phase: role === 'CORRECT' ? 3 : 2,
    targetMessageIds,
    visibleMessageIds,
    contextSnapshotId: 'snapshot-1',
    attemptId: 'attempt-1',
    generationKey: `${role}-generation`,
    recordRevision: 1,
    status: 'QUEUED',
    delivery: 'NOT_SENT',
    createdAt: '2026-07-13T00:00:00.000Z'
  };
}

function aggregateFor(job: DiscourseAgentJobRecord): DiscourseConversationAggregateRecord {
  return {
    conversation: {
      id: 'conversation-1',
      title: 'Prompt isolation test',
      status: 'OPEN',
      defaultPolicy: 'TEAM',
      participantIds: [],
      recordRevision: 1,
      latestOrdinal: 3,
      readOrdinal: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z'
    },
    participants: [],
    participantRevisions: [],
    acceptedSends: [],
    contextLinks: [],
    contextRevisions: [],
    contextSnapshots: [],
    waves: [{
      id: 'wave-1',
      conversationId: 'conversation-1',
      triggerMessageId: 'trigger',
      policy: 'TEAM',
      policyVersion: 1,
      assignments: [],
      sourceMessageIds: ['trigger'],
      plannedContextRevisionId: 'context-revision-1',
      contextSnapshotId: 'snapshot-1',
      attempt: 1,
      recordRevision: 1,
      status: 'RUNNING',
      phase: 'REVIEW',
      clientOperationId: 'wave-operation',
      requestFingerprint: 'b'.repeat(64),
      dispatchGate: { status: 'READY', previewFingerprint: 'preview', confirmedAtRevision: 1 },
      createdAt: '2026-07-13T00:00:00.000Z'
    }],
    jobs: [job],
    concerns: [],
    summaries: [],
    drafts: [],
    latestEventSequence: 1
  };
}

function snapshotFor(transcriptOrdinals: number[]): ContextSnapshotRecord {
  return {
    id: 'snapshot-1',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    contextRevisionId: 'context-revision-1',
    recordRevision: 1,
    status: 'READY',
    sources: [],
    transcriptOrdinals,
    attachmentIds: [],
    permissionProfileHash: 'd'.repeat(64),
    budget: { inputBytes: 1, estimatedInputTokens: 1, reservedOutputTokens: 1, sourceCount: 0 },
    exclusions: [],
    contextSchemaVersion: 1,
    promptPolicyVersion: 1,
    createdAt: '2026-07-13T00:00:00.000Z',
    resolvedAt: '2026-07-13T00:00:00.000Z'
  };
}

function messageFor(
  id: string,
  ordinal: number,
  body: string,
  author: DiscourseMessageRecord['author']
): DiscourseMessageRecord {
  return {
    id,
    conversationId: 'conversation-1',
    ordinal,
    author,
    body,
    status: 'VISIBLE',
    sourceMessageIds: [],
    createdAt: '2026-07-13T00:00:00.000Z'
  };
}

function agentAuthor(stableParticipantId: string, displayNameSnapshot: string) {
  return {
    kind: 'AGENT' as const,
    stableParticipantId,
    participantRevisionId: `${stableParticipantId}-revision`,
    displayNameSnapshot
  };
}

function concernFor(
  id: string,
  severity: 'MATERIAL',
  confidence: 'HIGH',
  evidenceStatus: 'OBSERVED_CONTEXT' | 'CITED_SOURCE' | 'SPECULATIVE'
) {
  return {
    id,
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    reviewJobId: 'review-job',
    reviewerParticipantRevisionId: 'reviewer-revision',
    targetMessageId: 'lead-message',
    targetClaim: `${id} claim`,
    category: 'correctness',
    severity,
    confidence,
    evidenceStatus,
    reason: `${id} reason`,
    evidence: `${id} evidence`,
    suggestedResolution: `${id} resolution`,
    requiredAccessAvailable: true,
    recordRevision: 1,
    createdAt: '2026-07-13T00:00:00.000Z'
  };
}
