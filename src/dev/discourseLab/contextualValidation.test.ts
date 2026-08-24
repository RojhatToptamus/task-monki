import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabArtifactRecord,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import {
  createLabOutputRecord,
  validateLabPublicOutputContext,
  type LabPublicOutputValidationContext
} from './outputValidation';
import { getLabProtocolPlan } from './protocols';
import { runLabProtocol } from './runner';
import { ScriptedLabTextDriver } from './textDriver';

describe('Discourse Protocol Lab contextual output validation', () => {
  it('accepts only case, intervention, and exact visible-trajectory references', () => {
    const output = validOutput();
    const context = validationContext();
    expect(validateLabPublicOutputContext(output, context)).toEqual([]);

    const cases: Array<{
      mutate: (candidate: LabPublicOutput) => void;
      path: string;
    }> = [
      {
        mutate: (candidate) => candidate.answer.selectedOptionIds.splice(0, 1, 'unknown-option'),
        path: '$.answer.selectedOptionIds[0]'
      },
      {
        mutate: (candidate) => { candidate.claims[0]!.propositionId = 'unknown-proposition'; },
        path: '$.claims[0].propositionId'
      },
      {
        mutate: (candidate) => { candidate.claims[0]!.topicId = 'unknown-topic'; },
        path: '$.claims[0].topicId'
      },
      {
        mutate: (candidate) => { candidate.claims[0]!.evidence[0]!.evidenceId = 'invented-source'; },
        path: '$.claims[0].evidence[0].evidenceId'
      },
      {
        mutate: (candidate) => { candidate.issues[0]!.targetArtifactId = 'hidden-artifact'; },
        path: '$.issues[0].targetArtifactId'
      },
      {
        mutate: (candidate) => { candidate.issues[0]!.targetPropositionId = 'unknown-proposition'; },
        path: '$.issues[0].targetPropositionId'
      },
      {
        mutate: (candidate) => { candidate.responses[0]!.targetIssueId = 'issue-from-elsewhere'; },
        path: '$.responses[0].targetIssueId'
      },
      {
        mutate: (candidate) => { candidate.responses[0]!.changedClaimIds = ['prior-claim']; },
        path: '$.responses[0].changedClaimIds[0]'
      },
      {
        mutate: (candidate) => { candidate.disagreements[0]!.participantArtifactIds = ['hidden-artifact']; },
        path: '$.disagreements[0].participantArtifactIds[0]'
      },
      {
        mutate: (candidate) => { candidate.disagreements[0]!.propositionIds = ['unknown-proposition']; },
        path: '$.disagreements[0].propositionIds[0]'
      },
      {
        mutate: (candidate) => { candidate.resolution.resolvedIssueIds = ['invented-issue']; },
        path: '$.resolution.resolvedIssueIds[0]'
      },
      {
        mutate: (candidate) => { candidate.userQuestions[0]!.propositionIds = ['unknown-proposition']; },
        path: '$.userQuestions[0].propositionIds[0]'
      }
    ];

    for (const testCase of cases) {
      const candidate = structuredClone(output);
      testCase.mutate(candidate);
      expect(validateLabPublicOutputContext(candidate, context)).toContainEqual(
        expect.objectContaining({ path: testCase.path, code: 'INVALID_REFERENCE' })
      );
    }
  });

  it('requires one claim for every case proposition and rejects contradictory issue resolution', () => {
    const output = validOutput();
    output.claims.pop();
    output.resolution.resolvedIssueIds.push('local-issue');

    const errors = validateLabPublicOutputContext(output, validationContext());
    expect(errors).toContainEqual(
      expect.objectContaining({ path: '$.claims', code: 'MISSING_FIELD' })
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: '$.resolution.unresolvedIssueIds[0]',
        code: 'INVALID_REFERENCE'
      })
    );
  });

  it('permits explicit intervention evidence and atomic critique artifact ids', () => {
    const output = validOutput();
    output.claims[0]!.evidence = [
      { evidenceId: 'signal-1', relation: 'LIMITS', note: 'The public signal.' },
      { evidenceId: 'external-evidence-1', relation: 'SUPPORTS', note: 'Its evidence payload.' }
    ];
    output.responses[0] = {
      id: 'response-1',
      targetArtifactId: 'signal-1',
      targetIssueId: 'signal-issue-1',
      disposition: 'PARTIAL',
      statement: 'The supplied critique is only partly supported.',
      evidence: [{ evidenceId: 'signal-1', relation: 'LIMITS', note: 'Signal text.' }],
      changedClaimIds: ['claim-1']
    };

    expect(validateLabPublicOutputContext(output, validationContext())).toEqual([]);
  });
});

