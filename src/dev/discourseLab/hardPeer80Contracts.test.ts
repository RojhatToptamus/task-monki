import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase
} from './contracts';
import {
  HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA,
  HARD_PEER_80_OUTPUT_JSON_SCHEMA,
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  parseAndValidateHardPeer80Output,
  validateHardPeer80Output,
  type HardPeer80PublicOutput,
  type HardPeer80ValidationContext,
  type HardPeer80VisibleArtifact
} from './hardPeer80Contracts';
import type { HardPeer80Certificate } from './hardPeer80Corpus';

describe('HARD-PEER-80 public output contract', () => {
  it('uses a strict-compatible closed payload union without unsupported tuple keywords', () => {
    expect(allObjectSchemasAreClosed(HARD_PEER_80_OUTPUT_JSON_SCHEMA)).toBe(true);
    expect(schemaContainsKeyword(HARD_PEER_80_OUTPUT_JSON_SCHEMA, 'oneOf')).toBe(false);
    expect(schemaContainsKeyword(HARD_PEER_80_OUTPUT_JSON_SCHEMA, 'prefixItems')).toBe(false);
    expect(strictStructuredOutputSchemaErrors(HARD_PEER_80_OUTPUT_JSON_SCHEMA)).toEqual([]);
    expect((HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA.anyOf)).toHaveLength(8);
  });

  it('publishes structural certificate semantics without hidden canonical answer labels', () => {
    const schemaText = JSON.stringify(HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA);
    expect(schemaText).not.toContain('requiredRepairPredicates');
    expect(schemaText).not.toContain('acceptedProtocol');
    expect(schemaText).not.toContain('crashCuts');
    expect(schemaText).not.toContain('"const":"IMPOSSIBLE"');
    expect(schemaText).toContain('scopeUpdatesToRequestedSessionBeforeLatestSelection');
    expect(schemaText).toContain('crashScenarios');
    expect(schemaText).toContain('sendsInterrupt');
    expect(schemaText).toContain('Exactly ten bits in declared variableOrder');
  });

  it('rejects a non-public Boolean assignment encoding at the schema boundary', () => {
    const output = answer('INITIAL');
    if (output.certificate.payload?.kind !== 'BOOLEAN_TRUTH_TABLE') {
      throw new Error('wrong fixture');
    }
    output.certificate.payload.satisfyingAssignments = ['2222222222'];
    expect(validateHardPeer80Output(output, context('INITIAL', 'A0'))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ path: '$.certificate.payload', code: 'INVALID_VALUE' })
      ])
    });
  });

  it('parses a concise initial answer and rejects hidden-reasoning fields', () => {
    const output = answer('INITIAL');
    expect(parseAndValidateHardPeer80Output(JSON.stringify(output), context('INITIAL', 'A0')))
      .toEqual(expect.objectContaining({ ok: true }));

    const withAnalysis = { ...output, chainOfThought: 'private reasoning' };
    expect(validateHardPeer80Output(withAnalysis, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.chainOfThought', code: 'UNKNOWN_FIELD' })
        ])
      })
    );
  });

  it('allows uncertainty, requests, abstention, and an empty issue set', () => {
    const uncertain = answer('INITIAL');
    uncertain.answer.status = 'UNCERTAIN';
    uncertain.answer.selectedOptionIds = [];
    uncertain.claims[0]!.stance = 'OPEN';
    uncertain.claims[0]!.evidence = [{
      evidenceId: 'PROMPT', relation: 'LIMITS', note: 'The question leaves this open.'
    }];
    uncertain.certificate = {
      kind: 'MISSING_INFORMATION',
      statement: 'A missing fact prevents a unique answer.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'LIMITS', note: 'No value is supplied.' }],
      payload: null
    };
    uncertain.requests = [{
      id: 'request-1',
      kind: 'MISSING_FACT',
      question: 'What is the missing value?',
      source: 'DOCUMENT',
      blocking: true,
      propositionIds: ['p1']
    }];
    uncertain.resolution = {
      status: 'UNRESOLVED',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'The answer remains open.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    };
    expect(validateHardPeer80Output(uncertain, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({ ok: true })
    );

    const abstained = structuredClone(uncertain);
    abstained.answer.status = 'ABSTAIN';
    abstained.abstention = {
      reason: 'OUTSIDE_CAPABILITY',
      summary: 'Cannot perform this evaluation.',
      propositionIds: ['p1'],
      whatWouldResolve: null
    };
    expect(validateHardPeer80Output(abstained, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it.each(certificatePayloads().map((payload) => [payload.kind, payload] as const))(
    'accepts a closed, typed %s payload without checking case-oracle truth',
    (_kind, payload) => {
      const output = answer('INITIAL');
      output.certificate.payload = payload;
      expect(validateHardPeer80Output(output, context('INITIAL', 'A0'))).toEqual(
        expect.objectContaining({ ok: true })
      );
    }
  );

  it('requires payload on non-probe ANSWER while allowing null for uncertainty and probe', () => {
    const missing = answer('INITIAL');
    missing.certificate.payload = null;
    expect(validateHardPeer80Output(missing, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.certificate.payload', code: 'INVALID_VALUE' })
        ])
      })
    );

    const uncertain = answer('INITIAL');
    uncertain.answer.status = 'UNCERTAIN';
    uncertain.certificate.payload = null;
    expect(validateHardPeer80Output(uncertain, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({ ok: true })
    );

    const probe = answer('PROBE');
    probe.certificate.payload = null;
    expect(validateHardPeer80Output(probe, context('PROBE', 'PROBE'))).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('keeps conversational artifacts out of factual evidence', () => {
    const a0 = answer('INITIAL');
    const reviewed = answer('PEER_CRITIQUE');
    reviewed.claims[0]!.evidence[0]!.evidenceId = 'A0';
    expect(validateHardPeer80Output(
      reviewed,
      context('PEER_CRITIQUE', 'P1', [artifact('A0', 'POSITION', 'AUTHOR', a0)])
    )).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: '$.claims[0].evidence[0].evidenceId',
          code: 'INVALID_REFERENCE'
        })
      ])
    }));
  });

  it('requires typed evidence for decided claims and material issues', () => {
    const unsupported = answer('INITIAL');
    unsupported.claims[0]!.evidence = [];
    expect(validateHardPeer80Output(unsupported, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.claims[0].evidence', code: 'INVALID_VALUE' })
        ])
      })
    );

    const peer = answer('PEER_CRITIQUE');
    peer.issues = [{
      id: 'unsupported-issue',
      targetArtifactId: 'A0',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1',
      kind: 'LOGIC',
      severity: 'MATERIAL',
      proposedStance: 'REJECT',
      proposedStatus: null,
      proposedOptionIds: null,
      proposedCertificate: null,
      statement: 'The answer should change.',
      evidence: [],
      confidence: 0.7
    }];
    peer.resolution = {
      status: 'UNRESOLVED',
      basis: 'EVIDENCE',
      summary: 'The issue awaits a response.',
      resolvedIssueIds: [],
      unresolvedIssueIds: ['unsupported-issue']
    };
    expect(validateHardPeer80Output(
      peer,
      context('PEER_CRITIQUE', 'P1', [
        artifact('A0', 'POSITION', 'AUTHOR', answer('INITIAL'))
      ])
    )).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ path: '$.issues[0].evidence', code: 'INVALID_VALUE' })
      ])
    }));
  });

  it('accepts a peer no-issue result without manufactured criticism', () => {
    const a0 = answer('INITIAL');
    const peer = answer('PEER_CRITIQUE');
    expect(validateHardPeer80Output(
      peer,
      context('PEER_CRITIQUE', 'P1', [artifact('A0', 'POSITION', 'AUTHOR', a0)])
    )).toEqual(expect.objectContaining({ ok: true }));
  });

  it('accepts all four typed issue targets and rejects component/proposition mismatches', () => {
    const a0 = answer('INITIAL');
    const validationContext = context(
      'PEER_CRITIQUE',
      'P1',
      [artifact('A0', 'POSITION', 'AUTHOR', a0)]
    );
    const issues: HardPeer80PublicOutput['issues'] = [
      {
        id: 'proposition-issue', targetArtifactId: 'A0', targetComponent: 'PROPOSITION',
        targetPropositionId: 'p1', kind: 'LOGIC', severity: 'MATERIAL',
        proposedStance: 'REJECT', proposedStatus: null, proposedOptionIds: null,
        proposedCertificate: null, statement: 'The proposition is contradicted.',
        evidence: [{ evidenceId: 'E1', relation: 'CONTRADICTS', note: 'E1 contradicts it.' }],
        confidence: 0.8
      },
      {
        id: 'selection-issue', targetArtifactId: 'A0', targetComponent: 'ANSWER_SELECTION',
        targetPropositionId: null, kind: 'LOGIC', severity: 'MATERIAL',
        proposedStance: null, proposedStatus: null, proposedOptionIds: ['o2'],
        proposedCertificate: null, statement: 'The selected option is wrong.',
        evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 selects o2.' }],
        confidence: 0.8
      },
      {
        id: 'state-issue', targetArtifactId: 'A0', targetComponent: 'EPISTEMIC_STATE',
        targetPropositionId: null, kind: 'LOGIC', severity: 'MATERIAL',
        proposedStance: null, proposedStatus: 'ANSWER', proposedOptionIds: null,
        proposedCertificate: null, statement: 'The case is answerable.',
        evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 resolves it.' }],
        confidence: 0.8
      },
      {
        id: 'certificate-issue', targetArtifactId: 'A0', targetComponent: 'CERTIFICATE',
        targetPropositionId: null, kind: 'EVIDENCE', severity: 'MATERIAL',
        proposedStance: null, proposedStatus: null, proposedOptionIds: null,
        proposedCertificate: certificatePayloads()[1]!, statement: 'The certificate is incomplete.',
        evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 supplies the trace.' }],
        confidence: 0.8
      }
    ];
    for (const issue of issues) {
      const peer = answer('PEER_CRITIQUE');
      peer.issues = [issue];
      peer.resolution = {
        status: 'UNRESOLVED', basis: 'EVIDENCE', summary: 'The issue awaits a response.',
        resolvedIssueIds: [], unresolvedIssueIds: [issue.id]
      };
      expect(validateHardPeer80Output(peer, validationContext)).toEqual(
        expect.objectContaining({ ok: true })
      );
    }

    const mismatched: unknown = {
      ...answer('PEER_CRITIQUE'),
      issues: [{ ...issues[0], targetPropositionId: null }],
      resolution: {
        status: 'UNRESOLVED', basis: 'EVIDENCE', summary: 'Mismatch.',
        resolvedIssueIds: [], unresolvedIssueIds: ['proposition-issue']
      }
    };
    expect(validateHardPeer80Output(mismatched, validationContext)).toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it('enforces stage-specific critique and response provenance', () => {
    const a0 = answer('INITIAL');
    a0.issues = [{
      id: 'initial-issue',
      targetArtifactId: 'CASE',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1',
      kind: 'LOGIC',
      severity: 'ADVISORY',
      proposedStance: 'OPEN',
      proposedStatus: null,
      proposedOptionIds: null,
      proposedCertificate: null,
      statement: 'Initial answers cannot emit critique issues.',
      evidence: [],
      confidence: 0.5
    }];
    a0.resolution.unresolvedIssueIds = ['initial-issue'];
    expect(validateHardPeer80Output(a0, context('INITIAL', 'A0'))).toEqual(
      expect.objectContaining({ ok: false })
    );

    const selfReview = answer('SELF_REVIEW');
    selfReview.issues = [{
      id: 'self-issue',
      targetArtifactId: 'CASE',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1',
      kind: 'LOGIC',
      severity: 'ADVISORY',
      proposedStance: 'OPEN',
      proposedStatus: null,
      proposedOptionIds: null,
      proposedCertificate: null,
      statement: 'The issue targets the wrong artifact.',
      evidence: [],
      confidence: 0.5
    }];
    selfReview.resolution.unresolvedIssueIds = ['self-issue'];
    expect(validateHardPeer80Output(
      selfReview,
      context('SELF_REVIEW', 'S1', [
        artifact('A0', 'POSITION', 'AUTHOR', answer('INITIAL'))
      ])
    )).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ path: '$.issues[0].targetArtifactId' })
      ])
    }));
  });

  it('requires exact issue-level author responses and preserves explicit disagreement', () => {
    const a0 = answer('INITIAL');
    const peer = answer('PEER_CRITIQUE');
    peer.answer.selectedOptionIds = ['o2'];
    peer.claims[0]!.stance = 'REJECT';
    peer.claims[0]!.statement = 'The trace contradicts the first answer.';
    peer.claims[0]!.evidence = [{
      evidenceId: 'E1', relation: 'CONTRADICTS', note: 'The trace reaches the other state.'
    }];
    peer.issues = [{
      id: 'peer-issue-1',
      targetArtifactId: 'A0',
      targetComponent: 'PROPOSITION',
      targetPropositionId: 'p1',
      kind: 'LOGIC',
      severity: 'MATERIAL',
      proposedStance: 'REJECT',
      proposedStatus: null,
      proposedOptionIds: null,
      proposedCertificate: null,
      statement: 'A0 skips the final state transition.',
      evidence: [{ evidenceId: 'E1', relation: 'CONTRADICTS', note: 'The final transition differs.' }],
      confidence: 0.9
    }];
    peer.resolution = {
      status: 'UNRESOLVED',
      basis: 'EVIDENCE',
      summary: 'The author has not answered the issue.',
      resolvedIssueIds: [],
      unresolvedIssueIds: ['peer-issue-1']
    };
    const visible = [
      artifact('A0', 'POSITION', 'AUTHOR', a0),
      artifact('P1', 'REVIEW', 'PEER', peer)
    ] as const;
    const final = answer('AUTHOR_RESPONSE');
    final.answer.selectedOptionIds = ['o2'];
    final.claims[0]!.stance = 'REJECT';
    final.responses = [{
      id: 'response-1',
      targetArtifactId: 'P1',
      targetIssueId: 'peer-issue-1',
      disposition: 'ACCEPT',
      statement: 'Accepted: the final state transition changes the result.',
      evidence: [{ evidenceId: 'E1', relation: 'CONTRADICTS', note: 'The trace is decisive.' }],
      changedTargets: [{ component: 'PROPOSITION', propositionId: 'p1' }]
    }];
    final.disagreements = [{
      id: 'disagreement-1',
      targets: [{ component: 'PROPOSITION', propositionId: 'p1' }],
      participantArtifactIds: ['A0', 'P1', 'AP1'],
      status: 'RESOLVED',
      summary: 'The author changed position because the peer exposed the skipped transition.',
      evidence: [{ evidenceId: 'E1', relation: 'CONTRADICTS', note: 'The trace resolves it.' }],
      requestId: null
    }];
    final.resolution = {
      status: 'RESOLVED',
      basis: 'EVIDENCE',
      summary: 'The issue was corrected.',
      resolvedIssueIds: ['peer-issue-1'],
      unresolvedIssueIds: []
    };
    const validationContext = context('AUTHOR_RESPONSE', 'AP1', visible);
    expect(validateHardPeer80Output(final, validationContext)).toEqual(
      expect.objectContaining({ ok: true })
    );

    const duplicateChangedTarget = structuredClone(final);
    duplicateChangedTarget.responses[0]!.changedTargets.push(
      { component: 'PROPOSITION', propositionId: 'p1' }
    );
    expect(validateHardPeer80Output(duplicateChangedTarget, validationContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_ID' })])
      })
    );

    const unknownChangedTarget = structuredClone(final);
    unknownChangedTarget.responses[0]!.changedTargets = [
      { component: 'PROPOSITION', propositionId: 'unknown-proposition' }
    ];
    expect(validateHardPeer80Output(unknownChangedTarget, validationContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_REFERENCE' })])
      })
    );

    const invalidProposal = structuredClone(peer);
    invalidProposal.issues = [{
      id: 'bad-option-proposal',
      targetArtifactId: 'A0',
      targetComponent: 'ANSWER_SELECTION',
      targetPropositionId: null,
      kind: 'LOGIC',
      severity: 'MATERIAL',
      proposedStance: null,
      proposedStatus: null,
      proposedOptionIds: ['not-an-option'],
      proposedCertificate: null,
      statement: 'The selected answer should change.',
      evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 decides the option.' }],
      confidence: 0.9
    }];
    invalidProposal.resolution.unresolvedIssueIds = ['bad-option-proposal'];
    expect(validateHardPeer80Output(
      invalidProposal,
      context('PEER_CRITIQUE', 'P1', [artifact('A0', 'POSITION', 'AUTHOR', a0)])
    )).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: '$.issues[0].proposedOptionIds[0]', code: 'INVALID_REFERENCE'
        })
      ])
    }));

    const omitted = structuredClone(final);
    omitted.responses = [];
    expect(validateHardPeer80Output(omitted, validationContext)).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: '$.responses', code: 'INVALID_REFERENCE' })
        ])
      })
    );

    const silentlyUnresolved = structuredClone(final);
    silentlyUnresolved.responses[0]!.disposition = 'PARTIAL';
    expect(validateHardPeer80Output(silentlyUnresolved, validationContext)).toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it('fails context integrity when a sibling artifact is exposed', () => {
    const a0 = answer('INITIAL');
    const w1 = answer('WORKBENCH_1');
    expect(validateHardPeer80Output(
      answer('PEER_CRITIQUE'),
      context('PEER_CRITIQUE', 'P1', [
        artifact('A0', 'POSITION', 'AUTHOR', a0),
        artifact('W1', 'REVIEW', 'AUTHOR', w1)
      ])
    )).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'hard-peer-80.context',
          measurementEffect: 'MEASUREMENT_UNAVAILABLE'
        })
      ])
    }));
  });
});

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'HP80-T1',
    question: 'Which option follows from the trace?',
    evidence: [{ id: 'E1', text: 'The trace ends in state one.' }],
    propositions: [{ id: 'p1', topicId: 'trace', text: 'The trace ends in state one.' }],
    options: [{ id: 'o1', text: 'State one' }, { id: 'o2', text: 'State two' }],
    topics: [{ id: 'trace', label: 'Trace result' }]
  };
}

