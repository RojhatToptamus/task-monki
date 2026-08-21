import path from 'node:path';
import {
  HARD_PEER_80_OUTPUT_JSON_SCHEMA,
  parseAndValidateHardPeer80Output,
  type HardPeer80PublicOutput,
  type HardPeer80VisibleArtifact
} from './hardPeer80Contracts';
import type {
  HardPeer80OracleCorpus,
  HardPeer80OracleRecord,
  HardPeer80ParticipantCorpus,
  HardPeer80ParticipantRecord,
  HardPeer80Partition
} from './hardPeer80Corpus';
import {
  assertHardPeer80Plan,
  type HardPeer80CallAssignment,
  type HardPeer80ForkInstruction,
  type HardPeer80Plan
} from './hardPeer80Plan';
import {
  HARD_PEER_80_PROBE_CASE,
  buildHardPeer80Prompt
} from './hardPeer80Prompts';
import { attestSemanticLabDriver } from './driverEligibility';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  sha256File,
  sha256Text,
  stableJson,
  type LabArtifactLedger,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import type {
  LabDriverForkResult,
  LabDriverPreflight,
  LabDriverSession,
  LabForkableTextDriver,
  LabTextCallResult,
  LabTokenUsage
} from './textDriver';

export const HARD_PEER_80_EXPERIMENT_VERSION =
  'hard-peer-80-terminal-experiment@v1' as const;

export type HardPeer80StopReason =
  | 'PREFLIGHT_INVALID'
  | 'BOUNDARY_PROBE_FAILED'
  | 'CALIBRATION_GATE_FAILED'
  | 'HARD_CALL_CAP'
  | 'HARD_TOKEN_RESERVATION'
  | 'HARD_TOKEN_CAP_OVERSHOOT'
  | 'HARD_EXPERIMENT_TIME'
  | 'PROVIDER_OR_BOUNDARY_FAILURE'
  | 'FORK_FAILURE'
  | 'OUTPUT_INVALID'
  | 'DRIVER_CLOSE_FAILED'
  | 'SCORING_UNAVAILABLE'
  | 'ARCHIVE_INVALID';

export type HardPeer80ProviderStage = 'PROBE' | 'CALIBRATION' | 'EVALUATION';

export interface HardPeer80CallObservation {
  assignment: HardPeer80CallAssignment;
  promptSha256: string;
  promptArtifactSha256: string;
  rawCallArtifactSha256: string;
  parsedOutputArtifactSha256: string;
  continuation: LabDriverSession | null;
  call: LabTextCallResult;
  output: HardPeer80PublicOutput | null;
  validationErrors: Array<{ path: string; code: string; message: string }>;
  latencyMs: number | null;
}

export interface HardPeer80ForkObservation {
  instruction: HardPeer80ForkInstruction | null;
  result: LabDriverForkResult;
  artifactSha256: string;
}

export interface HardPeer80DriverClose {
  status: 'CLEAN' | 'FAILED' | 'TIMED_OUT';
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  maximumMs: number;
  boundaryViolations: string[];
  failure?: { name: string; message: string };
  runtimeFiles: Array<{ path: string; sha256: string }>;
}

export interface HardPeer80StageRecord {
  stage: HardPeer80ProviderStage;
  runtimeRootRelative: string;
  preflight: LabDriverPreflight | null;
  calls: HardPeer80CallObservation[];
  forks: HardPeer80ForkObservation[];
  close: HardPeer80DriverClose;
  status: 'COMPLETED' | 'STOPPED';
  stopReason: HardPeer80StopReason | null;
  failure?: { name: string; message: string };
}

export interface HardPeer80AnswerScore {
  outputValid: boolean;
  statusCorrect: boolean;
  optionsCorrect: boolean;
  claimsCorrect: boolean;
  evidenceValid: boolean;
  certificateEligible: boolean;
  requestCorrect: boolean;
  abstentionCorrect: boolean;
  compositeCorrect: boolean;
  confidence: number | null;
  brier: number | null;
}

export interface HardPeer80ScoredBlock {
  blockId: string;
  caseId: string;
  repetition: 1 | 2;
  domain: string;
  initial: HardPeer80AnswerScore;
  workbench: HardPeer80AnswerScore;
  selfReview: HardPeer80AnswerScore;
  peer: HardPeer80AnswerScore;
  peerReview: Record<string, unknown>;
  critiqueAttributableCorrection: boolean;
  incrementalPeerCorrection: boolean;
  rightToWrongPeerContamination: boolean;
  inventedMaterialCriticism: number;
  harmfulInvalidCritiqueAdoption: boolean;
  unsupportedDefiniteClosure: boolean;
  falseDisagreementResolution: boolean;
  requiredUnresolvedOrRequestPreserved: boolean;
  conditionUsage: Record<'WORKBENCH' | 'SELF_REVIEW' | 'PEER', LabTokenUsage>;
  conditionLatencyMs: Record<'WORKBENCH' | 'SELF_REVIEW' | 'PEER', number>;
}

export interface HardPeer80Interpretation {
  status: 'PEER_PILOT_SUPPORTED' | 'SINGLE_AGENT_DEFAULT' | 'INCONCLUSIVE';
  informative: boolean;
  productPilotAuthorized: boolean;
  failedGates: string[];
  metrics: Record<string, unknown>;
}

export interface HardPeer80Scorer {
  scoreAnswer(oracle: HardPeer80OracleRecord, output: HardPeer80PublicOutput | null): HardPeer80AnswerScore;
  scoreBlocks(input: {
    plan: HardPeer80Plan;
    records: readonly HardPeer80ParticipantRecord[];
    oracles: readonly HardPeer80OracleRecord[];
    calls: readonly HardPeer80CallObservation[];
  }): { blocks: HardPeer80ScoredBlock[]; interpretation: HardPeer80Interpretation };
}