describe('Discourse Protocol Lab contextual repair integration', () => {
  it('charges one repair for a contextual-invalid primary before accepting semantic output', async () => {
    const participantCase = testParticipantCase();
    const valid = simpleOutput(participantCase);
    const invalid = structuredClone(valid);
    invalid.claims[0]!.evidence[0]!.evidenceId = 'invented-source';
    const driver = new ScriptedLabTextDriver((_call, index) =>
      JSON.stringify(index === 0 ? invalid : valid)
    );
    const run = await runLabProtocol({
      participantCase,
      plan: getLabProtocolPlan('CONTROL_VALID_CRITIQUE_B1'),
      driver,
      intervention: testIntervention(),
      modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
      limits: runnerLimits()
    });
    await driver.close();

    const providerArtifact = run.artifacts.at(-1)!;
    expect(run.status).toBe('COMPLETED');
    expect(run.realizedBudget.dispatchedCalls).toBe(2);
    expect(providerArtifact.output).toMatchObject({
      status: 'VALID',
      acceptedAttemptNumber: 2,
      repairAttempted: true
    });
    expect(providerArtifact.output.attempts[0]!.validationErrors).toContainEqual(
      expect.objectContaining({
        path: '$.claims[0].evidence[0].evidenceId',
        code: 'INVALID_REFERENCE'
      })
    );
  });

  it('keeps a contextual-invalid repair invalid and stops finitely', async () => {
    const participantCase = testParticipantCase();
    const invalid = simpleOutput(participantCase);
    invalid.answer.selectedOptionIds = ['invented-option'];
    const driver = new ScriptedLabTextDriver(() => JSON.stringify(invalid));
    const run = await runLabProtocol({
      participantCase,
      plan: getLabProtocolPlan('CONTROL_VALID_CRITIQUE_B1'),
      driver,
      intervention: testIntervention(),
      modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
      limits: runnerLimits()
    });
    await driver.close();

    expect(run).toMatchObject({
      status: 'FAILED',
      stopReason: 'SCHEMA_FAILURE_AFTER_REPAIR',
      realizedBudget: { dispatchedCalls: 2 }
    });
    expect(run.artifacts.at(-1)!.output).toMatchObject({
      status: 'INVALID',
      acceptedAttemptNumber: null,
      repairAttempted: true
    });
  });
});

function validationContext(): LabPublicOutputValidationContext {
  return {
    participantCase: testParticipantCase(),
    visibleArtifacts: [visibleArtifact()],
    intervention: testIntervention()
  };
}

function testParticipantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'context-case',
    question: 'Assess both propositions using only the supplied evidence.',
    evidence: [{ id: 'e1', text: 'Public evidence.' }],
    propositions: [
      { id: 'p1', topicId: 'topic-main', text: 'The first proposition.' },
      { id: 'p2', topicId: 'topic-main', text: 'The second proposition.' }
    ],
    options: [{ id: 'option-1', text: 'The supplied option.' }],
    topics: [{ id: 'topic-main', label: 'Main topic' }]
  };
}

