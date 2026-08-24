import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  type LabParticipantCase,
  type LabValidationError
} from './contracts';
import type { HardPeer80Certificate } from './hardPeer80Corpus';
import { validateJsonSchema } from './outputV3';

export const HARD_PEER_80_OUTPUT_SCHEMA_VERSION =
  'task-monki/discourse-lab-hard-peer-80-output@v4' as const;

export type HardPeer80Stage =
  | 'PROBE'
  | 'INITIAL'
  | 'WORKBENCH_1'
  | 'WORKBENCH_FINAL'
  | 'SELF_REVIEW'
  | 'SELF_FINAL'
  | 'PEER_CRITIQUE'
  | 'AUTHOR_RESPONSE';

export type HardPeer80AnswerStatus =
  | 'ANSWER'
  | 'UNCERTAIN'
  | 'ABSTAIN'
  | 'NEEDS_USER_INPUT'
  | 'MULTIPLE_DEFENSIBLE';

export interface HardPeer80EvidenceReference {
  evidenceId: string;
  relation: 'SUPPORTS' | 'CONTRADICTS' | 'LIMITS';
  note: string;
}

export type HardPeer80TargetComponent =
  | 'PROPOSITION'
  | 'ANSWER_SELECTION'
  | 'EPISTEMIC_STATE'
  | 'CERTIFICATE';

export type HardPeer80TargetReference =
  | { component: 'PROPOSITION'; propositionId: string }
  | { component: 'ANSWER_SELECTION' | 'EPISTEMIC_STATE' | 'CERTIFICATE'; propositionId: null };

export type HardPeer80Issue = {
  id: string;
  targetArtifactId: string;
  kind:
    | 'FACTUAL'
    | 'EVIDENCE'
    | 'ASSUMPTION'
    | 'LOGIC'
    | 'AMBIGUITY'
    | 'MISSING_INFORMATION'
    | 'TRADEOFF'
    | 'OTHER';
  severity: 'MATERIAL' | 'ADVISORY';
  statement: string;
  evidence: HardPeer80EvidenceReference[];
  confidence: number;
} & (
  | {
    targetComponent: 'PROPOSITION';
    targetPropositionId: string;
    proposedStance: 'ACCEPT' | 'REJECT' | 'OPEN' | 'NOT_APPLICABLE';
    proposedStatus: null;
    proposedOptionIds: null;
    proposedCertificate: null;
  }
  | {
    targetComponent: 'ANSWER_SELECTION';
    targetPropositionId: null;
    proposedStance: null;
    proposedStatus: null;
    proposedOptionIds: string[];
    proposedCertificate: null;
  }
  | {
    targetComponent: 'EPISTEMIC_STATE';
    targetPropositionId: null;
    proposedStance: null;
    proposedStatus: HardPeer80AnswerStatus;
    proposedOptionIds: null;
    proposedCertificate: null;
  }
  | {
    targetComponent: 'CERTIFICATE';
    targetPropositionId: null;
    proposedStance: null;
    proposedStatus: null;
    proposedOptionIds: null;
    proposedCertificate: HardPeer80Certificate;
  }
);

export interface HardPeer80PublicOutput {
  schemaVersion: typeof HARD_PEER_80_OUTPUT_SCHEMA_VERSION;
  stage: HardPeer80Stage;
  answer: {
    status: HardPeer80AnswerStatus;
    summary: string;
    selectedOptionIds: string[];
    confidence: number;
  };
  certificate: {
    kind:
      | 'DIRECT'
      | 'PROOF_SKETCH'
      | 'COUNTEREXAMPLE'
      | 'TRACE'
      | 'TRADEOFF'
      | 'MISSING_INFORMATION'
      | 'NONE';
    statement: string;
    evidence: HardPeer80EvidenceReference[];
    /** Public, typed data checked deterministically against the sealed case oracle. */
    payload: HardPeer80Certificate | null;
  };
  claims: Array<{
    id: string;
    propositionId: string;
    stance: 'ACCEPT' | 'REJECT' | 'OPEN' | 'NOT_APPLICABLE';
    statement: string;
    evidence: HardPeer80EvidenceReference[];
    assumptionIds: string[];
    confidence: number;
  }>;
  assumptions: Array<{
    id: string;
    statement: string;
    status: 'REQUIRED' | 'UNCERTAIN' | 'TESTABLE';
    propositionIds: string[];
  }>;
  requests: Array<{
    id: string;
    kind: 'MISSING_FACT' | 'USER_PREFERENCE' | 'AUTHORIZATION' | 'TEST_OR_CHECK';
    question: string;
    source: 'USER' | 'DOCUMENT' | 'TOOL' | 'EXPERT' | 'UNKNOWN';
    blocking: boolean;
    propositionIds: string[];
  }>;
  issues: HardPeer80Issue[];
  responses: Array<{
    id: string;
    targetArtifactId: string;
    targetIssueId: string;
    disposition: 'ACCEPT' | 'PARTIAL' | 'REJECT' | 'ABSTAIN';
    statement: string;
    evidence: HardPeer80EvidenceReference[];
    changedTargets: HardPeer80TargetReference[];
  }>;
  disagreements: Array<{
    id: string;
    targets: HardPeer80TargetReference[];
    participantArtifactIds: string[];
    status: 'RESOLVED' | 'UNRESOLVED' | 'COMPATIBLE_DIFFERENCE' | 'NEEDS_USER_INPUT';
    summary: string;
    evidence: HardPeer80EvidenceReference[];
    requestId: string | null;
  }>;
  resolution: {
    status:
      | 'RESOLVED'
      | 'PARTIALLY_RESOLVED'
      | 'UNRESOLVED'
      | 'NEEDS_USER_INPUT'
      | 'NO_DISAGREEMENT';
    basis:
      | 'EVIDENCE'
      | 'ASSUMPTION'
      | 'PREFERENCE'
      | 'INSUFFICIENT_INFORMATION'
      | 'NO_MATERIAL_ISSUE';
    summary: string;
    resolvedIssueIds: string[];
    unresolvedIssueIds: string[];
  };
  abstention: null | {
    reason:
      | 'INSUFFICIENT_INFORMATION'
      | 'OUTSIDE_CAPABILITY'
      | 'SAFETY'
      | 'USER_OWNED_DECISION';
    summary: string;
    propositionIds: string[];
    whatWouldResolve: string | null;
  };
}

export interface HardPeer80VisibleArtifact {
  artifactId: 'A0' | 'W1' | 'S1' | 'P1';
  artifactKind: 'POSITION' | 'REVIEW';
  actor: 'AUTHOR' | 'PEER';
  output: HardPeer80PublicOutput;
}