export interface HardPeer80TerminalResult {
  schemaVersion: 'task-monki/discourse-lab-hard-peer-80-result@v1';
  experimentVersion: typeof HARD_PEER_80_EXPERIMENT_VERSION;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'COMPLETED' | 'STOPPED';
  stopReason: HardPeer80StopReason | null;
  terminalStudy: true;
  confirmationOpened: false;
  productBehaviorChanged: false;
  reviewAuthorityChanged: false;
  plan: HardPeer80Plan;
  componentLocks: LabComponentLock;
  eligibility: Record<string, unknown>;
  stages: HardPeer80StageRecord[];
  calibration: {
    scored: boolean;
    compositeCorrect: number | null;
    gate: 'PASSED' | 'FAILED' | 'NOT_REACHED';
    scores: Array<{ caseId: string; score: HardPeer80AnswerScore }>;
  };
  evaluation: {
    scored: boolean;
    blocks: HardPeer80ScoredBlock[];
    interpretation: HardPeer80Interpretation;
  };
  accounting: {
    semanticCalls: number;
    providerTurnsStarted: number;
    forkMutations: number;
    usageKnownCalls: number;
    observedIncrementalUsage: LabTokenUsage;
    summedLatencyMs: number;
    targetOutputOvershootCalls: number;
    targetOutputOvershootTokens: number;
    safetyOutputOvershootCalls: number;
    safetyOutputOvershootTokens: number;
  };
  exclusions: [];
  stoppingReasons: HardPeer80StopReason[];
  archiveValidationRequired: true;
  candidateProductDecision:
    | 'SMALL_BOUNDED_PEER_PILOT'
    | 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW';
}

export interface RunHardPeer80TerminalInput {
  runId: string;
  fixtureRoot: string;
  plan: HardPeer80Plan;
  locks: LabComponentLock;
  eligibility: Record<string, unknown>;
  calibrationParticipants: HardPeer80ParticipantCorpus;
  evaluationParticipants: HardPeer80ParticipantCorpus;
  loadOracle: (partition: HardPeer80Partition) => Promise<HardPeer80OracleCorpus>;
  ledger: LabArtifactLedger;
  createDriver: (stage: HardPeer80ProviderStage) => {
    driver: LabForkableTextDriver;
    runtimeRoot: string;
  };
  scorer: HardPeer80Scorer;
  expectedModelProvider?: string;
  now?: () => number;
}

interface GlobalExecutionState {
  startedMs: number;
  deadlineMs: number;
  semanticCalls: number;
  usage: LabTokenUsage;
  summedLatencyMs: number;
  targetOvershootCalls: number;
  targetOvershootTokens: number;
  safetyOvershootCalls: number;
  safetyOvershootTokens: number;
  providerTurnsStarted: number;
  forkMutations: number;
  stoppingReasons: HardPeer80StopReason[];
  providerTurnIds: Set<string>;
  providerThreadIds: Set<string>;
  freshSessionTreeIds: Set<string>;
  now: () => number;
}

class HardPeer80TerminalStop extends Error {
  constructor(readonly reason: HardPeer80StopReason, message: string) {
    super(message);
    this.name = 'HardPeer80TerminalStop';
  }
}

export function buildHardPeer80Manifest(input: {
  runId: string;
  plan: HardPeer80Plan;
  locks: LabComponentLock;
  driverId: string;
  participantCaseIds: string[];
  createdAt?: string;
}): LabRunManifest {
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId: input.runId,
    phase: 'DEVELOPMENT',
    status: 'PLANNED',
    createdAt: input.createdAt ?? new Date().toISOString(),
    driver: {
      id: input.driverId,
      model: input.plan.model.id,
      modelProvider: 'openai',
      reasoningEffort: input.plan.model.reasoningEffort,
      serviceTier: input.plan.model.serviceTier,
      seed: null,
      seedControl: 'UNSUPPORTED',
      hardOutputTokenLimit: false,
      hardCallTimeLimit: true,
      textOnlyAttestation: 'HARNESS_DETECTED',
      boundaryClass: 'H1_DEVELOPMENT_HARNESS_VERIFIED',
      harnessVerifiedTextIsolation: true,
      streamingOutputTokenInterrupt: true,
      providerReportedTokenUsage: true
    },
    locks: structuredClone(input.locks),
    caseIds: [...input.participantCaseIds],
    conditionIds: ['BOUNDARY_PROBE', 'CALIBRATION_INITIAL', 'STRONG_WORKBENCH',
      'SAME_AGENT_SELF_REVIEW', 'BLIND_PEER_CRITIQUE'],
    budgets: {
      maximumCalls: input.plan.budget.maximumProviderCalls,
      maximumRounds: 3,
      maximumOutputTokens:
        input.plan.budget.maximumProviderCalls * input.plan.budget.targetOutputTokensPerCall,
      maximumOutputTokenSafetyCeiling:
        input.plan.budget.maximumProviderCalls *
        input.plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
      maximumObservedTotalTokens: input.plan.budget.maximumObservedTotalTokens,
      maximumCallMs: input.plan.budget.maximumCallMs,
      maximumExperimentMs: input.plan.budget.maximumExperimentMs
    },
    providerUsageExplicitlyAuthorized: true
  };
}

