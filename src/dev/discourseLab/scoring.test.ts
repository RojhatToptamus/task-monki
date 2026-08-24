import { describe, expect, it } from 'vitest';
import {
  LAB_ORACLE_CASE_SCHEMA_VERSION,
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabArtifactRecord,
  type LabOracleCase,
  type LabOutputAttemptInput,
  type LabParticipantCase,
  type LabPublicIssue,
  type LabPublicOutput,
  type LabTrajectoryForScoring
} from './contracts';
import {
  LAB_PUBLIC_OUTPUT_JSON_SCHEMA,
  createLabOutputRecord,
  validateLabCasePair,
  validateLabOracleCase,
  validateLabParticipantCase,
  validateLabPublicOutput
} from './outputValidation';
import { scoreLabArtifact, scoreLabTrajectory } from './scoring';

describe('Discourse Protocol Lab public output contract', () => {
  it('uses a provider-strict schema for every nested object', () => {
    expect(strictStructuredOutputSchemaErrors(LAB_PUBLIC_OUTPUT_JSON_SCHEMA)).toEqual([]);
  });

  it('represents an absent disagreement crux as required null, not an omitted property', () => {
    const output = pluralisticOutput();
    output.disagreements[0]!.cruxId = null;
    expect(validateLabPublicOutput(output)).toEqual({ ok: true, value: output });

    const missingCrux = structuredClone(output) as unknown as {
      disagreements: Array<{ cruxId?: string | null }>;
    };
    delete missingCrux.disagreements[0]!.cruxId;
    const result = validateLabPublicOutput(missingCrux);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.disagreements[0].cruxId', code: 'MISSING_FIELD' })
      );
    }
  });

  it('accepts concise auditable fields and rejects hidden-reasoning or unknown fields', () => {
    const output = publicOutput('ACCEPT');
    expect(validateLabPublicOutput(output)).toEqual({ ok: true, value: output });

    const withReasoning = { ...output, reasoning: 'private scratch work' };
    const result = validateLabPublicOutput(withReasoning);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: '$.reasoning', code: 'UNKNOWN_FIELD' })
      );
    }
  });

  it('validates local claim and assumption references', () => {
    const output = publicOutput('ACCEPT');
    output.claims[0].assumptionIds = ['missing-assumption'];
    const result = validateLabPublicOutput(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'INVALID_REFERENCE' })
      );
    }
  });

  it('retains a failed raw primary attempt and charges one successful repair', () => {
    const primary = attempt('primary', 'not json', 7, 15);
    const repair = attempt('repair', JSON.stringify(publicOutput('ACCEPT')), 11, 21);

    const record = createLabOutputRecord(primary, repair);

    expect(record).toMatchObject({
      status: 'VALID',
      acceptedAttemptNumber: 2,
      chargedCalls: 2,
      repairAttempted: true
    });
    expect(record.attempts[0]).toMatchObject({
      rawText: 'not json',
      charged: true,
      purpose: 'PRIMARY',
      validationErrors: [expect.objectContaining({ code: 'INVALID_JSON' })]
    });
    expect(record.attempts[1]).toMatchObject({
      charged: true,
      purpose: 'SCHEMA_REPAIR',
      output: expect.objectContaining({ schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION })
    });
  });

  it('does not permit a gratuitous repair after a valid primary output', () => {
    const valid = attempt('primary', JSON.stringify(publicOutput('ACCEPT')), 4, 8);
    expect(() => createLabOutputRecord(valid, valid)).toThrow(
      'must not run after a valid primary output'
    );
  });

  it('does not permit an uncharged schema-repair call', () => {
    const repair = {
      ...attempt('repair', JSON.stringify(publicOutput('ACCEPT')), 4, 8),
      charged: false
    };
    expect(() => createLabOutputRecord({ callId: 'primary', rawText: 'broken' }, repair)).toThrow(
      'must be charged'
    );
  });
});