function validOutput(): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'NEEDS_USER_INPUT',
    answer: { summary: 'The evidence leaves one decision open.', values: [], selectedOptionIds: ['option-1'] },
    claims: [
      {
        id: 'claim-1',
        propositionId: 'p1',
        topicId: 'topic-main',
        stance: 'ACCEPT',
        statement: 'The first proposition is supported.',
        evidence: [{ evidenceId: 'e1', relation: 'SUPPORTS', note: 'Public evidence.' }],
        assumptionIds: [],
        confidence: 0.8
      },
      {
        id: 'claim-2',
        propositionId: 'p2',
        topicId: 'topic-main',
        stance: 'OPEN',
        statement: 'The second proposition remains open.',
        evidence: [{ evidenceId: 'PROMPT', relation: 'LIMITS', note: 'The question is bounded.' }],
        assumptionIds: [],
        confidence: 0.4
      }
    ],
    assumptions: [],
    issues: [
      {
        id: 'local-issue',
        targetArtifactId: 'visible-a',
        targetPropositionId: 'p2',
        kind: 'MISSING_INFORMATION',
        severity: 'MATERIAL',
        statement: 'The visible answer assumes missing information.',
        evidence: [{ evidenceId: 'PROMPT', relation: 'LIMITS', note: 'No preference is given.' }],
        confidence: 0.8
      }
    ],
    responses: [
      {
        id: 'response-1',
        targetArtifactId: 'visible-a',
        targetIssueId: 'visible-issue',
        disposition: 'ACCEPT',
        statement: 'The visible issue is accepted.',
        evidence: [{ evidenceId: 'e1', relation: 'SUPPORTS', note: 'Public evidence.' }],
        changedClaimIds: ['claim-2']
      }
    ],
    disagreements: [
      {
        id: 'disagreement-1',
        propositionIds: ['p1', 'p2'],
        participantArtifactIds: ['visible-a', 'CASE'],
        status: 'NEEDS_USER_INPUT',
        summary: 'The evidence does not settle the choice.',
        evidence: [{ evidenceId: 'e1', relation: 'LIMITS', note: 'The evidence is incomplete.' }],
        cruxId: 'u1'
      }
    ],
    resolution: {
      status: 'PARTIALLY_RESOLVED',
      basis: 'INSUFFICIENT_INFORMATION',
      summary: 'One issue is resolved and one remains open.',
      resolvedIssueIds: ['visible-issue'],
      unresolvedIssueIds: ['local-issue']
    },
    userQuestions: [
      {
        id: 'question-1',
        cruxId: 'u1',
        question: 'Which unresolved proposition should control?',
        propositionIds: ['p2']
      }
    ],
    confidence: 0.7
  };
}

function simpleOutput(participantCase: LabParticipantCase): LabPublicOutput {
  const output = validOutput();
  output.answer.selectedOptionIds = [];
  output.issues = [];
  output.responses = [];
  output.disagreements = [];
  output.resolution = {
    status: 'NO_DISAGREEMENT',
    basis: 'NO_MATERIAL_ISSUE',
    summary: 'No material issue remains.',
    resolvedIssueIds: [],
    unresolvedIssueIds: []
  };
  output.userQuestions = [];
  output.claims = participantCase.propositions.map((proposition, index) => ({
    id: `claim-${index + 1}`,
    propositionId: proposition.id,
    topicId: proposition.topicId,
    stance: 'ACCEPT',
    statement: proposition.text,
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The public question.' }],
    assumptionIds: [],
    confidence: 0.7
  }));
  return output;
}

function visibleArtifact(): LabArtifactRecord {
  const output = simpleOutput(testParticipantCase());
  output.issues = [
    {
      id: 'visible-issue',
      targetArtifactId: 'CASE',
      targetPropositionId: 'p2',
      kind: 'MISSING_INFORMATION',
      severity: 'MATERIAL',
      statement: 'More information is needed.',
      evidence: [],
      confidence: 0.7
    }
  ];
  return {
    artifactId: 'visible-a',
    actorId: 'A',
    stage: 'MAP',
    parentArtifactIds: [],
    output: createLabOutputRecord({ callId: 'visible-a', rawText: JSON.stringify(output) })
  };
}

function testIntervention() {
  return {
    bundleId: 'context-bundle',
    variantId: 'context-variant',
    fixedInitial: {
      artifactId: 'fixed-initial',
      answer: 'Initial answer.',
      status: 'ANSWER',
      assessments: [
        { claimId: 'p1', stance: 'ACCEPT' },
        { claimId: 'p2', stance: 'OPEN' }
      ]
    },
    signalKind: 'EVIDENCE_PACKET',
    artifacts: [
      {
        artifactId: 'signal-1',
        evidenceId: 'external-evidence-1',
        issueId: 'signal-issue-1',
        text: 'A supplied public signal.'
      }
    ]
  };
}

function runnerLimits() {
  return {
    maximumCalls: 2,
    maximumRounds: 1,
    maximumInputTokensPerCall: 7_000,
    maximumObservedTotalTokens: 20_000,
    maximumCallMs: 2_000,
    maximumExperimentMs: 10_000,
    maximumConcurrency: 1
  };
}