export async function runHardPeer80TerminalStudy(
  input: RunHardPeer80TerminalInput
): Promise<HardPeer80TerminalResult> {
  const now = input.now ?? Date.now;
  const startedMs = now();
  const state: GlobalExecutionState = {
    startedMs,
    deadlineMs: startedMs + input.plan.budget.maximumExperimentMs,
    semanticCalls: 0,
    usage: zeroUsage(),
    summedLatencyMs: 0,
    targetOvershootCalls: 0,
    targetOvershootTokens: 0,
    safetyOvershootCalls: 0,
    safetyOvershootTokens: 0,
    providerTurnsStarted: 0,
    forkMutations: 0,
    stoppingReasons: [],
    providerTurnIds: new Set<string>(),
    providerThreadIds: new Set<string>(),
    freshSessionTreeIds: new Set<string>(),
    now
  };
  assertHardPeer80Plan(
    input.plan,
    input.calibrationParticipants.records.map(({ caseId }) => caseId),
    input.evaluationParticipants.records.map(({ caseId }) => caseId)
  );
  input.ledger.assertRunContext('DEVELOPMENT', input.locks);
  await input.ledger.append({
    eventType: 'HARD_PEER_80_TERMINAL_STUDY_STARTED',
    occurredAt: new Date(startedMs).toISOString(),
    detail: { semanticCallCeiling: 76, tokenCeiling: 1_500_000 }
  });

  const stages: HardPeer80StageRecord[] = [];
  const calibrationScores: Array<{ caseId: string; score: HardPeer80AnswerScore }> = [];
  let calibrationGate: HardPeer80TerminalResult['calibration']['gate'] = 'NOT_REACHED';
  let evaluationBlocks: HardPeer80ScoredBlock[] = [];
  let interpretation = defaultInterpretation('NOT_RUN');
  let terminalStop: HardPeer80StopReason | null = null;

  try {
    const probe = await runProbeStage(input, state);
    stages.push(probe);
    if (probe.status !== 'COMPLETED') {
      throw new HardPeer80TerminalStop(
        probe.stopReason ?? 'BOUNDARY_PROBE_FAILED',
        'The one authorized boundary/output/fork probe failed.'
      );
    }

    const calibration = await runParticipantStage({
      input,
      state,
      stage: 'CALIBRATION',
      participants: input.calibrationParticipants,
      assignments: input.plan.assignments.filter(({ phase }) => phase === 'CALIBRATION')
    });
    stages.push(calibration);
    if (calibration.status !== 'COMPLETED') {
      throw new HardPeer80TerminalStop(
        calibration.stopReason ?? 'PROVIDER_OR_BOUNDARY_FAILURE',
        'Calibration did not complete cleanly.'
      );
    }
    const calibrationOracle = await input.loadOracle('CALIBRATION');
    assertOracleMatchesParticipants(calibrationOracle, input.calibrationParticipants);
    const calibrationOracleById = new Map(
      calibrationOracle.records.map((oracle) => [oracle.caseId, oracle])
    );
    for (const call of calibration.calls) {
      const oracle = calibrationOracleById.get(call.assignment.caseId!);
      if (!oracle) {
        throw new HardPeer80TerminalStop('SCORING_UNAVAILABLE', 'Calibration oracle missing.');
      }
      calibrationScores.push({
        caseId: oracle.caseId,
        score: input.scorer.scoreAnswer(oracle, call.output)
      });
    }
    const calibrationCorrect = calibrationScores.filter(
      ({ score }) => score.compositeCorrect
    ).length;
    if (!input.plan.calibrationGate.proceedOnCompositeCorrectCount.some(
      (accepted) => accepted === calibrationCorrect
    )) {
      calibrationGate = 'FAILED';
      throw new HardPeer80TerminalStop(
        'CALIBRATION_GATE_FAILED',
        `Calibration had ${calibrationCorrect}/5 composite-correct anchors; exactly 2 or 3 were required.`
      );
    }
    calibrationGate = 'PASSED';

    const evaluation = await runParticipantStage({
      input,
      state,
      stage: 'EVALUATION',
      participants: input.evaluationParticipants,
      assignments: input.plan.assignments.filter(({ phase }) => phase === 'EVALUATION')
    });
    stages.push(evaluation);
    if (evaluation.status !== 'COMPLETED') {
      throw new HardPeer80TerminalStop(
        evaluation.stopReason ?? 'PROVIDER_OR_BOUNDARY_FAILURE',
        'The locked evaluation did not complete cleanly.'
      );
    }
    const evaluationOracle = await input.loadOracle('EVALUATION');
    assertOracleMatchesParticipants(evaluationOracle, input.evaluationParticipants);
    const scored = input.scorer.scoreBlocks({
      plan: input.plan,
      records: input.evaluationParticipants.records,
      oracles: evaluationOracle.records,
      calls: evaluation.calls
    });
    evaluationBlocks = scored.blocks;
    interpretation = scored.interpretation;
  } catch (error) {
    if (error instanceof HardPeer80TerminalStop) {
      terminalStop = error.reason;
      state.stoppingReasons.push(error.reason);
    } else {
      terminalStop = 'PREFLIGHT_INVALID';
      state.stoppingReasons.push('PREFLIGHT_INVALID');
      await input.ledger.append({
        eventType: 'HARD_PEER_80_UNEXPECTED_FAILURE',
        occurredAt: new Date().toISOString(),
        detail: serializeError(error)
      });
    }
  }

  if (state.usage.totalTokens > input.plan.budget.maximumObservedTotalTokens) {
    terminalStop ??= 'HARD_TOKEN_CAP_OVERSHOOT';
    state.stoppingReasons.push('HARD_TOKEN_CAP_OVERSHOOT');
  }
  if (
    terminalStop === null &&
    (state.semanticCalls !== 76 || stages.filter(({ stage }) => stage === 'EVALUATION').length !== 1)
  ) {
    terminalStop = 'PREFLIGHT_INVALID';
    state.stoppingReasons.push('PREFLIGHT_INVALID');
  }
  if (terminalStop && interpretation.status === 'PEER_PILOT_SUPPORTED') {
    interpretation = defaultInterpretation('EXECUTION_STOPPED');
  }

  const completedAt = new Date(now()).toISOString();
  const productPilot = terminalStop === null && interpretation.productPilotAuthorized;
  const result: HardPeer80TerminalResult = {
    schemaVersion: 'task-monki/discourse-lab-hard-peer-80-result@v1',
    experimentVersion: HARD_PEER_80_EXPERIMENT_VERSION,
    runId: input.runId,
    startedAt: new Date(startedMs).toISOString(),
    completedAt,
    status: terminalStop ? 'STOPPED' : 'COMPLETED',
    stopReason: terminalStop,
    terminalStudy: true,
    confirmationOpened: false,
    productBehaviorChanged: false,
    reviewAuthorityChanged: false,
    plan: structuredClone(input.plan),
    componentLocks: structuredClone(input.locks),
    eligibility: structuredClone(input.eligibility),
    stages,
    calibration: {
      scored: calibrationScores.length > 0,
      compositeCorrect: calibrationScores.length > 0
        ? calibrationScores.filter(({ score }) => score.compositeCorrect).length
        : null,
      gate: calibrationGate,
      scores: calibrationScores
    },
    evaluation: {
      scored: evaluationBlocks.length === 10,
      blocks: evaluationBlocks,
      interpretation
    },
    accounting: {
      semanticCalls: state.semanticCalls,
      providerTurnsStarted: state.providerTurnsStarted,
      forkMutations: state.forkMutations,
      usageKnownCalls: stages.flatMap(({ calls }) => calls).filter(({ call }) => call.usage).length,
      observedIncrementalUsage: structuredClone(state.usage),
      summedLatencyMs: state.summedLatencyMs,
      targetOutputOvershootCalls: state.targetOvershootCalls,
      targetOutputOvershootTokens: state.targetOvershootTokens,
      safetyOutputOvershootCalls: state.safetyOvershootCalls,
      safetyOutputOvershootTokens: state.safetyOvershootTokens
    },
    exclusions: [],
    stoppingReasons: unique(state.stoppingReasons),
    archiveValidationRequired: true,
    candidateProductDecision: productPilot
      ? 'SMALL_BOUNDED_PEER_PILOT'
      : 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW'
  };
  await input.ledger.writeReport('hard-peer-80-terminal-result', result);
  await input.ledger.append({
    eventType: terminalStop
      ? 'HARD_PEER_80_TERMINAL_STUDY_STOPPED'
      : 'HARD_PEER_80_TERMINAL_STUDY_COMPLETED',
    occurredAt: completedAt,
    detail: {
      stopReason: terminalStop,
      semanticCalls: state.semanticCalls,
      observedTokens: state.usage.totalTokens,
      candidateProductDecision: result.candidateProductDecision
    }
  });
  return result;
}