function strictStructuredOutputSchemaErrors(
  schema: unknown,
  path = '$'
): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const errors: string[] = [];
  const objectType = node.type === 'object' ||
    (Array.isArray(node.type) && node.type.includes('object'));
  const properties = node.properties;
  if (objectType) {
    if (node.additionalProperties !== false) {
      errors.push(`${path} must set additionalProperties:false`);
    }
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      errors.push(`${path} must declare object properties`);
    } else {
      const propertyKeys = Object.keys(properties);
      const required = Array.isArray(node.required)
        ? node.required.filter((key): key is string => typeof key === 'string')
        : [];
      for (const key of propertyKeys) {
        if (!required.includes(key)) errors.push(`${path}.required is missing ${key}`);
      }
      for (const key of required) {
        if (!propertyKeys.includes(key)) errors.push(`${path}.required has unknown ${key}`);
      }
    }
  }
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      errors.push(...strictStructuredOutputSchemaErrors(child, `${path}.properties.${key}`));
    }
  }
  if ('items' in node) {
    errors.push(...strictStructuredOutputSchemaErrors(node.items, `${path}.items`));
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = node[keyword];
    if (!Array.isArray(variants)) continue;
    variants.forEach((variant, index) => {
      errors.push(...strictStructuredOutputSchemaErrors(variant, `${path}.${keyword}[${index}]`));
    });
  }
  return errors;
}

describe('Discourse Protocol Lab corpus firewall', () => {
  it('validates participant and scorer-only fixtures independently', () => {
    expect(validateLabParticipantCase(participantCase()).ok).toBe(true);
    expect(validateLabOracleCase(objectiveOracle()).ok).toBe(true);
    expect(validateLabCasePair(participantCase(), objectiveOracle())).toEqual([]);
  });

  it('rejects oracle references that are absent from the participant fixture', () => {
    const oracle = objectiveOracle();
    oracle.propositionExpectations[0].requiredEvidenceSets = [['hidden-answer']];
    expect(validateLabCasePair(participantCase(), oracle)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_REFERENCE' })
    );
  });
});