export interface HardPeer80ValidationContext {
  participantCase: LabParticipantCase;
  stage: HardPeer80Stage;
  currentArtifactId: 'PROBE' | 'A0' | 'W1' | 'W2' | 'S1' | 'S2' | 'P1' | 'AP1';
  visibleArtifacts: readonly HardPeer80VisibleArtifact[];
}

export type HardPeer80ValidationResult =
  | { ok: true; value: HardPeer80PublicOutput }
  | { ok: false; errors: LabValidationError[] };

const ID_SCHEMA = {
  type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$', minLength: 1, maxLength: 120
} as const;
const SHORT_TEXT_SCHEMA = { type: 'string', minLength: 1, maxLength: 600 } as const;
const CONFIDENCE_SCHEMA = { type: 'number', minimum: 0, maximum: 1 } as const;
const ID_ARRAY_SCHEMA = {
  type: 'array', maxItems: 64, items: ID_SCHEMA
} as const;
const EVIDENCE_REFERENCE_SCHEMA = closed(
  ['evidenceId', 'relation', 'note'],
  {
    evidenceId: ID_SCHEMA,
    relation: { type: 'string', enum: ['SUPPORTS', 'CONTRADICTS', 'LIMITS'] },
    note: SHORT_TEXT_SCHEMA
  }
);
const EVIDENCE_ARRAY_SCHEMA = {
  type: 'array', maxItems: 64, items: EVIDENCE_REFERENCE_SCHEMA
} as const;
const NUMBER_SCHEMA = { type: 'number' } as const;
const BOOLEAN_SCHEMA = { type: 'boolean' } as const;
const STRING_ARRAY_SCHEMA = {
  type: 'array', maxItems: 64, items: SHORT_TEXT_SCHEMA
} as const;
const BOOLEAN_ASSIGNMENT_SCHEMA = {
  type: 'string',
  minLength: 10,
  maxLength: 10,
  pattern: '^[01]{10}$',
  description: 'Exactly ten bits in declared variableOrder; 1 means true and 0 means false.'
} as const;
const BOOLEAN_VARIABLE_ORDER_SCHEMA = {
  type: 'array',
  minItems: 10,
  maxItems: 10,
  items: SHORT_TEXT_SCHEMA,
  description: 'The ten public case variables in bit-position order.'
} as const;
const NUMBER_ARRAY_SCHEMA = {
  type: 'array', maxItems: 64, items: NUMBER_SCHEMA
} as const;
const NUMBER_PAIR_SCHEMA = {
  type: 'array', minItems: 2, maxItems: 2, items: NUMBER_SCHEMA
} as const;
const RUN_EVENT_SCHEMA = {
  type: 'array',
  minItems: 3,
  maxItems: 3,
  items: {
    anyOf: [
      SHORT_TEXT_SCHEMA,
      NUMBER_SCHEMA
    ]
  }
} as const;

