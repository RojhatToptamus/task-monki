import { sha256Text, stableJson } from './ledger';
import type { HardPeer80Stage } from './hardPeer80Contracts';

export const HARD_PEER_80_PLAN_SCHEMA_VERSION =
  'task-monki/discourse-lab-hard-peer-80-plan@v1' as const;
export const HARD_PEER_80_PLAN_VERSION = 'hard-peer-80-terminal-study@v1' as const;
export const HARD_PEER_80_SCHEDULE_VERSION = 'hard-peer-80-counterbalanced-schedule@v1' as const;

export type HardPeer80ConditionId =
  | 'BOUNDARY_PROBE'
  | 'CALIBRATION_INITIAL'
  | 'SHARED_INITIAL'
  | 'STRONG_WORKBENCH'
  | 'SAME_AGENT_SELF_REVIEW'
  | 'BLIND_PEER_CRITIQUE';

export type HardPeer80TurnId = 'PROBE' | 'A0' | 'W1' | 'W2' | 'S1' | 'S2' | 'P1' | 'AP1';

export interface HardPeer80CallAssignment {
  callNumber: number;
  callId: string;
  phase: 'BOUNDARY_PROBE' | 'CALIBRATION' | 'EVALUATION';
  caseId: string | null;
  blockId: string | null;
  repetition: 0 | 1 | 2;
  conditionId: HardPeer80ConditionId;
  turnId: HardPeer80TurnId;
  stage: HardPeer80Stage;
  actor: 'AUTHOR' | 'PEER';
  sessionKey: string;
  threadMode: 'FRESH' | 'FORK_A0' | 'CONTINUE_BRANCH';
  parentCallId: string | null;
}

export interface HardPeer80ForkInstruction {
  forkId: string;
  blockId: string;
  branch: 'WORKBENCH_AUTHOR' | 'SELF_REVIEW_AUTHOR' | 'PEER_RESPONSE_AUTHOR';
  sessionKey: string;
  sourceCallId: string;
  firstBranchCallId: string;
  timing: 'AFTER_A0_BEFORE_ANY_BRANCH_CALL';
  consumesProviderModelCall: false;
}

export interface HardPeer80Plan {
  schemaVersion: typeof HARD_PEER_80_PLAN_SCHEMA_VERSION;
  planVersion: typeof HARD_PEER_80_PLAN_VERSION;
  createdAt: string;
  terminalStudy: true;
  confirmationOpened: false;
  model: {
    id: 'gpt-5.6-sol';
    reasoningEffort: 'high';
    serviceTier: 'default';
    samplingSeed: null;
  };
  budget: {
    maximumProviderCalls: 76;
    maximumObservedTotalTokens: 1_500_000;
    maximumCallMs: 120_000;
    maximumExperimentMs: 18_000_000;
    targetOutputTokensPerCall: 3_000;
    emergencyOutputTokenSafetyCeilingPerCall: 10_000;
    maximumNextCallObservedTokenReservation: 25_000;
    calibrationBatches: 1;
    evaluationRuns: 1;
    retries: 0;
    repairs: 0;
    replacementCases: 0;
    followUpExperiments: 0;
  };
  calibrationGate: {
    caseCount: 5;
    calls: 5;
    proceedOnCompositeCorrectCount: [2, 3];
    otherwise: 'TERMINAL_STOP_SINGLE_AGENT_DEFAULT';
  };
  analysis: {
    question: 'CAN_BLIND_PEER_CRITIQUE_BEAT_EQUAL_COST_SAME_AGENT_SELF_REVIEW';
    uniqueEvaluationCases: 5;
    repetitionsPerEvaluationCase: 2;
    evaluationBlocks: 10;
    sharedInitialWithinBlock: true;
    marginalTurnsPerCondition: 2;
    peerBlindness:
      'FRESH_PEER_BLIND_TO_ORACLE_AUTHOR_IDENTITY_SIBLING_BRANCHES_AND_OUTCOMES_BUT_SEES_A0';
    peerPositionIndependenceEstimable: false;
    repetitionsAreIndependentSamples: false;
  };
  schedule: {
    version: typeof HARD_PEER_80_SCHEDULE_VERSION;
    method: 'CASE_CLUSTERED_REPETITIONS_WITH_COUNTERBALANCED_BRANCH_ORDER';
    calibrationCaseIds: string[];
    evaluationBlockIds: string[];
    callIds: string[];
    scheduleSha256: string;
  };
  assignments: HardPeer80CallAssignment[];
  forks: HardPeer80ForkInstruction[];
}