describe('Discourse Protocol Lab deterministic scoring', () => {
  it('scores correctness, support, wrong-to-right correction, and shared-error discovery', () => {
    const first = artifact('a', publicOutput('REJECT', { selectedOptionIds: ['wrong'] }));
    const second = artifact('b', publicOutput('REJECT', { selectedOptionIds: ['wrong'] }));
    const final = artifact('c', publicOutput('ACCEPT'));
    const score = scoreLabTrajectory(
      trajectory([first, second, final], ['a', 'b'], 'c', [
        { fromArtifactId: 'a', toArtifactId: 'c' },
        { fromArtifactId: 'b', toArtifactId: 'c' }
      ])
    );

    expect(score.wrongToRightCorrection).toEqual({ count: 2, opportunities: 2, rate: 1 });
    expect(score.rightToWrongContamination).toEqual({
      count: 0,
      opportunities: 0,
      rate: null
    });
    expect(score.sharedErrorDiscovery).toEqual({ count: 1, opportunities: 1, rate: 1 });
    expect(score.outputs.find((output) => output.artifactId === 'c')).toMatchObject({
      answerCorrect: true,
      statusAccepted: true,
      claimCorrectness: { count: 1, opportunities: 1, rate: 1 },
      evidentialSupport: { count: 1, opportunities: 1, rate: 1 }
    });
    expect(score.totalChargedCalls).toBe(3);
    expect(score.totalInputTokens).toBe(15);
    expect(score.totalOutputTokens).toBe(30);
    expect(score.totalLatencyMs).toBe(60);
  });

  it('measures right-to-wrong contamination separately from correction', () => {
    const correct = artifact('before', publicOutput('ACCEPT'));
    const contaminated = artifact(
      'after',
      publicOutput('REJECT', { selectedOptionIds: ['wrong'] })
    );
    const score = scoreLabTrajectory(
      trajectory([correct, contaminated], ['before'], 'after', [
        { fromArtifactId: 'before', toArtifactId: 'after' }
      ])
    );

    expect(score.rightToWrongContamination).toEqual({
      count: 1,
      opportunities: 1,
      rate: 1
    });
    expect(score.wrongToRightCorrection.opportunities).toBe(0);
  });

  it('uses sealed fixtures in transitions without charging them as provider calls', () => {
    const sealedInitial = artifact(
      'sealed-initial',
      publicOutput('REJECT', { selectedOptionIds: ['wrong'] }),
      { includeUsage: false, charged: false }
    );
    const providerResponse = artifact('provider-response', publicOutput('ACCEPT'));
    const score = scoreLabTrajectory(
      trajectory([sealedInitial, providerResponse], ['sealed-initial'], 'provider-response', [
        { fromArtifactId: 'sealed-initial', toArtifactId: 'provider-response' }
      ])
    );

    expect(sealedInitial.output.chargedCalls).toBe(0);
    expect(score.wrongToRightCorrection).toEqual({ count: 1, opportunities: 1, rate: 1 });
    expect(score.totalChargedCalls).toBe(1);
    expect(score.totalTokens).toBe(15);
  });

  it('records a failed transition call without inventing a semantic opportunity', () => {
    const failed = failedArtifact('failed-source');
    const terminal = artifact('terminal', publicOutput('ACCEPT'));
    const score = scoreLabTrajectory(
      trajectory([failed, terminal], ['failed-source'], 'terminal', [
        { fromArtifactId: 'failed-source', toArtifactId: 'terminal' }
      ])
    );

    expect(score.wrongToRightCorrection.opportunities).toBe(0);
    expect(score.rightToWrongContamination.opportunities).toBe(0);
    expect(score.failureCount).toBe(1);
    expect(score.outputs.find((item) => item.artifactId === 'failed-source')).toMatchObject({
      answerCorrect: null,
      statusAccepted: null,
      claimCorrectness: { count: 0, opportunities: 0, rate: null },
      evidentialSupport: { count: 0, opportunities: 0, rate: null },
      inventedCriticism: { count: 0, opportunities: 0, rate: null }
    });
  });

  it('measures correct-minority preservation without treating a tie as a minority', () => {
    const minority = artifact('minority', publicOutput('ACCEPT'));
    const wrong1 = artifact('wrong-1', publicOutput('REJECT'));
    const wrong2 = artifact('wrong-2', publicOutput('REJECT'));
    const final = artifact('final', publicOutput('ACCEPT'));
    const score = scoreLabTrajectory(
      trajectory([minority, wrong1, wrong2, final], ['minority', 'wrong-1', 'wrong-2'], 'final')
    );

    expect(score.correctMinorityPreservation).toEqual({
      count: 1,
      opportunities: 1,
      rate: 1
    });
  });

  it('does not let blind samples count themselves as a preserved minority', () => {
    const minority = artifact('minority', publicOutput('ACCEPT'));
    const wrong1 = artifact('wrong-1', publicOutput('REJECT'));
    const wrong2 = artifact('wrong-2', publicOutput('REJECT'));
    const input = trajectory(
      [minority, wrong1, wrong2],
      ['minority', 'wrong-1', 'wrong-2'],
      'minority'
    );
    input.terminalArtifactIds = ['minority', 'wrong-1', 'wrong-2'];

    expect(scoreLabTrajectory(input).correctMinorityPreservation).toEqual({
      count: 0,
      opportunities: 0,
      rate: null
    });
  });

  it('scores invented criticism, topic drift, exact repetition, and schema failures', () => {
    const validIssue = issue('valid', 'LOGIC', 'This inference reverses the implication.');
    const inventedIssue = issue('invented', 'FACTUAL', 'The supplied arithmetic is false.');
    const firstOutput = publicOutput('ACCEPT', { issues: [validIssue, inventedIssue] });
    const secondOutput = publicOutput('ACCEPT', { issues: [validIssue] });
    secondOutput.claims[0].topicId = 'off-topic';
    const first = artifact('first', firstOutput);
    const second = artifact('second', secondOutput);
    const score = scoreLabTrajectory(trajectory([first, second], ['first'], 'second'));

    expect(score.outputs[0].inventedCriticism).toEqual({
      count: 1,
      opportunities: 2,
      rate: 0.5
    });
    expect(score.outputs[1].drift).toEqual({ count: 1, opportunities: 1, rate: 1 });
    expect(score.repeatedCriticism).toEqual({ count: 1, opportunities: 3, rate: 1 / 3 });

    const failed = failedArtifact('failed');
    expect(scoreLabArtifact(failed, trajectory([], [], 'unused'))).toMatchObject({
      validOutput: false,
      failureCount: 1,
      invalidAttemptCount: 1
    });
  });

  it('does not count a cited evidence id as support for an incorrect stance or topic', () => {
    const incorrect = publicOutput('REJECT');
    const wrongTopic = publicOutput('ACCEPT');
    wrongTopic.claims[0]!.topicId = 'off-topic';

    expect(scoreLabArtifact(artifact('incorrect', incorrect), trajectory([], [], 'unused')))
      .toMatchObject({ evidentialSupport: { count: 0, opportunities: 1, rate: 0 } });
    expect(scoreLabArtifact(artifact('wrong-topic', wrongTopic), trajectory([], [], 'unused')))
      .toMatchObject({ evidentialSupport: { count: 0, opportunities: 1, rate: 0 } });
  });

  it('scores missing-information abstention, a user crux, and preserved pluralism', () => {
    const participant = pluralisticParticipantCase();
    const oracle = pluralisticOracle();
    const output = pluralisticOutput();
    const final = artifact('plural-final', output);
    const input: LabTrajectoryForScoring = {
      participantCase: participant,
      oracleCase: oracle,
      artifacts: [final],
      initialArtifactIds: [],
      terminalArtifactIds: [final.artifactId],
      transitionLinks: []
    };
    const score = scoreLabTrajectory(input);
    const finalScore = score.outputs[0];

    expect(finalScore).toMatchObject({
      statusAccepted: true,
      abstained: false,
      uncertaintyExpressed: true,
      disagreementPreservation: { count: 1, opportunities: 1, rate: 1 },
      requiredUserQuestionCoverage: { count: 1, opportunities: 1, rate: 1 }
    });
    expect(score.terminalDisagreementPreservation.rate).toBe(1);
  });

  it('reports usage as unknown instead of silently undercounting partial telemetry', () => {
    const known = artifact('known', publicOutput('ACCEPT'));
    const unknown = artifact('unknown', publicOutput('ACCEPT'), { includeUsage: false });
    const score = scoreLabTrajectory(trajectory([known, unknown], ['known'], 'unknown'));
    expect(score.totalInputTokens).toBeNull();
    expect(score.totalOutputTokens).toBeNull();
    expect(score.totalLatencyMs).toBeNull();
  });
});

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'case-objective',
    question: 'Which option follows from the supplied fact?',
    evidence: [{ id: 'e1', text: 'The supplied fact supports the first option.' }],
    propositions: [{ id: 'p1', topicId: 'topic-main', text: 'The first option follows.' }],
    options: [
      { id: 'correct', text: 'First option' },
      { id: 'wrong', text: 'Second option' }
    ],
    topics: [{ id: 'topic-main', label: 'Main question' }]
  };
}