/** Closed provider-facing union for every deterministic case-certificate family. */
export const HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA = {
  anyOf: [
    closed(
      [
        'kind', 'universeSize', 'forbiddenDifferences', 'specialElements',
        'exactSpecialCount', 'optimum', 'construction', 'upperBoundMatching'
      ],
      {
        kind: { type: 'string', const: 'FORBIDDEN_DIFFERENCE_MATCHING' },
        universeSize: NUMBER_SCHEMA,
        forbiddenDifferences: NUMBER_ARRAY_SCHEMA,
        specialElements: NUMBER_ARRAY_SCHEMA,
        exactSpecialCount: NUMBER_SCHEMA,
        optimum: NUMBER_SCHEMA,
        construction: NUMBER_ARRAY_SCHEMA,
        upperBoundMatching: arrayOf(NUMBER_PAIR_SCHEMA)
      }
    ),
    closed(
      [
        'kind', 'variableOrder', 'satisfyingAssignments', 'queryTrueAssignments',
        'queryFalseAssignments', 'classification'
      ],
      {
        kind: { type: 'string', const: 'BOOLEAN_TRUTH_TABLE' },
        variableOrder: BOOLEAN_VARIABLE_ORDER_SCHEMA,
        satisfyingAssignments: arrayOf(BOOLEAN_ASSIGNMENT_SCHEMA),
        queryTrueAssignments: arrayOf(BOOLEAN_ASSIGNMENT_SCHEMA),
        queryFalseAssignments: arrayOf(BOOLEAN_ASSIGNMENT_SCHEMA),
        classification: { type: 'string', enum: ['ENTAILED', 'CONTRADICTED', 'OPEN'] }
      }
    ),
    closed(
      ['kind', 'offsetRange', 'latencyRange', 'relativeOffsetRange', 'worlds'],
      {
        kind: { type: 'string', const: 'CLOCK_OFFSET_WITNESSES' },
        offsetRange: NUMBER_PAIR_SCHEMA,
        latencyRange: NUMBER_PAIR_SCHEMA,
        relativeOffsetRange: NUMBER_PAIR_SCHEMA,
        worlds: arrayOf(closed(
          ['name', 'offsetA', 'offsetB', 'latency', 'leaseAUtc', 'leaseBUtc', 'claimTrue'],
          {
            name: SHORT_TEXT_SCHEMA,
            offsetA: NUMBER_SCHEMA,
            offsetB: NUMBER_SCHEMA,
            latency: NUMBER_SCHEMA,
            leaseAUtc: NUMBER_PAIR_SCHEMA,
            leaseBUtc: NUMBER_PAIR_SCHEMA,
            claimTrue: BOOLEAN_SCHEMA
          }
        ))
      }
    ),
    closed(
      [
        'kind', 'population', 'initialPositive', 'flagged', 'intersectionRange',
        'repairProbability', 'damageProbability', 'finalExpectationIntercept',
        'finalExpectationSlope', 'finalExpectationRange',
        'strictImprovementMinimumIntegerIntersection', 'witnessTables'
      ],
      {
        kind: { type: 'string', const: 'CONTINGENCY_EXPECTATION_BOUNDS' },
        population: NUMBER_SCHEMA,
        initialPositive: NUMBER_SCHEMA,
        flagged: NUMBER_SCHEMA,
        intersectionRange: NUMBER_PAIR_SCHEMA,
        repairProbability: NUMBER_SCHEMA,
        damageProbability: NUMBER_SCHEMA,
        finalExpectationIntercept: NUMBER_SCHEMA,
        finalExpectationSlope: NUMBER_SCHEMA,
        finalExpectationRange: NUMBER_PAIR_SCHEMA,
        strictImprovementMinimumIntegerIntersection: NUMBER_SCHEMA,
        witnessTables: arrayOf(closed(
          ['intersection', 'flaggedGood', 'unflaggedDefective', 'unflaggedGood', 'finalExpectation'],
          {
            intersection: NUMBER_SCHEMA,
            flaggedGood: NUMBER_SCHEMA,
            unflaggedDefective: NUMBER_SCHEMA,
            unflaggedGood: NUMBER_SCHEMA,
            finalExpectation: NUMBER_SCHEMA
          }
        ))
      }
    ),
    closed(
      [
        'kind', 'requestedSession', 'updates', 'currentOutput', 'requiredOutput',
        'repair'
      ],
      {
        kind: { type: 'string', const: 'SCOPED_REVISION_TRACE' },
        requestedSession: SHORT_TEXT_SCHEMA,
        updates: arrayOf(closed(
          ['session', 'item', 'revision', 'state'],
          {
            session: SHORT_TEXT_SCHEMA,
            item: SHORT_TEXT_SCHEMA,
            revision: SHORT_TEXT_SCHEMA,
            state: { type: 'string', enum: ['open', 'done'] }
          }
        )),
        currentOutput: STRING_ARRAY_SCHEMA,
        requiredOutput: STRING_ARRAY_SCHEMA,
        repair: closed(
          [
            'scopeUpdatesToRequestedSessionBeforeLatestSelection',
            'compareRevisionsAsExactNonnegativeIntegers'
          ],
          {
            scopeUpdatesToRequestedSessionBeforeLatestSelection: BOOLEAN_SCHEMA,
            compareRevisionsAsExactNonnegativeIntegers: BOOLEAN_SCHEMA
          }
        )
      }
    ),
    closed(
      ['kind', 'activeRunId', 'traces', 'repair'],
      {
        kind: { type: 'string', const: 'RUN_PROJECTION_TRACES' },
        activeRunId: SHORT_TEXT_SCHEMA,
        traces: arrayOf(closed(
          ['name', 'events', 'current', 'required'],
          {
            name: SHORT_TEXT_SCHEMA,
            events: arrayOf(RUN_EVENT_SCHEMA),
            current: { type: 'string', enum: ['running', 'interrupted', 'completed'] },
            required: { type: 'string', enum: ['running', 'interrupted', 'completed'] }
          }
        )),
        repair: closed(
          [
            'scopeOrdinalFilteringToActiveRun',
            'treatProviderCompletionAsTelemetryOnly',
            'deriveStatusAfterEvidenceAccumulation'
          ],
          {
            scopeOrdinalFilteringToActiveRun: BOOLEAN_SCHEMA,
            treatProviderCompletionAsTelemetryOnly: BOOLEAN_SCHEMA,
            deriveStatusAfterEvidenceAccumulation: BOOLEAN_SCHEMA
          }
        )
      }
    ),
    closed(
      [
        'kind', 'durableKeyBeforeCall', 'sameKeyOnRecovery',
        'providerIdempotentByKey', 'providerLookupByKey',
        'workflowRequiresLocalVerification', 'crashScenarios'
      ],
      {
        kind: { type: 'string', const: 'IDEMPOTENT_CREATE_CRASH_TABLE' },
        durableKeyBeforeCall: BOOLEAN_SCHEMA,
        sameKeyOnRecovery: BOOLEAN_SCHEMA,
        providerIdempotentByKey: BOOLEAN_SCHEMA,
        providerLookupByKey: BOOLEAN_SCHEMA,
        workflowRequiresLocalVerification: BOOLEAN_SCHEMA,
        crashScenarios: arrayOf(closed(
          [
            'providerCreateAppliedBeforeCrash', 'createReplyReceivedBeforeCrash',
            'remoteIdPersistedBeforeCrash', 'recoveryContactsProvider',
            'recoveryUsesPersistedKey', 'atMostOneRemoteTurn',
            'remoteIdEventuallyRecoverable'
          ],
          {
            providerCreateAppliedBeforeCrash: BOOLEAN_SCHEMA,
            createReplyReceivedBeforeCrash: BOOLEAN_SCHEMA,
            remoteIdPersistedBeforeCrash: BOOLEAN_SCHEMA,
            recoveryContactsProvider: BOOLEAN_SCHEMA,
            recoveryUsesPersistedKey: BOOLEAN_SCHEMA,
            atMostOneRemoteTurn: BOOLEAN_SCHEMA,
            remoteIdEventuallyRecoverable: BOOLEAN_SCHEMA
          }
        ))
      }
    ),
    closed(
      ['kind', 'worlds', 'recoveryChoices'],
      {
        kind: { type: 'string', const: 'INDISTINGUISHABLE_CRASH_WORLDS' },
        worlds: arrayOf(closed(
          ['name', 'durableLocalState', 'providerAppliedCount'],
          {
            name: SHORT_TEXT_SCHEMA,
            durableLocalState: SHORT_TEXT_SCHEMA,
            providerAppliedCount: NUMBER_SCHEMA
          }
        )),
        recoveryChoices: arrayOf(closed(
          ['choice', 'sendsInterrupt', 'violates', 'world'],
          {
            choice: SHORT_TEXT_SCHEMA,
            sendsInterrupt: BOOLEAN_SCHEMA,
            violates: { type: 'string', enum: ['SAFETY', 'LIVENESS'] },
            world: SHORT_TEXT_SCHEMA
          }
        ))
      }
    )
  ]
} as const;