const BRANCH_ORDERS = [
  ['W', 'S', 'P'],
  ['S', 'P', 'W'],
  ['P', 'W', 'S'],
  ['W', 'P', 'S'],
  ['P', 'S', 'W'],
  ['S', 'W', 'P'],
  ['W', 'S', 'P'],
  ['S', 'P', 'W'],
  ['P', 'W', 'S'],
  ['W', 'P', 'S']
] as const;

function constructHardPeer80Plan(input: {
  calibrationCaseIds: readonly string[];
  evaluationCaseIds: readonly string[];
  createdAt?: string;
}): HardPeer80Plan {
  validateCaseIds(input.calibrationCaseIds, input.evaluationCaseIds);
  const assignments: HardPeer80CallAssignment[] = [];
  const forks: HardPeer80ForkInstruction[] = [];
  let callNumber = 1;

  assignments.push({
    callNumber: callNumber++,
    callId: 'probe:boundary',
    phase: 'BOUNDARY_PROBE',
    caseId: null,
    blockId: null,
    repetition: 0,
    conditionId: 'BOUNDARY_PROBE',
    turnId: 'PROBE',
    stage: 'PROBE',
    actor: 'AUTHOR',
    sessionKey: 'probe',
    threadMode: 'FRESH',
    parentCallId: null
  });
  input.calibrationCaseIds.forEach((caseId, index) => {
    assignments.push({
      callNumber: callNumber++,
      callId: `cal:${index + 1}:A0`,
      phase: 'CALIBRATION',
      caseId,
      blockId: `cal:${index + 1}`,
      repetition: 0,
      conditionId: 'CALIBRATION_INITIAL',
      turnId: 'A0',
      stage: 'INITIAL',
      actor: 'AUTHOR',
      sessionKey: `cal:${index + 1}:author`,
      threadMode: 'FRESH',
      parentCallId: null
    });
  });

  const blockCases = [
    ...input.evaluationCaseIds.map((caseId) => ({ caseId, repetition: 1 as const })),
    ...[2, 3, 4, 0, 1].map((index) => ({
      caseId: input.evaluationCaseIds[index]!, repetition: 2 as const
    }))
  ];
  blockCases.forEach(({ caseId, repetition }, blockIndex) => {
    const caseOrdinal = input.evaluationCaseIds.indexOf(caseId) + 1;
    const blockId = `eval:${caseOrdinal}:r${repetition}`;
    const a0CallId = `${blockId}:A0`;
    assignments.push({
      callNumber: callNumber++,
      callId: a0CallId,
      phase: 'EVALUATION',
      caseId,
      blockId,
      repetition,
      conditionId: 'SHARED_INITIAL',
      turnId: 'A0',
      stage: 'INITIAL',
      actor: 'AUTHOR',
      sessionKey: `${blockId}:source-author`,
      threadMode: 'FRESH',
      parentCallId: null
    });

    const branches = branchAssignments(blockId, caseId, repetition, a0CallId);
    for (const branch of ['W', 'S', 'P'] as const) {
      const forkedAuthorCall = branch === 'P' ? branches.P[1]! : branches[branch][0]!;
      forks.push({
        forkId: `${blockId}:fork:${branch}`,
        blockId,
        branch:
          branch === 'W'
            ? 'WORKBENCH_AUTHOR'
            : branch === 'S'
              ? 'SELF_REVIEW_AUTHOR'
              : 'PEER_RESPONSE_AUTHOR',
        sessionKey: forkedAuthorCall.sessionKey,
        sourceCallId: a0CallId,
        firstBranchCallId: forkedAuthorCall.callId,
        timing: 'AFTER_A0_BEFORE_ANY_BRANCH_CALL',
        consumesProviderModelCall: false
      });
    }
    for (const branch of BRANCH_ORDERS[blockIndex]!) {
      for (const assignment of branches[branch]) {
        assignments.push({ ...assignment, callNumber: callNumber++ });
      }
    }
  });

  const schedulePayload = {
    version: HARD_PEER_80_SCHEDULE_VERSION,
    method: 'CASE_CLUSTERED_REPETITIONS_WITH_COUNTERBALANCED_BRANCH_ORDER' as const,
    calibrationCaseIds: [...input.calibrationCaseIds],
    evaluationBlockIds: blockCases.map(({ caseId, repetition }) =>
      `eval:${input.evaluationCaseIds.indexOf(caseId) + 1}:r${repetition}`
    ),
    callIds: assignments.map(({ callId }) => callId)
  };
  const plan: HardPeer80Plan = {
    schemaVersion: HARD_PEER_80_PLAN_SCHEMA_VERSION,
    planVersion: HARD_PEER_80_PLAN_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    terminalStudy: true,
    confirmationOpened: false,
    model: {
      id: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'default', samplingSeed: null
    },
    budget: {
      maximumProviderCalls: 76,
      maximumObservedTotalTokens: 1_500_000,
      maximumCallMs: 120_000,
      maximumExperimentMs: 18_000_000,
      targetOutputTokensPerCall: 3_000,
      emergencyOutputTokenSafetyCeilingPerCall: 10_000,
      maximumNextCallObservedTokenReservation: 25_000,
      calibrationBatches: 1,
      evaluationRuns: 1,
      retries: 0,
      repairs: 0,
      replacementCases: 0,
      followUpExperiments: 0
    },
    calibrationGate: {
      caseCount: 5,
      calls: 5,
      proceedOnCompositeCorrectCount: [2, 3],
      otherwise: 'TERMINAL_STOP_SINGLE_AGENT_DEFAULT'
    },
    analysis: {
      question: 'CAN_BLIND_PEER_CRITIQUE_BEAT_EQUAL_COST_SAME_AGENT_SELF_REVIEW',
      uniqueEvaluationCases: 5,
      repetitionsPerEvaluationCase: 2,
      evaluationBlocks: 10,
      sharedInitialWithinBlock: true,
      marginalTurnsPerCondition: 2,
      peerBlindness:
        'FRESH_PEER_BLIND_TO_ORACLE_AUTHOR_IDENTITY_SIBLING_BRANCHES_AND_OUTCOMES_BUT_SEES_A0',
      peerPositionIndependenceEstimable: false,
      repetitionsAreIndependentSamples: false
    },
    schedule: {
      ...schedulePayload,
      scheduleSha256: sha256Text(`${stableJson(schedulePayload)}\n`)
    },
    assignments,
    forks
  };
  return plan;
}