function objectiveOracle(): LabOracleCase {
  return {
    schemaVersion: LAB_ORACLE_CASE_SCHEMA_VERSION,
    caseId: 'case-objective',
    partition: 'DEVELOPMENT',
    domain: 'logic',
    evaluationKind: 'OBJECTIVE',
    mechanismTags: ['known-answer', 'shared-error'],
    acceptableStatuses: ['ANSWER'],
    acceptedAnswerValueSets: [['first']],
    acceptedAnswerOptionSets: [['correct']],
    propositionExpectations: [
      {
        propositionId: 'p1',
        acceptableStances: ['ACCEPT'],
        requiredEvidenceSets: [['e1']]
      }
    ],
    validCritiques: [
      { targetPropositionId: 'p1', kinds: ['LOGIC'], severities: ['MATERIAL'] }
    ],
    sharedErrorPropositionIds: ['p1'],
    disagreementRequirements: [],
    requiredUserQuestionCruxIds: []
  };
}

function pluralisticParticipantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'case-plural',
    question: 'Choose a plan. Reliability and price preferences are not supplied.',
    evidence: [
      { id: 'price', text: 'Plan A costs less.' },
      { id: 'reliability', text: 'Plan B has stronger reliability evidence.' }
    ],
    propositions: [
      { id: 'choose-a', topicId: 'choice', text: 'Plan A is preferable.' },
      { id: 'choose-b', topicId: 'choice', text: 'Plan B is preferable.' }
    ],
    options: [
      { id: 'ask-user', text: 'Ask which tradeoff matters more.' },
      { id: 'plan-a', text: 'Plan A' },
      { id: 'plan-b', text: 'Plan B' }
    ],
    topics: [{ id: 'choice', label: 'Plan choice' }]
  };
}