async function runProbeStage(
  input: RunHardPeer80TerminalInput,
  state: GlobalExecutionState
): Promise<HardPeer80StageRecord> {
  const assignment = input.plan.assignments.find(({ phase }) => phase === 'BOUNDARY_PROBE');
  if (!assignment) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'Probe assignment missing.');
  const { driver, runtimeRoot } = input.createDriver('PROBE');
  let preflight: LabDriverPreflight | null = null;
  const calls: HardPeer80CallObservation[] = [];
  const forks: HardPeer80ForkObservation[] = [];
  let stopReason: HardPeer80StopReason | null = null;
  let failure: HardPeer80StageRecord['failure'];
  try {
    preflight = await preflightDriver(input, state, driver);
    const call = await executeSemanticCall({
      input,
      state,
      driver,
      assignment,
      record: { caseId: HARD_PEER_80_PROBE_CASE.caseId, domain: 'RIGOROUS_LOGIC',
        participantCase: HARD_PEER_80_PROBE_CASE },
      visibleArtifacts: [],
      continuation: null
    });
    calls.push(call);
    assertCallBoundary(call.call, null, input, state);
    if (!call.output || !call.call.session || !call.call.providerTurnId) {
      throw new HardPeer80TerminalStop('BOUNDARY_PROBE_FAILED', 'Probe output/session invalid.');
    }
    const result = await driver.fork({
      forkKey: 'probe:fork:one',
      sourceSession: call.call.session,
      model: input.plan.model.id,
      reasoningEffort: input.plan.model.reasoningEffort,
      serviceTier: input.plan.model.serviceTier,
      maximumForkMs: input.plan.budget.maximumCallMs,
      experimentDeadlineMs: state.deadlineMs
    });
    state.forkMutations += result.providerAccounting.forkMutationSubmitted === 'YES' ? 1 : 0;
    const artifact = await input.ledger.putArtifact({ kind: 'HARD_PEER_80_PROBE_FORK', result });
    forks.push({ instruction: null, result, artifactSha256: artifact.sha256 });
    assertForkResult(result, call.call, input.plan, state, 'probe:fork:one');
  } catch (error) {
    stopReason = stopReasonFrom(error, 'BOUNDARY_PROBE_FAILED');
    failure = serializeError(error);
    await recordStageFailure(input.ledger, 'PROBE', stopReason, failure);
  }
  const close = await closeDriver(driver, runtimeRoot, 30_000);
  if (close.status !== 'CLEAN') stopReason ??= 'DRIVER_CLOSE_FAILED';
  return {
    stage: 'PROBE', runtimeRootRelative: relativeRuntimeRoot(input.ledger, runtimeRoot),
    preflight, calls, forks, close,
    status: stopReason ? 'STOPPED' : 'COMPLETED', stopReason,
    ...(failure ? { failure } : {})
  };
}