function answer(stage: HardPeer80PublicOutput['stage']): HardPeer80PublicOutput {
  return {
    schemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    stage,
    answer: {
      status: 'ANSWER',
      summary: 'The trace ends in state one.',
      selectedOptionIds: ['o1'],
      confidence: 0.8
    },
    certificate: {
      kind: 'TRACE',
      statement: 'Following E1 reaches state one.',
      evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 states the final state.' }],
      payload: certificatePayloads()[1]!
    },
    claims: [{
      id: 'claim-1',
      propositionId: 'p1',
      stance: 'ACCEPT',
      statement: 'The trace ends in state one.',
      evidence: [{ evidenceId: 'E1', relation: 'SUPPORTS', note: 'E1 states the final state.' }],
      assumptionIds: [],
      confidence: 0.8
    }],
    assumptions: [],
    requests: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material issue is present.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    abstention: null
  };
}

function certificatePayloads(): HardPeer80Certificate[] {
  return [
    {
      kind: 'FORBIDDEN_DIFFERENCE_MATCHING',
      universeSize: 3,
      forbiddenDifferences: [1],
      specialElements: [1],
      exactSpecialCount: 1,
      optimum: 2,
      construction: [1, 3],
      upperBoundMatching: [[1, 2]]
    },
    {
      kind: 'BOOLEAN_TRUTH_TABLE',
      variableOrder: ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'],
      satisfyingAssignments: ['1000000000'],
      queryTrueAssignments: ['1000000000'],
      queryFalseAssignments: [],
      classification: 'ENTAILED'
    },
    {
      kind: 'CLOCK_OFFSET_WITNESSES',
      offsetRange: [-1, 1],
      latencyRange: [0, 2],
      relativeOffsetRange: [-2, 2],
      worlds: [{
        name: 'w1', offsetA: 0, offsetB: 1, latency: 1,
        leaseAUtc: [0, 1], leaseBUtc: [1, 2], claimTrue: false
      }]
    },
    {
      kind: 'CONTINGENCY_EXPECTATION_BOUNDS',
      population: 10,
      initialPositive: 4,
      flagged: 3,
      intersectionRange: [0, 3],
      repairProbability: 0.5,
      damageProbability: 0.2,
      finalExpectationIntercept: 4.6,
      finalExpectationSlope: -0.7,
      finalExpectationRange: [2.5, 4.6],
      strictImprovementMinimumIntegerIntersection: 1,
      witnessTables: [{
        intersection: 1,
        flaggedGood: 2,
        unflaggedDefective: 3,
        unflaggedGood: 4,
        finalExpectation: 3.9
      }]
    },
    {
      kind: 'SCOPED_REVISION_TRACE',
      requestedSession: 'S1',
      updates: [{ session: 'S1', item: 'x', revision: '1', state: 'done' }],
      currentOutput: ['x'],
      requiredOutput: ['x'],
      repair: {
        scopeUpdatesToRequestedSessionBeforeLatestSelection: true,
        compareRevisionsAsExactNonnegativeIntegers: true
      }
    },
    {
      kind: 'RUN_PROJECTION_TRACES',
      activeRunId: 'R1',
      traces: [{
        name: 'complete',
        events: [['R1', 1, 'provider-completed']],
        current: 'completed',
        required: 'completed'
      }],
      repair: {
        scopeOrdinalFilteringToActiveRun: true,
        treatProviderCompletionAsTelemetryOnly: true,
        deriveStatusAfterEvidenceAccumulation: true
      }
    },
    {
      kind: 'IDEMPOTENT_CREATE_CRASH_TABLE',
      durableKeyBeforeCall: true,
      sameKeyOnRecovery: true,
      providerIdempotentByKey: true,
      providerLookupByKey: true,
      workflowRequiresLocalVerification: true,
      crashScenarios: [{
        providerCreateAppliedBeforeCrash: false,
        createReplyReceivedBeforeCrash: false,
        remoteIdPersistedBeforeCrash: false,
        recoveryContactsProvider: true,
        recoveryUsesPersistedKey: true,
        atMostOneRemoteTurn: true,
        remoteIdEventuallyRecoverable: true
      }]
    },
    {
      kind: 'INDISTINGUISHABLE_CRASH_WORLDS',
      worlds: [{ name: 'w0', durableLocalState: 'same', providerAppliedCount: 0 }],
      recoveryChoices: [{
        choice: 'retry', sendsInterrupt: true, violates: 'SAFETY', world: 'w1'
      }]
    }
  ];
}