const TARGET_REFERENCE_JSON_SCHEMA = {
  anyOf: [
    closed(
      ['component', 'propositionId'],
      { component: { type: 'string', const: 'PROPOSITION' }, propositionId: ID_SCHEMA }
    ),
    closed(
      ['component', 'propositionId'],
      {
        component: { type: 'string', const: 'ANSWER_SELECTION' },
        propositionId: { type: 'null' }
      }
    ),
    closed(
      ['component', 'propositionId'],
      {
        component: { type: 'string', const: 'EPISTEMIC_STATE' },
        propositionId: { type: 'null' }
      }
    ),
    closed(
      ['component', 'propositionId'],
      { component: { type: 'string', const: 'CERTIFICATE' }, propositionId: { type: 'null' } }
    )
  ]
} as const;
const ISSUE_KIND_SCHEMA = {
  type: 'string',
  enum: [
    'FACTUAL', 'EVIDENCE', 'ASSUMPTION', 'LOGIC', 'AMBIGUITY',
    'MISSING_INFORMATION', 'TRADEOFF', 'OTHER'
  ]
} as const;
const ISSUE_COMMON_PROPERTIES = {
  id: ID_SCHEMA,
  targetArtifactId: ID_SCHEMA,
  kind: ISSUE_KIND_SCHEMA,
  severity: { type: 'string', enum: ['MATERIAL', 'ADVISORY'] },
  statement: SHORT_TEXT_SCHEMA,
  evidence: EVIDENCE_ARRAY_SCHEMA,
  confidence: CONFIDENCE_SCHEMA
} as const;
const ISSUE_REQUIRED_FIELDS = [
  'id', 'targetArtifactId', 'targetComponent', 'targetPropositionId', 'kind', 'severity',
  'statement', 'proposedStance', 'proposedStatus', 'proposedOptionIds',
  'proposedCertificate', 'evidence', 'confidence'
] as const;
const ISSUE_JSON_SCHEMA = {
  anyOf: [
    closed(ISSUE_REQUIRED_FIELDS, {
      ...ISSUE_COMMON_PROPERTIES,
      targetComponent: { type: 'string', const: 'PROPOSITION' },
      targetPropositionId: ID_SCHEMA,
      proposedStance: {
        type: 'string', enum: ['ACCEPT', 'REJECT', 'OPEN', 'NOT_APPLICABLE']
      },
      proposedStatus: { type: 'null' },
      proposedOptionIds: { type: 'null' },
      proposedCertificate: { type: 'null' }
    }),
    closed(ISSUE_REQUIRED_FIELDS, {
      ...ISSUE_COMMON_PROPERTIES,
      targetComponent: { type: 'string', const: 'ANSWER_SELECTION' },
      targetPropositionId: { type: 'null' },
      proposedStance: { type: 'null' },
      proposedStatus: { type: 'null' },
      proposedOptionIds: ID_ARRAY_SCHEMA,
      proposedCertificate: { type: 'null' }
    }),
    closed(ISSUE_REQUIRED_FIELDS, {
      ...ISSUE_COMMON_PROPERTIES,
      targetComponent: { type: 'string', const: 'EPISTEMIC_STATE' },
      targetPropositionId: { type: 'null' },
      proposedStance: { type: 'null' },
      proposedStatus: {
        type: 'string',
        enum: ['ANSWER', 'UNCERTAIN', 'ABSTAIN', 'NEEDS_USER_INPUT', 'MULTIPLE_DEFENSIBLE']
      },
      proposedOptionIds: { type: 'null' },
      proposedCertificate: { type: 'null' }
    }),
    closed(ISSUE_REQUIRED_FIELDS, {
      ...ISSUE_COMMON_PROPERTIES,
      targetComponent: { type: 'string', const: 'CERTIFICATE' },
      targetPropositionId: { type: 'null' },
      proposedStance: { type: 'null' },
      proposedStatus: { type: 'null' },
      proposedOptionIds: { type: 'null' },
      proposedCertificate: HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA
    })
  ]
} as const;

/** Closed provider-facing schema. It intentionally has no reasoning or scratchpad field. */
export const HARD_PEER_80_OUTPUT_JSON_SCHEMA = closed(
  [
    'schemaVersion', 'stage', 'answer', 'certificate', 'claims', 'assumptions', 'requests',
    'issues', 'responses', 'disagreements', 'resolution', 'abstention'
  ],
  {
    schemaVersion: { type: 'string', const: HARD_PEER_80_OUTPUT_SCHEMA_VERSION },
    stage: {
      type: 'string',
      enum: [
        'PROBE', 'INITIAL', 'WORKBENCH_1', 'WORKBENCH_FINAL', 'SELF_REVIEW',
        'SELF_FINAL', 'PEER_CRITIQUE', 'AUTHOR_RESPONSE'
      ]
    },
    answer: closed(
      ['status', 'summary', 'selectedOptionIds', 'confidence'],
      {
        status: {
          type: 'string',
          enum: ['ANSWER', 'UNCERTAIN', 'ABSTAIN', 'NEEDS_USER_INPUT', 'MULTIPLE_DEFENSIBLE']
        },
        summary: SHORT_TEXT_SCHEMA,
        selectedOptionIds: ID_ARRAY_SCHEMA,
        confidence: CONFIDENCE_SCHEMA
      }
    ),
    certificate: closed(
      ['kind', 'statement', 'evidence', 'payload'],
      {
        kind: {
          type: 'string',
          enum: [
            'DIRECT', 'PROOF_SKETCH', 'COUNTEREXAMPLE', 'TRACE', 'TRADEOFF',
            'MISSING_INFORMATION', 'NONE'
          ]
        },
        statement: SHORT_TEXT_SCHEMA,
        evidence: EVIDENCE_ARRAY_SCHEMA,
        payload: {
          anyOf: [
            { type: 'null' },
            HARD_PEER_80_CERTIFICATE_PAYLOAD_JSON_SCHEMA
          ]
        }
      }
    ),
    claims: arrayOf(closed(
      ['id', 'propositionId', 'stance', 'statement', 'evidence', 'assumptionIds', 'confidence'],
      {
        id: ID_SCHEMA,
        propositionId: ID_SCHEMA,
        stance: { type: 'string', enum: ['ACCEPT', 'REJECT', 'OPEN', 'NOT_APPLICABLE'] },
        statement: SHORT_TEXT_SCHEMA,
        evidence: EVIDENCE_ARRAY_SCHEMA,
        assumptionIds: ID_ARRAY_SCHEMA,
        confidence: CONFIDENCE_SCHEMA
      }
    ), 1),
    assumptions: arrayOf(closed(
      ['id', 'statement', 'status', 'propositionIds'],
      {
        id: ID_SCHEMA,
        statement: SHORT_TEXT_SCHEMA,
        status: { type: 'string', enum: ['REQUIRED', 'UNCERTAIN', 'TESTABLE'] },
        propositionIds: { ...ID_ARRAY_SCHEMA, minItems: 1 }
      }
    )),
    requests: arrayOf(closed(
      ['id', 'kind', 'question', 'source', 'blocking', 'propositionIds'],
      {
        id: ID_SCHEMA,
        kind: {
          type: 'string',
          enum: ['MISSING_FACT', 'USER_PREFERENCE', 'AUTHORIZATION', 'TEST_OR_CHECK']
        },
        question: SHORT_TEXT_SCHEMA,
        source: { type: 'string', enum: ['USER', 'DOCUMENT', 'TOOL', 'EXPERT', 'UNKNOWN'] },
        blocking: { type: 'boolean' },
        propositionIds: { ...ID_ARRAY_SCHEMA, minItems: 1 }
      }
    )),
    issues: arrayOf(ISSUE_JSON_SCHEMA),
    responses: arrayOf(closed(
      [
        'id', 'targetArtifactId', 'targetIssueId', 'disposition', 'statement', 'evidence',
        'changedTargets'
      ],
      {
        id: ID_SCHEMA,
        targetArtifactId: ID_SCHEMA,
        targetIssueId: ID_SCHEMA,
        disposition: { type: 'string', enum: ['ACCEPT', 'PARTIAL', 'REJECT', 'ABSTAIN'] },
        statement: SHORT_TEXT_SCHEMA,
        evidence: EVIDENCE_ARRAY_SCHEMA,
        changedTargets: arrayOf(TARGET_REFERENCE_JSON_SCHEMA)
      }
    )),
    disagreements: arrayOf(closed(
      [
        'id', 'targets', 'participantArtifactIds', 'status', 'summary', 'evidence',
        'requestId'
      ],
      {
        id: ID_SCHEMA,
        targets: arrayOf(TARGET_REFERENCE_JSON_SCHEMA, 1),
        participantArtifactIds: { ...ID_ARRAY_SCHEMA, minItems: 2 },
        status: {
          type: 'string',
          enum: ['RESOLVED', 'UNRESOLVED', 'COMPATIBLE_DIFFERENCE', 'NEEDS_USER_INPUT']
        },
        summary: SHORT_TEXT_SCHEMA,
        evidence: EVIDENCE_ARRAY_SCHEMA,
        requestId: {
          anyOf: [{ type: 'null' }, ID_SCHEMA]
        }
      }
    )),
    resolution: closed(
      ['status', 'basis', 'summary', 'resolvedIssueIds', 'unresolvedIssueIds'],
      {
        status: {
          type: 'string',
          enum: [
            'RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED', 'NEEDS_USER_INPUT',
            'NO_DISAGREEMENT'
          ]
        },
        basis: {
          type: 'string',
          enum: [
            'EVIDENCE', 'ASSUMPTION', 'PREFERENCE', 'INSUFFICIENT_INFORMATION',
            'NO_MATERIAL_ISSUE'
          ]
        },
        summary: SHORT_TEXT_SCHEMA,
        resolvedIssueIds: ID_ARRAY_SCHEMA,
        unresolvedIssueIds: ID_ARRAY_SCHEMA
      }
    ),
    abstention: {
      anyOf: [
        { type: 'null' },
        closed(
          ['reason', 'summary', 'propositionIds', 'whatWouldResolve'],
          {
            reason: {
              type: 'string',
              enum: [
                'INSUFFICIENT_INFORMATION', 'OUTSIDE_CAPABILITY', 'SAFETY',
                'USER_OWNED_DECISION'
              ]
            },
            summary: SHORT_TEXT_SCHEMA,
            propositionIds: { ...ID_ARRAY_SCHEMA, minItems: 1 },
            whatWouldResolve: { anyOf: [{ type: 'null' }, SHORT_TEXT_SCHEMA] }
          }
        )
      ]
    }
  }
);