async function runParticipantStage(args: {
  input: RunHardPeer80TerminalInput;
  state: GlobalExecutionState;
  stage: Extract<HardPeer80ProviderStage, 'CALIBRATION' | 'EVALUATION'>;
  participants: HardPeer80ParticipantCorpus;
  assignments: HardPeer80CallAssignment[];
}): Promise<HardPeer80StageRecord> {
  const { input, state, stage, participants, assignments } = args;
  const { driver, runtimeRoot } = input.createDriver(stage);
  let preflight: LabDriverPreflight | null = null;
  const calls: HardPeer80CallObservation[] = [];
  const forks: HardPeer80ForkObservation[] = [];
  let stopReason: HardPeer80StopReason | null = null;
  let failure: HardPeer80StageRecord['failure'];
  try {
    preflight = await preflightDriver(input, state, driver);
    const records = new Map(participants.records.map((record) => [record.caseId, record]));
    if (stage === 'CALIBRATION') {
      for (const assignment of assignments) {
        const record = records.get(assignment.caseId!);
        if (!record) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'Case missing.');
        const observation = await executeSemanticCall({
          input, state, driver, assignment, record, visibleArtifacts: [], continuation: null
        });
        calls.push(observation);
        assertCallBoundary(observation.call, null, input, state);
        if (!observation.output) {
          throw new HardPeer80TerminalStop('OUTPUT_INVALID', `${assignment.callId} invalid.`);
        }
      }
    } else {
      const blockIds = input.plan.schedule.evaluationBlockIds;
      const forkByBlock = new Map<string, HardPeer80ForkInstruction[]>();
      for (const fork of input.plan.forks) {
        const group = forkByBlock.get(fork.blockId) ?? [];
        group.push(fork);
        forkByBlock.set(fork.blockId, group);
      }
      for (const blockId of blockIds) {
        const blockAssignments = assignments.filter((assignment) => assignment.blockId === blockId);
        const a0Assignment = blockAssignments.find(({ turnId }) => turnId === 'A0');
        if (!a0Assignment) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'A0 missing.');
        const record = records.get(a0Assignment.caseId!);
        if (!record) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'Case missing.');
        const a0 = await executeSemanticCall({
          input, state, driver, assignment: a0Assignment, record,
          visibleArtifacts: [], continuation: null
        });
        calls.push(a0);
        assertCallBoundary(a0.call, null, input, state);
        if (!a0.output || !a0.call.session || !a0.call.providerTurnId) {
          throw new HardPeer80TerminalStop('OUTPUT_INVALID', `${blockId} A0 is invalid.`);
        }
        const branchSessions = new Map<string, LabDriverSession>();
        const instructions = forkByBlock.get(blockId) ?? [];
        if (instructions.length !== 3) {
          throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', `${blockId} fork plan invalid.`);
        }
        for (const instruction of instructions) {
          const result = await driver.fork({
            forkKey: instruction.forkId,
            sourceSession: a0.call.session,
            model: input.plan.model.id,
            reasoningEffort: input.plan.model.reasoningEffort,
            serviceTier: input.plan.model.serviceTier,
            maximumForkMs: input.plan.budget.maximumCallMs,
            experimentDeadlineMs: state.deadlineMs
          });
          state.forkMutations += result.providerAccounting.forkMutationSubmitted === 'YES' ? 1 : 0;
          const artifact = await input.ledger.putArtifact({
            kind: 'HARD_PEER_80_EVALUATION_FORK', instruction, result
          });
          forks.push({ instruction, result, artifactSha256: artifact.sha256 });
          assertForkResult(result, a0.call, input.plan, state, instruction.forkId);
          branchSessions.set(instruction.sessionKey, result.session!);
        }
        const outputByTurn = new Map<string, HardPeer80PublicOutput>([['A0', a0.output]]);
        const callById = new Map<string, HardPeer80CallObservation>([[a0.assignment.callId, a0]]);
        for (const assignment of blockAssignments.filter(({ turnId }) => turnId !== 'A0')) {
          const visibleArtifacts = visibleForAssignment(assignment, outputByTurn);
          const continuation = continuationForAssignment(
            assignment, branchSessions, callById
          );
          const observation = await executeSemanticCall({
            input, state, driver, assignment, record, visibleArtifacts, continuation
          });
          calls.push(observation);
          assertCallBoundary(observation.call, continuation, input, state);
          callById.set(assignment.callId, observation);
          if (!observation.output) {
            throw new HardPeer80TerminalStop('OUTPUT_INVALID', `${assignment.callId} invalid.`);
          }
          outputByTurn.set(assignment.turnId, observation.output);
        }
      }
    }
  } catch (error) {
    stopReason = stopReasonFrom(error, 'PROVIDER_OR_BOUNDARY_FAILURE');
    failure = serializeError(error);
    await recordStageFailure(input.ledger, stage, stopReason, failure);
  }
  const close = await closeDriver(driver, runtimeRoot, 30_000);
  if (close.status !== 'CLEAN') stopReason ??= 'DRIVER_CLOSE_FAILED';
  return {
    stage, runtimeRootRelative: relativeRuntimeRoot(input.ledger, runtimeRoot),
    preflight, calls, forks, close,
    status: stopReason ? 'STOPPED' : 'COMPLETED', stopReason,
    ...(failure ? { failure } : {})
  };
}