export function buildHardPeer80Plan(input: {
  calibrationCaseIds: readonly string[];
  evaluationCaseIds: readonly string[];
  createdAt?: string;
}): HardPeer80Plan {
  const plan = constructHardPeer80Plan(input);
  assertHardPeer80Plan(plan, input.calibrationCaseIds, input.evaluationCaseIds);
  return plan;
}

export function assertHardPeer80Plan(
  plan: HardPeer80Plan,
  calibrationCaseIds: readonly string[],
  evaluationCaseIds: readonly string[]
): void {
  validateCaseIds(calibrationCaseIds, evaluationCaseIds);
  const expected = constructHardPeer80Plan({
    calibrationCaseIds,
    evaluationCaseIds,
    createdAt: plan.createdAt
  });
  const problems: string[] = [];
  if (!Number.isFinite(Date.parse(plan.createdAt))) problems.push('createdAt');
  for (const field of [
    'schemaVersion', 'planVersion', 'terminalStudy', 'confirmationOpened', 'model', 'budget',
    'calibrationGate', 'analysis', 'schedule', 'assignments', 'forks'
  ] as const) {
    if (stableJson(plan[field]) !== stableJson(expected[field])) problems.push(field);
  }
  if (plan.assignments.length !== 76 || plan.forks.length !== 30) problems.push('topology');
  if (problems.length > 0) {
    throw new Error(`HARD-PEER-80 plan does not match the terminal design: ${problems.join(', ')}.`);
  }
}