export function parseAndValidateHardPeer80Output(
  rawText: string,
  context: HardPeer80ValidationContext
): HardPeer80ValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      errors: [{
        path: '$',
        code: 'INVALID_JSON',
        message: error instanceof Error ? error.message : 'Provider output is not JSON.'
      }]
    };
  }
  return validateHardPeer80Output(value, context);
}

export function validateHardPeer80Output(
  value: unknown,
  context: HardPeer80ValidationContext
): HardPeer80ValidationResult {
  const errors: LabValidationError[] = [];
  validateJsonSchema(value, HARD_PEER_80_OUTPUT_JSON_SCHEMA, '$', errors);
  if (errors.length > 0) return { ok: false, errors };
  const output = value as HardPeer80PublicOutput;
  validateCrossFields(output, errors);
  validateContext(output, context, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: output };
}

function validateCrossFields(
  output: HardPeer80PublicOutput,
  errors: LabValidationError[]
): void {
  uniqueObjects(output.claims, '$.claims', errors);
  uniqueObjects(output.assumptions, '$.assumptions', errors);
  uniqueObjects(output.requests, '$.requests', errors);
  uniqueObjects(output.issues, '$.issues', errors);
  uniqueObjects(output.responses, '$.responses', errors);
  uniqueObjects(output.disagreements, '$.disagreements', errors);
  uniqueStrings(output.answer.selectedOptionIds, '$.answer.selectedOptionIds', errors);
  uniqueStrings(output.resolution.resolvedIssueIds, '$.resolution.resolvedIssueIds', errors);
  uniqueStrings(output.resolution.unresolvedIssueIds, '$.resolution.unresolvedIssueIds', errors);

  const assumptionIds = new Set(output.assumptions.map(({ id }) => id));
  const requestIds = new Set(output.requests.map(({ id }) => id));
  for (const [index, claim] of output.claims.entries()) {
    if (claim.stance !== 'OPEN' && claim.evidence.length === 0) {
      invalidValue(
        errors,
        `$.claims[${index}].evidence`,
        `${claim.stance} requires at least one visible case evidence reference.`
      );
    }
    uniqueStrings(claim.assumptionIds, `$.claims[${index}].assumptionIds`, errors);
    for (const [assumptionIndex, id] of claim.assumptionIds.entries()) {
      if (!assumptionIds.has(id)) {
        invalidReference(
          errors,
          `$.claims[${index}].assumptionIds[${assumptionIndex}]`,
          `Unknown current assumption id ${id}.`
        );
      }
    }
  }
  output.issues.forEach((issue, index) => {
    if (issue.severity === 'MATERIAL' && issue.evidence.length === 0) {
      invalidValue(
        errors,
        `$.issues[${index}].evidence`,
        'A MATERIAL issue requires at least one visible case evidence reference.'
      );
    }
    validateCertificateTupleShapes(
      issue.proposedCertificate,
      errors,
      `$.issues[${index}].proposedCertificate`
    );
  });
  for (const [index, disagreement] of output.disagreements.entries()) {
    uniqueStrings(
      disagreement.participantArtifactIds,
      `$.disagreements[${index}].participantArtifactIds`,
      errors
    );
    if (disagreement.status === 'NEEDS_USER_INPUT') {
      if (!disagreement.requestId || !requestIds.has(disagreement.requestId)) {
        invalidReference(
          errors,
          `$.disagreements[${index}].requestId`,
          'A user-owned disagreement must target a current request.'
        );
      }
    } else if (disagreement.requestId !== null && !requestIds.has(disagreement.requestId)) {
      invalidReference(
        errors,
        `$.disagreements[${index}].requestId`,
        `Unknown current request id ${disagreement.requestId}.`
      );
    }
  }
  if (output.answer.status === 'ABSTAIN' && output.abstention === null) {
    invalidValue(errors, '$.abstention', 'ABSTAIN requires an explicit abstention record.');
  }
  if (output.answer.status !== 'ABSTAIN' && output.abstention !== null) {
    invalidValue(errors, '$.abstention', 'Only ABSTAIN may include an abstention record.');
  }
  if (
    output.answer.status === 'NEEDS_USER_INPUT' &&
    !output.requests.some((request) => request.source === 'USER' && request.blocking)
  ) {
    invalidValue(
      errors,
      '$.requests',
      'NEEDS_USER_INPUT requires a blocking request owned by the user.'
    );
  }
  if (output.certificate.kind === 'NONE' && output.certificate.evidence.length > 0) {
    invalidValue(errors, '$.certificate.evidence', 'A NONE certificate cannot cite evidence.');
  }
  if (
    output.stage !== 'PROBE' &&
    output.answer.status === 'ANSWER' &&
    output.certificate.payload === null
  ) {
    invalidValue(
      errors,
      '$.certificate.payload',
      'Every non-PROBE ANSWER requires a typed public certificate payload.'
    );
  }
  validateCertificateTupleShapes(output.certificate.payload, errors, '$.certificate.payload');
}