async function executeSemanticCall(args: {
  input: RunHardPeer80TerminalInput;
  state: GlobalExecutionState;
  driver: LabForkableTextDriver;
  assignment: HardPeer80CallAssignment;
  record: HardPeer80ParticipantRecord;
  visibleArtifacts: HardPeer80VisibleArtifact[];
  continuation: LabDriverSession | null;
}): Promise<HardPeer80CallObservation> {
  const { input, state, driver, assignment, record, visibleArtifacts, continuation } = args;
  assertDispatchBudget(input.plan, state);
  const prepared = buildHardPeer80Prompt({
    participantCase: record.participantCase,
    assignment,
    visibleArtifacts
  });
  const promptArtifact = await input.ledger.putArtifact({
    kind: 'HARD_PEER_80_PROMPT', assignment, prompt: prepared.prompt, context: prepared.context
  });
  await input.ledger.append({
    eventType: 'HARD_PEER_80_CALL_SUBMITTED',
    occurredAt: new Date().toISOString(),
    caseId: assignment.caseId ?? undefined,
    conditionId: assignment.conditionId,
    callId: assignment.callId,
    artifactSha256: promptArtifact.sha256
  });
  state.semanticCalls += 1;
  const call = await driver.call({
    callKey: assignment.callId,
    prompt: prepared.prompt,
    outputSchema: HARD_PEER_80_OUTPUT_JSON_SCHEMA as Record<string, unknown>,
    model: input.plan.model.id,
    reasoningEffort: input.plan.model.reasoningEffort,
    serviceTier: input.plan.model.serviceTier,
    ...(continuation ? { continuation } : {}),
    maximumOutputTokens: input.plan.budget.targetOutputTokensPerCall,
    outputTokenSafetyCeiling:
      input.plan.budget.emergencyOutputTokenSafetyCeilingPerCall,
    maximumCallMs: input.plan.budget.maximumCallMs,
    experimentDeadlineMs: state.deadlineMs
  });
  if (call.providerAccounting.providerTurnStarted === 'YES') state.providerTurnsStarted += 1;
  const latencyMs = elapsed(call.submittedAt, call.completedAt);
  if (latencyMs !== null) state.summedLatencyMs += latencyMs;
  const usage = completeUsage(call);
  if (usage) state.usage = addUsage(state.usage, usage);
  const targetOvershoot = call.tokenControl?.targetOvershootTokens ?? 0;
  const safetyOvershoot = call.tokenControl?.safetyOvershootTokens ?? 0;
  if (targetOvershoot > 0) {
    state.targetOvershootCalls += 1;
    state.targetOvershootTokens += targetOvershoot;
  }
  if (safetyOvershoot > 0) {
    state.safetyOvershootCalls += 1;
    state.safetyOvershootTokens += safetyOvershoot;
  }
  const rawCallArtifact = await input.ledger.putArtifact({
    kind: 'HARD_PEER_80_RAW_CALL', assignment, continuation, call, latencyMs
  });
  const validation = parseAndValidateHardPeer80Output(call.rawText, prepared.context);
  const output = validation.ok ? validation.value : null;
  const validationErrors = validation.ok ? [] : validation.errors.map(({ path, code, message }) => ({
    path, code, message
  }));
  const parsedArtifact = await input.ledger.putArtifact({
    kind: 'HARD_PEER_80_PARSED_OUTPUT',
    assignment,
    rawCallArtifactSha256: rawCallArtifact.sha256,
    output,
    validationErrors
  });
  await input.ledger.append({
    eventType: call.failure || !output
      ? 'HARD_PEER_80_CALL_INVALID'
      : 'HARD_PEER_80_CALL_COMPLETED',
    occurredAt: call.completedAt,
    caseId: assignment.caseId ?? undefined,
    conditionId: assignment.conditionId,
    callId: assignment.callId,
    artifactSha256: parsedArtifact.sha256,
    detail: {
      rawCallArtifactSha256: rawCallArtifact.sha256,
      semanticCalls: state.semanticCalls,
      observedTokens: state.usage.totalTokens,
      validationErrors
    }
  });
  return {
    assignment: structuredClone(assignment),
    promptSha256: sha256Text(prepared.prompt),
    promptArtifactSha256: promptArtifact.sha256,
    rawCallArtifactSha256: rawCallArtifact.sha256,
    parsedOutputArtifactSha256: parsedArtifact.sha256,
    continuation: continuation ? structuredClone(continuation) : null,
    call,
    output,
    validationErrors,
    latencyMs
  };
}

async function preflightDriver(
  input: RunHardPeer80TerminalInput,
  state: GlobalExecutionState,
  driver: LabForkableTextDriver
): Promise<LabDriverPreflight> {
  return attestSemanticLabDriver(driver, {
    model: input.plan.model.id,
    reasoningEffort: input.plan.model.reasoningEffort,
    serviceTier: input.plan.model.serviceTier
  }, {
    maximumCallMs: input.plan.budget.maximumCallMs,
    experimentDeadlineMs: state.deadlineMs
  }, 'H1_DEVELOPMENT_HARNESS_VERIFIED');
}

function assertDispatchBudget(plan: HardPeer80Plan, state: GlobalExecutionState): void {
  if (state.now() >= state.deadlineMs) {
    throw new HardPeer80TerminalStop('HARD_EXPERIMENT_TIME', 'Five-hour deadline exhausted.');
  }
  if (state.semanticCalls >= plan.budget.maximumProviderCalls) {
    throw new HardPeer80TerminalStop('HARD_CALL_CAP', 'The 76-call schedule is exhausted.');
  }
  if (
    state.usage.totalTokens + plan.budget.maximumNextCallObservedTokenReservation >
    plan.budget.maximumObservedTotalTokens
  ) {
    throw new HardPeer80TerminalStop(
      'HARD_TOKEN_RESERVATION',
      'The conservative next-call reservation would cross 1.5 million observed tokens.'
    );
  }
}