function branchAssignments(
  blockId: string,
  caseId: string,
  repetition: 1 | 2,
  a0CallId: string
): Record<'W' | 'S' | 'P', Array<Omit<HardPeer80CallAssignment, 'callNumber'>>> {
  return {
    W: [
      branchCall('W1', 'WORKBENCH_1', 'STRONG_WORKBENCH', 'AUTHOR', 'FORK_A0', a0CallId),
      branchCall('W2', 'WORKBENCH_FINAL', 'STRONG_WORKBENCH', 'AUTHOR', 'CONTINUE_BRANCH', `${blockId}:W1`)
    ],
    S: [
      branchCall('S1', 'SELF_REVIEW', 'SAME_AGENT_SELF_REVIEW', 'AUTHOR', 'FORK_A0', a0CallId),
      branchCall('S2', 'SELF_FINAL', 'SAME_AGENT_SELF_REVIEW', 'AUTHOR', 'CONTINUE_BRANCH', `${blockId}:S1`)
    ],
    P: [
      branchCall('P1', 'PEER_CRITIQUE', 'BLIND_PEER_CRITIQUE', 'PEER', 'FRESH', null),
      branchCall('AP1', 'AUTHOR_RESPONSE', 'BLIND_PEER_CRITIQUE', 'AUTHOR', 'FORK_A0', `${blockId}:P1`)
    ]
  };

  function branchCall(
    turnId: Exclude<HardPeer80TurnId, 'PROBE' | 'A0'>,
    stage: HardPeer80Stage,
    conditionId: Exclude<
      HardPeer80ConditionId,
      'BOUNDARY_PROBE' | 'CALIBRATION_INITIAL' | 'SHARED_INITIAL'
    >,
    actor: 'AUTHOR' | 'PEER',
    threadMode: HardPeer80CallAssignment['threadMode'],
    parentCallId: string | null
  ): Omit<HardPeer80CallAssignment, 'callNumber'> {
    const branch = turnId.startsWith('W')
      ? 'workbench'
      : turnId.startsWith('S')
        ? 'self'
        : turnId === 'P1'
          ? 'fresh-peer'
          : 'peer-author';
    return {
      callId: `${blockId}:${turnId}`,
      phase: 'EVALUATION',
      caseId,
      blockId,
      repetition,
      conditionId,
      turnId,
      stage,
      actor,
      sessionKey: `${blockId}:${branch}`,
      threadMode,
      parentCallId
    };
  }
}

function validateCaseIds(
  calibrationCaseIds: readonly string[],
  evaluationCaseIds: readonly string[]
): void {
  if (calibrationCaseIds.length !== 5 || evaluationCaseIds.length !== 5) {
    throw new Error('HARD-PEER-80 requires exactly five calibration and five evaluation cases.');
  }
  const all = [...calibrationCaseIds, ...evaluationCaseIds];
  if (new Set(all).size !== 10 || all.some((id) => !id.trim())) {
    throw new Error('HARD-PEER-80 case ids must be ten unique, non-empty ids.');
  }
}