function validateCertificateTupleShapes(
  payload: HardPeer80Certificate | null,
  errors: LabValidationError[],
  payloadPath: string
): void {
  if (payload?.kind !== 'RUN_PROJECTION_TRACES') return;
  payload.traces.forEach((trace, traceIndex) => {
    trace.events.forEach((event, eventIndex) => {
      if (
        typeof event[0] !== 'string' ||
        typeof event[1] !== 'number' ||
        !['provider-completed', 'process-exit', 'report-verified'].includes(event[2])
      ) {
        invalidValue(
          errors,
          `${payloadPath}.traces[${traceIndex}].events[${eventIndex}]`,
          'Run events require [event-id, sequence-number, event-kind].'
        );
      }
    });
  });
}

function validateContext(
  output: HardPeer80PublicOutput,
  context: HardPeer80ValidationContext,
  errors: LabValidationError[]
): void {
  validateParticipantContext(context, errors);
  if (output.stage !== context.stage) {
    invalidValue(errors, '$.stage', `Expected stage ${context.stage}; received ${output.stage}.`);
  }
  const expectedArtifacts = expectedArtifactIds(context.stage);
  const actualArtifacts = context.visibleArtifacts.map(({ artifactId }) => artifactId);
  if (stableSet(expectedArtifacts) !== stableSet(actualArtifacts)) {
    contextUnavailable(
      errors,
      '$context.visibleArtifacts',
      `Stage ${context.stage} requires exactly [${expectedArtifacts.join(', ')}].`
    );
    return;
  }
  const propositionMap = new Map(
    context.participantCase.propositions.map((proposition) => [proposition.id, proposition])
  );
  const claimIds = output.claims.map(({ propositionId }) => propositionId);
  if (stableSet(claimIds) !== stableSet([...propositionMap.keys()]) || claimIds.length !== propositionMap.size) {
    invalidReference(
      errors,
      '$.claims',
      'Claims must assess every case proposition exactly once.'
    );
  }
  const allowedOptionIds = new Set(context.participantCase.options.map(({ id }) => id));
  output.answer.selectedOptionIds.forEach((id, index) => {
    if (!allowedOptionIds.has(id)) {
      invalidReference(errors, `$.answer.selectedOptionIds[${index}]`, `Unknown option id ${id}.`);
    }
  });
  const allowedEvidenceIds = new Set([
    'PROMPT',
    ...context.participantCase.evidence.map(({ id }) => id)
  ]);
  const allowedTargetIds = new Set(['CASE', ...actualArtifacts]);
  const participantArtifactIds = new Set<string>([context.currentArtifactId, ...actualArtifacts]);
  const assumptionIds = new Set(output.assumptions.map(({ id }) => id));
  const requestIds = new Set(output.requests.map(({ id }) => id));

  const evidenceContainers: Array<readonly [string, HardPeer80EvidenceReference[]]> = [
    ['$.certificate.evidence', output.certificate.evidence],
    ...output.claims.map((item, index) => [`$.claims[${index}].evidence`, item.evidence] as const),
    ...output.issues.map((item, index) => [`$.issues[${index}].evidence`, item.evidence] as const),
    ...output.responses.map((item, index) => [`$.responses[${index}].evidence`, item.evidence] as const),
    ...output.disagreements.map(
      (item, index) => [`$.disagreements[${index}].evidence`, item.evidence] as const
    )
  ];
  for (const [path, references] of evidenceContainers) {
    const identities = new Set<string>();
    references.forEach((reference, index) => {
      if (!allowedEvidenceIds.has(reference.evidenceId)) {
        invalidReference(
          errors,
          `${path}[${index}].evidenceId`,
          `Unknown case evidence id ${reference.evidenceId}; conversational artifacts are not facts.`
        );
      }
      const identity = `${reference.evidenceId}\u0000${reference.relation}`;
      if (identities.has(identity)) {
        duplicate(errors, `${path}[${index}]`, 'Duplicate evidence-id/relation pair.');
      }
      identities.add(identity);
    });
  }
  output.assumptions.forEach((assumption, index) => {
    validatePropositionIds(
      assumption.propositionIds,
      propositionMap,
      `$.assumptions[${index}].propositionIds`,
      errors
    );
  });
  output.requests.forEach((request, index) => {
    validatePropositionIds(
      request.propositionIds,
      propositionMap,
      `$.requests[${index}].propositionIds`,
      errors
    );
  });
  output.claims.forEach((claim, index) => {
    claim.assumptionIds.forEach((id, assumptionIndex) => {
      if (!assumptionIds.has(id)) {
        invalidReference(
          errors,
          `$.claims[${index}].assumptionIds[${assumptionIndex}]`,
          `Unknown assumption id ${id}.`
        );
      }
    });
  });
  output.issues.forEach((issue, index) => {
    if (!allowedTargetIds.has(issue.targetArtifactId)) {
      invalidReference(
        errors,
        `$.issues[${index}].targetArtifactId`,
        `Issue target ${issue.targetArtifactId} was not visible.`
      );
    }
    if (
      issue.targetComponent === 'PROPOSITION' &&
      !propositionMap.has(issue.targetPropositionId)
    ) {
      invalidReference(
        errors,
        `$.issues[${index}].targetPropositionId`,
        `Unknown proposition id ${issue.targetPropositionId}.`
      );
    }
    const proposedOptionIds = issue.targetComponent === 'ANSWER_SELECTION'
      ? issue.proposedOptionIds
      : [];
    uniqueStrings(proposedOptionIds, `$.issues[${index}].proposedOptionIds`, errors);
    proposedOptionIds.forEach((id, optionIndex) => {
      if (!allowedOptionIds.has(id)) {
        invalidReference(
          errors,
          `$.issues[${index}].proposedOptionIds[${optionIndex}]`,
          `Unknown proposed option id ${id}.`
        );
      }
    });
  });
  output.responses.forEach((response, index) => {
    validateTargetReferences(
      response.changedTargets,
      propositionMap,
      `$.responses[${index}].changedTargets`,
      errors
    );
  });
  output.disagreements.forEach((disagreement, index) => {
    validateTargetReferences(
      disagreement.targets,
      propositionMap,
      `$.disagreements[${index}].targets`,
      errors
    );
    disagreement.participantArtifactIds.forEach((id, artifactIndex) => {
      if (!participantArtifactIds.has(id)) {
        invalidReference(
          errors,
          `$.disagreements[${index}].participantArtifactIds[${artifactIndex}]`,
          `Unknown participant artifact id ${id}.`
        );
      }
    });
    if (disagreement.requestId !== null && !requestIds.has(disagreement.requestId)) {
      invalidReference(
        errors,
        `$.disagreements[${index}].requestId`,
        `Unknown request id ${disagreement.requestId}.`
      );
    }
  });
  if (output.abstention) {
    validatePropositionIds(
      output.abstention.propositionIds,
      propositionMap,
      '$.abstention.propositionIds',
      errors
    );
  }

  validateResponseAndIssueLifecycle(output, context, errors);
}