function assertCallBoundary(
  call: LabTextCallResult,
  continuation: LabDriverSession | null,
  input: RunHardPeer80TerminalInput,
  state: GlobalExecutionState
): void {
  const problems: string[] = [];
  if (call.failure) problems.push(`failure:${call.failure.kind}`);
  if (!call.session || !call.providerTurnId) problems.push('session-or-turn');
  if (call.requestedModel !== input.plan.model.id || call.observedModel !== input.plan.model.id) {
    problems.push('model');
  }
  if (input.expectedModelProvider && call.observedModelProvider !== input.expectedModelProvider) {
    problems.push('model-provider');
  }
  if (
    call.requestedReasoningEffort !== input.plan.model.reasoningEffort ||
    call.observedReasoningEffort !== input.plan.model.reasoningEffort
  ) problems.push('reasoning-effort');
  if (
    call.requestedServiceTier !== input.plan.model.serviceTier ||
    call.observedServiceTier !== input.plan.model.serviceTier
  ) problems.push('service-tier');
  if (call.seed !== null) problems.push('seed');
  if (call.providerStatus !== 'completed') problems.push('provider-status');
  if (call.providerAccounting.sessionAttestation !== 'ATTESTED') problems.push('session-attestation');
  if (call.providerAccounting.providerTurnStarted !== 'YES') problems.push('turn-start');
  if (continuation) {
    if (call.providerAccounting.threadStartStatus !== 'NOT_REQUIRED') problems.push('continuation-start');
    if (call.session?.providerThreadId !== continuation.providerThreadId) problems.push('continuation-thread');
    if (call.session?.driverId !== continuation.driverId) problems.push('continuation-driver');
    if (call.session?.providerSessionTreeId !== continuation.providerSessionTreeId) {
      problems.push('continuation-session-tree');
    }
    if (call.session && !state.providerThreadIds.has(call.session.providerThreadId)) {
      problems.push('unknown-continuation-thread');
    }
  } else if (call.providerAccounting.threadStartStatus !== 'ATTESTED') {
    problems.push('fresh-start');
  } else if (call.session) {
    if (!call.session.providerSessionTreeId) problems.push('fresh-session-tree');
    if (state.providerThreadIds.has(call.session.providerThreadId)) {
      problems.push('fresh-thread-reuse');
    }
    if (
      call.session.providerSessionTreeId &&
      state.freshSessionTreeIds.has(call.session.providerSessionTreeId)
    ) {
      problems.push('fresh-session-tree-reuse');
    }
  }
  if (!completeUsage(call)) problems.push('usage');
  if (call.violations.length > 0) problems.push('violations');
  if (call.tokenControl?.usageStatus !== 'PROVIDER_REPORTED') problems.push('usage-status');
  if ((call.tokenControl?.safetyOvershootTokens ?? 0) > 0) problems.push('safety-overshoot');
  const latency = elapsed(call.submittedAt, call.completedAt);
  if (latency === null || latency > input.plan.budget.maximumCallMs + 6_000) problems.push('latency');
  if (call.providerTurnId && state.providerTurnIds.has(call.providerTurnId)) problems.push('turn-reuse');
  if (call.providerTurnId) state.providerTurnIds.add(call.providerTurnId);
  if (state.usage.totalTokens > input.plan.budget.maximumObservedTotalTokens) {
    problems.push('aggregate-token-overshoot');
  }
  if (problems.length > 0) {
    throw new HardPeer80TerminalStop(
      problems.includes('aggregate-token-overshoot')
        ? 'HARD_TOKEN_CAP_OVERSHOOT'
        : 'PROVIDER_OR_BOUNDARY_FAILURE',
      `Provider call boundary failed: ${problems.join(', ')}.`
    );
  }
  if (!continuation && call.session) {
    state.providerThreadIds.add(call.session.providerThreadId);
    state.freshSessionTreeIds.add(call.session.providerSessionTreeId!);
  }
}

function assertForkResult(
  result: LabDriverForkResult,
  sourceCall: LabTextCallResult,
  plan: HardPeer80Plan,
  state: GlobalExecutionState,
  expectedForkKey: string
): void {
  const problems: string[] = [];
  if (result.failure || result.violations.length > 0) problems.push('failure');
  if (!result.session || !sourceCall.session || !sourceCall.providerTurnId) problems.push('session');
  if (result.forkKey !== expectedForkKey) problems.push('fork-key');
  if (stableJson(result.sourceSession) !== stableJson(sourceCall.session)) {
    problems.push('source-thread');
  }
  if (result.session?.providerThreadId === sourceCall.session?.providerThreadId) problems.push('child-thread');
  if (!sourceCall.session?.providerSessionTreeId || !result.session?.providerSessionTreeId) {
    problems.push('session-tree-missing');
  }
  if (result.session?.providerSessionTreeId !== sourceCall.session?.providerSessionTreeId) {
    problems.push('session-tree');
  }
  if (result.session?.driverId !== sourceCall.session?.driverId) problems.push('child-driver');
  if (sourceCall.session && !state.providerThreadIds.has(sourceCall.session.providerThreadId)) {
    problems.push('unknown-source-thread');
  }
  if (result.session && state.providerThreadIds.has(result.session.providerThreadId)) {
    problems.push('child-thread-reuse');
  }
  if (stableJson(result.inheritedProviderTurnIds) !== stableJson([sourceCall.providerTurnId])) {
    problems.push('inherited-turns');
  }
  if (result.requestedModel !== plan.model.id) problems.push('requested-model');
  if (result.observedModel !== plan.model.id) problems.push('model');
  if (result.requestedReasoningEffort !== plan.model.reasoningEffort) problems.push('requested-effort');
  if (result.observedReasoningEffort !== plan.model.reasoningEffort) problems.push('effort');
  if (result.requestedServiceTier !== plan.model.serviceTier) problems.push('requested-tier');
  if (result.observedServiceTier !== plan.model.serviceTier) problems.push('tier');
  if (
    result.providerAccounting.forkMutationSubmitted !== 'YES' ||
    result.providerAccounting.forkMutationAcknowledged !== 'YES' ||
    result.providerAccounting.providerTurnStarted !== 'NO' ||
    result.providerAccounting.billableModelCall !== 'NO'
  ) problems.push('accounting');
  if (problems.length > 0) {
    throw new HardPeer80TerminalStop('FORK_FAILURE', `Fork boundary failed: ${problems.join(', ')}.`);
  }
  state.providerThreadIds.add(result.session!.providerThreadId);
}