function pluralisticOracle(): LabOracleCase {
  return {
    schemaVersion: LAB_ORACLE_CASE_SCHEMA_VERSION,
    caseId: 'case-plural',
    partition: 'DEVELOPMENT',
    domain: 'decision',
    evaluationKind: 'PLURALISTIC',
    mechanismTags: ['multiple-defensible', 'missing-information'],
    acceptableStatuses: ['MULTIPLE_DEFENSIBLE', 'NEEDS_USER_INPUT'],
    acceptedAnswerValueSets: [],
    acceptedAnswerOptionSets: [['ask-user']],
    propositionExpectations: [
      { propositionId: 'choose-a', acceptableStances: ['OPEN'], requiredEvidenceSets: [['price']] },
      {
        propositionId: 'choose-b',
        acceptableStances: ['OPEN'],
        requiredEvidenceSets: [['reliability']]
      }
    ],
    validCritiques: [],
    sharedErrorPropositionIds: [],
    disagreementRequirements: [
      {
        propositionIds: ['choose-a', 'choose-b'],
        acceptableStatuses: ['COMPATIBLE_DIFFERENCE', 'NEEDS_USER_INPUT'],
        requiredCruxId: 'priority'
      }
    ],
    requiredUserQuestionCruxIds: ['priority']
  };
}

function publicOutput(
  stance: 'ACCEPT' | 'REJECT',
  overrides: {
    selectedOptionIds?: string[];
    issues?: LabPublicIssue[];
  } = {}
): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: {
      summary: stance === 'ACCEPT' ? 'The first option follows.' : 'The second option follows.',
      values: stance === 'ACCEPT' ? [' First '] : ['second'],
      selectedOptionIds: overrides.selectedOptionIds ?? ['correct']
    },
    claims: [
      {
        id: 'claim-1',
        propositionId: 'p1',
        topicId: 'topic-main',
        stance,
        statement: 'Assessment of the first option.',
        evidence: [{ evidenceId: 'e1', relation: 'SUPPORTS', note: 'The supplied fact.' }],
        assumptionIds: [],
        confidence: 0.8
      }
    ],
    assumptions: [],
    issues: overrides.issues ?? [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'EVIDENCE',
      summary: 'The supplied fact decides the question.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.8
  };
}