function validateParticipantContext(
  context: HardPeer80ValidationContext,
  errors: LabValidationError[]
): void {
  const reservedArtifactIds = new Set(['CASE', 'A0', 'W1', 'W2', 'S1', 'S2', 'P1', 'AP1']);
  if (context.participantCase.schemaVersion !== LAB_PARTICIPANT_CASE_SCHEMA_VERSION) {
    contextUnavailable(
      errors,
      '$context.participantCase.schemaVersion',
      'Participant case schema version is not supported.'
    );
  }
  const evidenceIds = context.participantCase.evidence.map(({ id }) => id);
  const propositionIds = context.participantCase.propositions.map(({ id }) => id);
  const optionIds = context.participantCase.options.map(({ id }) => id);
  const topicIds = context.participantCase.topics.map(({ id }) => id);
  for (const [path, ids] of [
    ['$context.participantCase.evidence', evidenceIds],
    ['$context.participantCase.propositions', propositionIds],
    ['$context.participantCase.options', optionIds],
    ['$context.participantCase.topics', topicIds]
  ] as const) {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        contextUnavailable(errors, `${path}[${index}].id`, `Duplicate participant id ${id}.`);
      }
      seen.add(id);
    });
  }
  evidenceIds.forEach((id, index) => {
    if (reservedArtifactIds.has(id)) {
      contextUnavailable(
        errors,
        `$context.participantCase.evidence[${index}].id`,
        `Evidence id ${id} collides with a conversational artifact id.`
      );
    }
  });
  optionIds.forEach((id, index) => {
    if (reservedArtifactIds.has(id)) {
      contextUnavailable(
        errors,
        `$context.participantCase.options[${index}].id`,
        `Option id ${id} collides with a conversational artifact id.`
      );
    }
  });
  topicIds.forEach((id, index) => {
    if (reservedArtifactIds.has(id)) {
      contextUnavailable(
        errors,
        `$context.participantCase.topics[${index}].id`,
        `Topic id ${id} collides with a conversational artifact id.`
      );
    }
  });
  const knownTopics = new Set(topicIds);
  context.participantCase.propositions.forEach((proposition, index) => {
    if (reservedArtifactIds.has(proposition.id)) {
      contextUnavailable(
        errors,
        `$context.participantCase.propositions[${index}].id`,
        `Proposition id ${proposition.id} collides with a conversational artifact id.`
      );
    }
    if (!knownTopics.has(proposition.topicId)) {
      contextUnavailable(
        errors,
        `$context.participantCase.propositions[${index}].topicId`,
        `Unknown topic id ${proposition.topicId}.`
      );
    }
  });
  const expectedCurrent: Record<HardPeer80Stage, HardPeer80ValidationContext['currentArtifactId']> = {
    PROBE: 'PROBE',
    INITIAL: 'A0',
    WORKBENCH_1: 'W1',
    WORKBENCH_FINAL: 'W2',
    SELF_REVIEW: 'S1',
    SELF_FINAL: 'S2',
    PEER_CRITIQUE: 'P1',
    AUTHOR_RESPONSE: 'AP1'
  };
  if (context.currentArtifactId !== expectedCurrent[context.stage]) {
    contextUnavailable(
      errors,
      '$context.currentArtifactId',
      `Stage ${context.stage} requires current artifact ${expectedCurrent[context.stage]}.`
    );
  }
  const seenArtifacts = new Set<string>();
  const artifactContract: Record<
    HardPeer80VisibleArtifact['artifactId'],
    Pick<HardPeer80VisibleArtifact, 'artifactKind' | 'actor'> & { stage: HardPeer80Stage }
  > = {
    A0: { artifactKind: 'POSITION', actor: 'AUTHOR', stage: 'INITIAL' },
    W1: { artifactKind: 'REVIEW', actor: 'AUTHOR', stage: 'WORKBENCH_1' },
    S1: { artifactKind: 'REVIEW', actor: 'AUTHOR', stage: 'SELF_REVIEW' },
    P1: { artifactKind: 'REVIEW', actor: 'PEER', stage: 'PEER_CRITIQUE' }
  };
  context.visibleArtifacts.forEach((artifact, index) => {
    if (seenArtifacts.has(artifact.artifactId)) {
      contextUnavailable(
        errors,
        `$context.visibleArtifacts[${index}].artifactId`,
        `Duplicate visible artifact ${artifact.artifactId}.`
      );
    }
    seenArtifacts.add(artifact.artifactId);
    const expected = artifactContract[artifact.artifactId];
    if (
      artifact.artifactKind !== expected.artifactKind ||
      artifact.actor !== expected.actor ||
      artifact.output.stage !== expected.stage
    ) {
      contextUnavailable(
        errors,
        `$context.visibleArtifacts[${index}]`,
        `Artifact ${artifact.artifactId} has invalid kind, actor, or output stage.`
      );
    }
  });
}