function visibleForAssignment(
  assignment: HardPeer80CallAssignment,
  outputs: ReadonlyMap<string, HardPeer80PublicOutput>
): HardPeer80VisibleArtifact[] {
  const a0 = outputs.get('A0');
  if (!a0) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'A0 output missing.');
  const position: HardPeer80VisibleArtifact = {
    artifactId: 'A0', artifactKind: 'POSITION', actor: 'AUTHOR', output: a0
  };
  switch (assignment.turnId) {
    case 'W1':
    case 'S1':
    case 'P1':
      return [position];
    case 'W2':
      return [position, reviewArtifact('W1', 'AUTHOR', outputs)];
    case 'S2':
      return [position, reviewArtifact('S1', 'AUTHOR', outputs)];
    case 'AP1':
      return [position, reviewArtifact('P1', 'PEER', outputs)];
    default:
      throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'Unexpected branch turn.');
  }
}

function reviewArtifact(
  artifactId: 'W1' | 'S1' | 'P1',
  actor: 'AUTHOR' | 'PEER',
  outputs: ReadonlyMap<string, HardPeer80PublicOutput>
): HardPeer80VisibleArtifact {
  const output = outputs.get(artifactId);
  if (!output) throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', `${artifactId} missing.`);
  return { artifactId, artifactKind: 'REVIEW', actor, output };
}

function continuationForAssignment(
  assignment: HardPeer80CallAssignment,
  branchSessions: ReadonlyMap<string, LabDriverSession>,
  calls: ReadonlyMap<string, HardPeer80CallObservation>
): LabDriverSession | null {
  if (assignment.threadMode === 'FRESH') return null;
  if (assignment.threadMode === 'FORK_A0') {
    const session = branchSessions.get(assignment.sessionKey);
    if (!session) throw new HardPeer80TerminalStop('FORK_FAILURE', 'Branch fork missing.');
    return session;
  }
  const parent = assignment.parentCallId ? calls.get(assignment.parentCallId) : undefined;
  if (!parent?.call.session) {
    throw new HardPeer80TerminalStop('PREFLIGHT_INVALID', 'Continuation parent missing.');
  }
  return parent.call.session;
}

async function closeDriver(
  driver: LabForkableTextDriver,
  runtimeRoot: string,
  maximumMs: number
): Promise<HardPeer80DriverClose> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let status: HardPeer80DriverClose['status'] = 'CLEAN';
  let failure: HardPeer80DriverClose['failure'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      driver.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Driver close timed out.')), maximumMs);
      })
    ]);
  } catch (error) {
    status = error instanceof Error && error.message.includes('timed out') ? 'TIMED_OUT' : 'FAILED';
    failure = serializeError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const boundaryViolations = 'getProcessBoundaryViolations' in driver &&
    typeof driver.getProcessBoundaryViolations === 'function'
    ? (driver.getProcessBoundaryViolations as () => string[])()
    : [];
  if (boundaryViolations.length > 0) status = 'FAILED';
  let runtimeFiles: HardPeer80DriverClose['runtimeFiles'] = [];
  try {
    runtimeFiles = await hashRuntimeFiles(runtimeRoot);
    if (runtimeFiles.length === 0) {
      throw new Error('Provider runtime archive is empty.');
    }
  } catch (error) {
    status = 'FAILED';
    failure ??= serializeError(error);
  }
  const completedMs = Date.now();
  return {
    status,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    elapsedMs: completedMs - startedMs,
    maximumMs,
    boundaryViolations,
    ...(failure ? { failure } : {}),
    runtimeFiles
  };
}

async function recordStageFailure(
  ledger: LabArtifactLedger,
  stage: HardPeer80ProviderStage,
  stopReason: HardPeer80StopReason,
  failure: { name: string; message: string }
): Promise<void> {
  const artifact = await ledger.putArtifact({
    kind: 'HARD_PEER_80_STAGE_FAILURE',
    stage,
    stopReason,
    failure
  });
  await ledger.append({
    eventType: 'HARD_PEER_80_STAGE_FAILED',
    occurredAt: new Date().toISOString(),
    artifactSha256: artifact.sha256,
    detail: { stage, stopReason }
  });
}

async function hashRuntimeFiles(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const fs = await import('node:fs/promises');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Runtime archive contains a symlink.');
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  await walk(root);
  return Promise.all(files.sort().map(async (file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: await sha256File(file)
  })));
}

function assertOracleMatchesParticipants(
  oracle: HardPeer80OracleCorpus,
  participants: HardPeer80ParticipantCorpus
): void {
  if (
    oracle.partition !== participants.partition ||
    stableJson(oracle.records.map(({ caseId }) => caseId).sort()) !==
      stableJson(participants.records.map(({ caseId }) => caseId).sort())
  ) {
    throw new HardPeer80TerminalStop('SCORING_UNAVAILABLE', 'Oracle partition mismatch.');
  }
}

function completeUsage(call: LabTextCallResult): LabTokenUsage | null {
  const usage = call.usage?.last;
  if (!usage) return null;
  return Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0)
    ? usage
    : null;
}

function addUsage(left: LabTokenUsage, right: LabTokenUsage): LabTokenUsage {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens
  };
}

function zeroUsage(): LabTokenUsage {
  return {
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0
  };
}

function elapsed(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function stopReasonFrom(error: unknown, fallback: HardPeer80StopReason): HardPeer80StopReason {
  return error instanceof HardPeer80TerminalStop ? error.reason : fallback;
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function defaultInterpretation(reason: string): HardPeer80Interpretation {
  return {
    status: 'INCONCLUSIVE',
    informative: false,
    productPilotAuthorized: false,
    failedGates: [reason],
    metrics: {}
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function relativeRuntimeRoot(ledger: LabArtifactLedger, runtimeRoot: string): string {
  const relative = path.relative(ledger.runDirectory, runtimeRoot);
  if (
    relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new HardPeer80TerminalStop(
      'ARCHIVE_INVALID',
      'Provider runtime evidence must be a child of the immutable run directory.'
    );
  }
  return relative.split(path.sep).join('/');
}