function allObjectSchemasAreClosed(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(allObjectSchemasAreClosed);
  if (typeof value !== 'object' || value === null) return true;
  const record = value as Record<string, unknown>;
  if (record.type === 'object' && record.additionalProperties !== false) return false;
  return Object.values(record).every(allObjectSchemasAreClosed);
}

function schemaContainsKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => schemaContainsKeyword(item, keyword));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, keyword) ||
    Object.values(record).some((item) => schemaContainsKeyword(item, keyword));
}

function strictStructuredOutputSchemaErrors(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => strictStructuredOutputSchemaErrors(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (record.type === 'object') {
    const properties = record.properties;
    if (record.additionalProperties !== false) errors.push(`${path} must be closed`);
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      errors.push(`${path} must declare properties`);
    } else {
      const propertyKeys = Object.keys(properties);
      const required = Array.isArray(record.required)
        ? record.required.filter((key): key is string => typeof key === 'string')
        : [];
      for (const key of propertyKeys) if (!required.includes(key)) errors.push(`${path}.${key}`);
      for (const key of required) if (!propertyKeys.includes(key)) errors.push(`${path}.required.${key}`);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    errors.push(...strictStructuredOutputSchemaErrors(child, `${path}.${key}`));
  }
  return errors;
}

function artifact(
  artifactId: HardPeer80VisibleArtifact['artifactId'],
  artifactKind: HardPeer80VisibleArtifact['artifactKind'],
  actor: HardPeer80VisibleArtifact['actor'],
  output: HardPeer80PublicOutput
): HardPeer80VisibleArtifact {
  return { artifactId, artifactKind, actor, output };
}

function context(
  stage: HardPeer80ValidationContext['stage'],
  currentArtifactId: HardPeer80ValidationContext['currentArtifactId'],
  visibleArtifacts: readonly HardPeer80VisibleArtifact[] = []
): HardPeer80ValidationContext {
  return { participantCase: participantCase(), stage, currentArtifactId, visibleArtifacts };
}