function pluralisticOutput(): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'MULTIPLE_DEFENSIBLE',
    answer: {
      summary: 'The missing priority determines the choice.',
      values: [],
      selectedOptionIds: ['ask-user']
    },
    claims: [
      {
        id: 'claim-a',
        propositionId: 'choose-a',
        topicId: 'choice',
        stance: 'OPEN',
        statement: 'Plan A is defensible when price matters more.',
        evidence: [{ evidenceId: 'price', relation: 'SUPPORTS', note: 'Plan A costs less.' }],
        assumptionIds: ['priority-assumption'],
        confidence: 0.7
      },
      {
        id: 'claim-b',
        propositionId: 'choose-b',
        topicId: 'choice',
        stance: 'OPEN',
        statement: 'Plan B is defensible when reliability matters more.',
        evidence: [
          { evidenceId: 'reliability', relation: 'SUPPORTS', note: 'Plan B is better supported.' }
        ],
        assumptionIds: ['priority-assumption'],
        confidence: 0.7
      }
    ],
    assumptions: [
      {
        id: 'priority-assumption',
        statement: 'The user has a price-versus-reliability preference.',
        status: 'REQUIRED',
        affectsClaimIds: ['claim-a', 'claim-b']
      }
    ],
    issues: [],
    responses: [],
    disagreements: [
      {
        id: 'tradeoff',
        propositionIds: ['choose-a', 'choose-b'],
        participantArtifactIds: ['peer-a', 'peer-b'],
        status: 'NEEDS_USER_INPUT',
        summary: 'Both plans are defensible under different priorities.',
        evidence: [],
        cruxId: 'priority'
      }
    ],
    resolution: {
      status: 'NEEDS_USER_INPUT',
      basis: 'PREFERENCE',
      summary: 'Evidence cannot determine the user preference.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [
      {
        id: 'question-priority',
        cruxId: 'priority',
        question: 'Do you value lower price or stronger reliability more?',
        propositionIds: ['choose-a', 'choose-b']
      }
    ],
    confidence: 0.85
  };
}

function issue(id: string, kind: 'LOGIC' | 'FACTUAL', statement: string): LabPublicIssue {
  return {
    id,
    targetArtifactId: 'peer',
    targetPropositionId: 'p1',
    kind,
    severity: 'MATERIAL',
    statement,
    evidence: [],
    confidence: 0.75
  };
}

function artifact(
  artifactId: string,
  output: LabPublicOutput,
  options: { includeUsage?: boolean; charged?: boolean } = {}
): LabArtifactRecord {
  const includeUsage = options.includeUsage !== false;
  return {
    artifactId,
    actorId: artifactId,
    stage: 'synthetic',
    parentArtifactIds: [],
    output: createLabOutputRecord({
      callId: `call-${artifactId}`,
      rawText: JSON.stringify(output),
      charged: options.charged,
      usage: includeUsage
        ? { inputTokens: 5, outputTokens: 10, reasoningTokens: 2, totalTokens: 15 }
        : undefined,
      latencyMs: includeUsage ? 20 : undefined
    })
  };
}

function failedArtifact(artifactId: string): LabArtifactRecord {
  return {
    artifactId,
    actorId: artifactId,
    stage: 'synthetic',
    parentArtifactIds: [],
    output: createLabOutputRecord({ callId: `call-${artifactId}`, rawText: '{broken' })
  };
}

function attempt(
  callId: string,
  rawText: string,
  inputTokens: number,
  outputTokens: number
): LabOutputAttemptInput {
  return {
    callId,
    rawText,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: 1,
      totalTokens: inputTokens + outputTokens
    },
    latencyMs: 10
  };
}

function trajectory(
  artifacts: LabArtifactRecord[],
  initialArtifactIds: string[],
  finalArtifactId: string,
  transitionLinks: LabTrajectoryForScoring['transitionLinks'] = []
): LabTrajectoryForScoring {
  return {
    participantCase: participantCase(),
    oracleCase: objectiveOracle(),
    artifacts,
    initialArtifactIds,
    terminalArtifactIds: [finalArtifactId],
    transitionLinks
  };
}