function validateResponseAndIssueLifecycle(
  output: HardPeer80PublicOutput,
  context: HardPeer80ValidationContext,
  errors: LabValidationError[]
): void {
  const reviewStages: HardPeer80Stage[] = ['WORKBENCH_1', 'SELF_REVIEW', 'PEER_CRITIQUE'];
  const finalStages: HardPeer80Stage[] = ['WORKBENCH_FINAL', 'SELF_FINAL', 'AUTHOR_RESPONSE'];
  if ((context.stage === 'PROBE' || context.stage === 'INITIAL') && output.issues.length > 0) {
    invalidValue(errors, '$.issues', `${context.stage} cannot emit critique issues.`);
  }
  if ((context.stage === 'PROBE' || context.stage === 'INITIAL') && output.responses.length > 0) {
    invalidValue(errors, '$.responses', `${context.stage} cannot emit critique responses.`);
  }
  if (reviewStages.includes(context.stage)) {
    if (output.responses.length > 0) {
      invalidValue(errors, '$.responses', `${context.stage} cannot respond to an issue.`);
    }
    output.issues.forEach((issue, index) => {
      if (issue.targetArtifactId !== 'A0') {
        invalidReference(
          errors,
          `$.issues[${index}].targetArtifactId`,
          `${context.stage} issues must target A0.`
        );
      }
    });
  }
  if (finalStages.includes(context.stage) && output.issues.length > 0) {
    invalidValue(errors, '$.issues', `${context.stage} cannot introduce a new issue.`);
  }
  const responseArtifactId = immediateReviewArtifactId(context.stage);
  const visibleIssues = responseArtifactId
    ? context.visibleArtifacts.find(({ artifactId }) => artifactId === responseArtifactId)?.output.issues ?? []
    : [];
  const visibleIssueIds = new Set(visibleIssues.map(({ id }) => id));
  const responseTargets = new Set<string>();
  for (const [index, response] of output.responses.entries()) {
    if (!responseArtifactId || response.targetArtifactId !== responseArtifactId) {
      invalidReference(
        errors,
        `$.responses[${index}].targetArtifactId`,
        responseArtifactId
          ? `Responses must target the immediately preceding ${responseArtifactId} artifact.`
          : 'This stage has no structured review issue to answer.'
      );
    }
    if (!visibleIssueIds.has(response.targetIssueId)) {
      invalidReference(
        errors,
        `$.responses[${index}].targetIssueId`,
        `Issue ${response.targetIssueId} is not an issue on the immediately preceding review.`
      );
    }
    const key = `${response.targetArtifactId}\u0000${response.targetIssueId}`;
    if (responseTargets.has(key)) {
      duplicate(errors, `$.responses[${index}].targetIssueId`, 'A review issue may be answered once.');
    }
    responseTargets.add(key);
  }
  if (responseArtifactId) {
    for (const issue of visibleIssues) {
      if (!responseTargets.has(`${responseArtifactId}\u0000${issue.id}`)) {
        invalidReference(
          errors,
          '$.responses',
          `Visible issue ${issue.id} requires one direct response, including rejection or abstention.`
        );
      }
    }
  }

  const accountableIssueIds = new Set([
    ...output.issues.map(({ id }) => id),
    ...visibleIssues.map(({ id }) => id)
  ]);
  const resolved = new Set(output.resolution.resolvedIssueIds);
  const unresolved = new Set(output.resolution.unresolvedIssueIds);
  for (const id of accountableIssueIds) {
    if (resolved.has(id) === unresolved.has(id)) {
      invalidReference(
        errors,
        '$.resolution',
        `Issue ${id} must appear exactly once in resolvedIssueIds or unresolvedIssueIds.`
      );
    }
  }
  for (const id of [...resolved, ...unresolved]) {
    if (!accountableIssueIds.has(id)) {
      invalidReference(errors, '$.resolution', `Unknown accountable issue id ${id}.`);
    }
  }
  for (const [index, response] of output.responses.entries()) {
    const shouldResolve = response.disposition === 'ACCEPT' || response.disposition === 'REJECT';
    const correctlyClassified = shouldResolve
      ? resolved.has(response.targetIssueId)
      : unresolved.has(response.targetIssueId);
    if (!correctlyClassified) {
      invalidValue(
        errors,
        `$.responses[${index}].disposition`,
        `${response.disposition} is inconsistent with the issue resolution lists.`
      );
    }
  }
}

function expectedArtifactIds(stage: HardPeer80Stage): HardPeer80VisibleArtifact['artifactId'][] {
  switch (stage) {
    case 'PROBE':
    case 'INITIAL':
      return [];
    case 'WORKBENCH_1':
    case 'SELF_REVIEW':
    case 'PEER_CRITIQUE':
      return ['A0'];
    case 'WORKBENCH_FINAL':
      return ['A0', 'W1'];
    case 'SELF_FINAL':
      return ['A0', 'S1'];
    case 'AUTHOR_RESPONSE':
      return ['A0', 'P1'];
  }
}

function immediateReviewArtifactId(
  stage: HardPeer80Stage
): HardPeer80VisibleArtifact['artifactId'] | null {
  switch (stage) {
    case 'WORKBENCH_FINAL': return 'W1';
    case 'SELF_FINAL': return 'S1';
    case 'AUTHOR_RESPONSE': return 'P1';
    default: return null;
  }
}

function validatePropositionIds(
  ids: readonly string[],
  propositions: ReadonlyMap<string, unknown>,
  path: string,
  errors: LabValidationError[]
): void {
  uniqueStrings(ids, path, errors);
  ids.forEach((id, index) => {
    if (!propositions.has(id)) {
      invalidReference(errors, `${path}[${index}]`, `Unknown proposition id ${id}.`);
    }
  });
}

function validateTargetReferences(
  targets: readonly HardPeer80TargetReference[],
  propositions: ReadonlyMap<string, unknown>,
  path: string,
  errors: LabValidationError[]
): void {
  uniqueTargetReferences(targets, path, errors);
  targets.forEach((target, index) => {
    if (target.component === 'PROPOSITION' && !propositions.has(target.propositionId)) {
      invalidReference(
        errors,
        `${path}[${index}].propositionId`,
        `Unknown proposition id ${target.propositionId}.`
      );
    }
  });
}

function uniqueTargetReferences(
  targets: readonly HardPeer80TargetReference[],
  path: string,
  errors: LabValidationError[]
): void {
  const seen = new Set<string>();
  targets.forEach((target, index) => {
    const key = `${target.component}\u0000${target.propositionId ?? ''}`;
    if (seen.has(key)) duplicate(errors, `${path}[${index}]`, `Duplicate target ${key}.`);
    seen.add(key);
  });
}

function uniqueObjects(
  values: ReadonlyArray<{ id: string }>,
  path: string,
  errors: LabValidationError[]
): void {
  uniqueStrings(values.map(({ id }) => id), path, errors);
}

function uniqueStrings(
  values: readonly string[],
  path: string,
  errors: LabValidationError[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) duplicate(errors, `${path}[${index}]`, `Duplicate id ${value}.`);
    seen.add(value);
  });
}

function stableSet(values: readonly string[]): string {
  return JSON.stringify([...values].sort((left, right) => left.localeCompare(right)));
}

function invalidReference(errors: LabValidationError[], path: string, message: string): void {
  errors.push({
    path,
    code: 'INVALID_REFERENCE',
    message,
    ruleId: 'hard-peer-80.reference',
    domain: 'CONTEXT_CONTRACT',
    measurementEffect: 'OUTPUT_INVALID'
  });
}

function contextUnavailable(errors: LabValidationError[], path: string, message: string): void {
  errors.push({
    path,
    code: 'INVALID_REFERENCE',
    message,
    ruleId: 'hard-peer-80.context',
    domain: 'CONTEXT_INTEGRITY',
    measurementEffect: 'MEASUREMENT_UNAVAILABLE'
  });
}

function invalidValue(errors: LabValidationError[], path: string, message: string): void {
  errors.push({ path, code: 'INVALID_VALUE', message });
}

function duplicate(errors: LabValidationError[], path: string, message: string): void {
  errors.push({ path, code: 'DUPLICATE_ID', message });
}

function arrayOf(items: Record<string, unknown>, minItems = 0): Record<string, unknown> {
  return { type: 'array', minItems, maxItems: 64, items };
}

function closed(
  required: readonly string[],
  properties: Record<string, unknown>
): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required, properties };
}
