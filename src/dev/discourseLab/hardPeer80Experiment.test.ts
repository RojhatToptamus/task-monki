import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditHardPeer80Archive } from './hardPeer80Archive';
import {
  HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
  type HardPeer80PublicOutput
} from './hardPeer80Contracts';
import {
  loadHardPeer80OracleCorpus,
  loadHardPeer80ParticipantCorpus,
  type HardPeer80OracleCorpus,
  type HardPeer80OracleRecord,
  type HardPeer80ParticipantCorpus
} from './hardPeer80Corpus';
import {
  buildHardPeer80Manifest,
  runHardPeer80TerminalStudy,
  type HardPeer80AnswerScore,
  type HardPeer80ProviderStage,
  type HardPeer80ScoredBlock,
  type HardPeer80Scorer,
  type HardPeer80TerminalResult
} from './hardPeer80Experiment';
import { buildHardPeer80Plan, type HardPeer80Plan } from './hardPeer80Plan';
import {
  LabArtifactLedger,
  stableJson,
  type LabComponentLock
} from './ledger';
import type {
  LabBoundaryProbeInput,
  LabDriverCapabilities,
  LabDriverForkInput,
  LabDriverForkResult,
  LabDriverPreflight,
  LabDriverSession,
  LabForkableTextDriver,
  LabTextCallInput,
  LabTextCallResult,
  LabTokenUsage
} from './textDriver';
import type { LabParticipantCase } from './contracts';

const FIXTURE_ROOT = path.resolve('evaluation/discourse-lab');
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('HARD-PEER-80 terminal execution', () => {
  it('stops permanently after exactly the probe plus five calibration calls when the gate fails', async () => {
    const run = await executeStudy({ calibrationCorrect: 0 });

    expect(run.result).toMatchObject({
      status: 'STOPPED',
      stopReason: 'CALIBRATION_GATE_FAILED',
      calibration: { gate: 'FAILED', compositeCorrect: 0 },
      evaluation: { scored: false, blocks: [] },
      accounting: { semanticCalls: 6, providerTurnsStarted: 6, forkMutations: 1 },
      candidateProductDecision: 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW'
    });
    expect(run.result.stages.map(({ stage }) => stage)).toEqual(['PROBE', 'CALIBRATION']);
    expect(run.trace.filter(({ kind }) => kind === 'call')).toHaveLength(6);
    expect(run.trace.filter(({ kind }) => kind === 'fork')).toHaveLength(1);
    expect(run.drivers.has('EVALUATION')).toBe(false);
  });

  it('executes exactly 76 semantic calls and 31 non-model forks with isolated branch ancestry', async () => {
    const run = await executeStudy({ calibrationCorrect: 2 });

    expect(run.result).toMatchObject({
      status: 'COMPLETED',
      stopReason: null,
      accounting: { semanticCalls: 76, providerTurnsStarted: 76, forkMutations: 31 },
      calibration: { gate: 'PASSED', compositeCorrect: 2 },
      evaluation: { scored: true }
    });
    expect(run.result.stages.map(({ stage }) => stage)).toEqual([
      'PROBE', 'CALIBRATION', 'EVALUATION'
    ]);
    expect(run.result.stages.every(({ close }) => close.status === 'CLEAN')).toBe(true);
    expect(run.trace.filter(({ kind }) => kind === 'call')).toHaveLength(76);
    expect(run.trace.filter(({ kind }) => kind === 'fork')).toHaveLength(31);

    const evaluation = run.result.stages.find(({ stage }) => stage === 'EVALUATION')!;
    expect(evaluation.calls).toHaveLength(70);
    expect(evaluation.forks).toHaveLength(30);
    const evaluationTrace = run.trace.filter(({ stage }) => stage === 'EVALUATION');
    const a0Trees = new Set<string>();
    for (const blockId of run.plan.schedule.evaluationBlockIds) {
      const blockCalls = evaluation.calls.filter(({ assignment }) => assignment.blockId === blockId);
      const a0 = blockCalls.find(({ assignment }) => assignment.turnId === 'A0')!;
      const blockForks = evaluation.forks.filter(({ instruction }) => instruction?.blockId === blockId);
      const blockTrace = evaluationTrace.filter(({ key }) => key.startsWith(`${blockId}:`));
      const firstBranchIndex = blockTrace.findIndex(({ kind, key }) =>
        kind === 'call' && key !== `${blockId}:A0`
      );
      const forkIndexes = blockTrace
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.kind === 'fork')
        .map(({ index }) => index);

      expect(blockCalls).toHaveLength(7);
      expect(blockForks).toHaveLength(3);
      expect(blockTrace[0]).toMatchObject({ kind: 'call', key: `${blockId}:A0` });
      expect(forkIndexes).toHaveLength(3);
      expect(forkIndexes.every((index) => index > 0 && index < firstBranchIndex)).toBe(true);

      const a0Session = a0.call.session!;
      expect(a0Trees.has(a0Session.providerSessionTreeId!)).toBe(false);
      a0Trees.add(a0Session.providerSessionTreeId!);
      const childThreads = new Set<string>();
      for (const fork of blockForks) {
        expect(fork.result.sourceSession).toEqual(a0Session);
        expect(fork.result.inheritedProviderTurnIds).toEqual([a0.call.providerTurnId]);
        expect(fork.result.session?.providerSessionTreeId).toBe(a0Session.providerSessionTreeId);
        expect(fork.result.session?.providerThreadId).not.toBe(a0Session.providerThreadId);
        expect(childThreads.has(fork.result.session!.providerThreadId)).toBe(false);
        childThreads.add(fork.result.session!.providerThreadId);

        const firstBranch = blockCalls.find(
          ({ assignment }) => assignment.callId === fork.instruction!.firstBranchCallId
        )!;
        expect(firstBranch.continuation).toEqual(fork.result.session);
        expect(firstBranch.call.session).toEqual(fork.result.session);
      }

      const p1 = blockCalls.find(({ assignment }) => assignment.turnId === 'P1')!;
      expect(p1.continuation).toBeNull();
      expect(p1.call.session?.providerThreadId).not.toBe(a0Session.providerThreadId);
      expect(p1.call.session?.providerSessionTreeId).not.toBe(a0Session.providerSessionTreeId);
      expect(childThreads.has(p1.call.session!.providerThreadId)).toBe(false);

      for (const [finalTurn, priorTurn] of [['W2', 'W1'], ['S2', 'S1']] as const) {
        const final = blockCalls.find(({ assignment }) => assignment.turnId === finalTurn)!;
        const prior = blockCalls.find(({ assignment }) => assignment.turnId === priorTurn)!;
        expect(final.call.session).toEqual(prior.call.session);
      }
    }
  });

  it('persists invalid output and stops without retrying it', async () => {
    const run = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { CALIBRATION: { invalidCallKey: 'cal:1:A0' } }
    });

    expect(run.result).toMatchObject({
      status: 'STOPPED', stopReason: 'OUTPUT_INVALID',
      accounting: { semanticCalls: 2, providerTurnsStarted: 2 }
    });
    const calibration = run.result.stages.find(({ stage }) => stage === 'CALIBRATION')!;
    expect(calibration.calls).toHaveLength(1);
    expect(calibration.calls[0]).toMatchObject({ output: null });
    expect(calibration.calls[0]!.validationErrors.length).toBeGreaterThan(0);
    expect(run.trace.filter(({ kind, key }) => kind === 'call' && key === 'cal:1:A0'))
      .toHaveLength(1);
    await expect(fs.readFile(
      path.join(run.ledger.runDirectory, 'artifacts', `${calibration.calls[0]!.rawCallArtifactSha256}.json`),
      'utf8'
    )).resolves.toContain('not-json');
  });

  it('rejects reused fork children before any evaluation branch can run', async () => {
    const run = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { EVALUATION: { reuseForkChild: true } }
    });

    expect(run.result).toMatchObject({
      status: 'STOPPED', stopReason: 'FORK_FAILURE',
      accounting: { semanticCalls: 7, forkMutations: 3 }
    });
    const evaluation = run.result.stages[2]!;
    expect(evaluation.calls.map(({ assignment }) => assignment.turnId)).toEqual(['A0']);
    expect(evaluation.forks).toHaveLength(2);
    expect(evaluation.forks[0]!.result.session?.providerThreadId)
      .toBe(evaluation.forks[1]!.result.session?.providerThreadId);
    expect(run.trace.some(({ kind, key }) =>
      kind === 'call' && key.startsWith('eval:') && !key.endsWith(':A0')
    )).toBe(false);
  });

  it('preserves a thrown call, a returned provider failure, and an unclean close without retry', async () => {
    const thrown = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { CALIBRATION: { throwCallKey: 'cal:1:A0' } }
    });
    expect(thrown.result).toMatchObject({
      status: 'STOPPED', stopReason: 'PROVIDER_OR_BOUNDARY_FAILURE',
      accounting: { semanticCalls: 2, providerTurnsStarted: 1 }
    });
    const thrownStage = thrown.result.stages[1]!;
    expect(thrownStage).toMatchObject({
      status: 'STOPPED',
      failure: { name: 'Error', message: 'synthetic thrown provider failure' },
      close: { status: 'CLEAN' }
    });
    expect(thrownStage.calls).toHaveLength(0);
    expect(thrown.trace.filter(({ kind, key }) => kind === 'call' && key === 'cal:1:A0'))
      .toHaveLength(1);
    expect(await readEvents(thrown.ledger)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'HARD_PEER_80_CALL_SUBMITTED', callId: 'cal:1:A0' }),
      expect.objectContaining({
        eventType: 'HARD_PEER_80_STAGE_FAILED',
        detail: { stage: 'CALIBRATION', stopReason: 'PROVIDER_OR_BOUNDARY_FAILURE' }
      })
    ]));
    const thrownAudit = await auditHardPeer80Archive({
      ledger: thrown.ledger,
      result: thrown.result,
      scorer: thrown.scorer,
      calibrationParticipants: thrown.calibrationParticipants,
      evaluationParticipants: thrown.evaluationParticipants,
      calibrationOracle: thrown.calibrationOracle,
      evaluationOracle: thrown.evaluationOracle
    });
    expect(thrownAudit).toMatchObject({
      status: 'PASSED', semanticCallCount: 2,
      finalProductDecision: 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW'
    });

    const returned = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { CALIBRATION: { failedCallKey: 'cal:1:A0' } }
    });
    const returnedCall = returned.result.stages[1]!.calls[0]!;
    expect(returned.result.stopReason).toBe('PROVIDER_OR_BOUNDARY_FAILURE');
    expect(returnedCall.call.failure).toEqual({
      kind: 'PROVIDER_ERROR', message: 'synthetic returned provider failure'
    });
    expect(returnedCall.rawCallArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(returned.trace.filter(({ kind, key }) => kind === 'call' && key === 'cal:1:A0'))
      .toHaveLength(1);

    const closeFailed = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { CALIBRATION: { closeFailure: true } }
    });
    expect(closeFailed.result).toMatchObject({
      status: 'STOPPED', stopReason: 'DRIVER_CLOSE_FAILED',
      accounting: { semanticCalls: 6 }
    });
    expect(closeFailed.result.stages[1]!.close).toMatchObject({
      status: 'FAILED', failure: { name: 'Error', message: 'synthetic close failure' }
    });
    expect(closeFailed.trace.filter(({ kind, stage }) =>
      kind === 'close' && stage === 'CALIBRATION'
    )).toHaveLength(1);
  });

  it('fails closed on token reservation, aggregate overshoot, elapsed time, and output safety', async () => {
    const reservation = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { PROBE: { totalTokens: 1_480_000 } }
    });
    expect(reservation.result).toMatchObject({
      status: 'STOPPED', stopReason: 'HARD_TOKEN_RESERVATION',
      accounting: {
        semanticCalls: 1,
        observedIncrementalUsage: { totalTokens: 1_480_000 }
      }
    });

    const overshoot = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { PROBE: { totalTokens: 1_500_001 } }
    });
    expect(overshoot.result).toMatchObject({
      status: 'STOPPED', stopReason: 'HARD_TOKEN_CAP_OVERSHOOT',
      accounting: { semanticCalls: 1 }
    });
    expect(overshoot.result.stoppingReasons).toEqual(['HARD_TOKEN_CAP_OVERSHOOT']);

    const start = Date.now();
    let nowIndex = 0;
    const times = [start, start, start + 18_000_000, start + 18_000_001];
    const timed = await executeStudy({
      calibrationCorrect: 2,
      now: () => times[Math.min(nowIndex++, times.length - 1)]!
    });
    expect(timed.result).toMatchObject({
      status: 'STOPPED', stopReason: 'HARD_EXPERIMENT_TIME',
      accounting: { semanticCalls: 1, forkMutations: 1 }
    });

    const safety = await executeStudy({
      calibrationCorrect: 2,
      stageBehaviors: { PROBE: { safetyOvershootTokens: 1 } }
    });
    expect(safety.result).toMatchObject({
      status: 'STOPPED', stopReason: 'PROVIDER_OR_BOUNDARY_FAILURE',
      accounting: {
        semanticCalls: 1,
        safetyOutputOvershootCalls: 1,
        safetyOutputOvershootTokens: 1
      }
    });
    expect(safety.result.stages[0]!.calls[0]!.call.tokenControl)
      .toMatchObject({ safetyOvershootTokens: 1 });
  });
});

describe('HARD-PEER-80 independent archive audit', () => {
  let baseline: Awaited<ReturnType<typeof executeStudy>> | undefined;

  async function completedBaseline(): Promise<Awaited<ReturnType<typeof executeStudy>>> {
    baseline ??= await executeStudy({ calibrationCorrect: 2 });
    return baseline;
  }

  it('passes a complete untampered archive reconstructed from disk', async () => {
    const source = await completedBaseline();
    const copy = await copyArchive(source);
    const audit = await auditCopiedArchive(source, copy);

    expect(audit).toMatchObject({
      status: 'PASSED', semanticCallCount: 76, forkMutationCount: 31,
      finalProductDecision: 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW',
      failures: []
    });
  });

  it.each([
    ['raw call', async (source: StudyExecution, copy: ArchiveCopy) => {
      const observation = source.result.stages[0]!.calls[0]!;
      const file = artifactPath(copy, observation.rawCallArtifactSha256);
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      (value.call as Record<string, unknown>).rawText = '{}';
      await fs.writeFile(file, `${stableJson(value)}\n`, 'utf8');
    }, ['ARTIFACT_HASHES', 'CALL_RAW_RELOAD', 'CALL_REPARSE']],
    ['prompt', async (source: StudyExecution, copy: ArchiveCopy) => {
      const observation = source.result.stages[0]!.calls[0]!;
      const file = artifactPath(copy, observation.promptArtifactSha256);
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      value.prompt = `${String(value.prompt)}\nTAMPERED`;
      await fs.writeFile(file, `${stableJson(value)}\n`, 'utf8');
    }, ['ARTIFACT_HASHES', 'CALL_PROMPT_BINDING']],
    ['accounting', async (source: StudyExecution, copy: ArchiveCopy) => {
      const result = structuredClone(source.result);
      result.accounting.semanticCalls = 75;
      copy.result = result;
      await writeResultReport(copy, result);
    }, ['SEMANTIC_CALL_ACCOUNTING']],
    ['runtime', async (source: StudyExecution, copy: ArchiveCopy) => {
      const stage = source.result.stages[0]!;
      const runtime = stage.close.runtimeFiles[0]!;
      await fs.appendFile(
        path.join(copy.ledger.runDirectory, stage.runtimeRootRelative, runtime.path),
        '\n',
        'utf8'
      );
    }, ['RUNTIME_HASHES']],
    ['nested reasoning', async (source: StudyExecution, copy: ArchiveCopy) => {
      const stage = source.result.stages[0]!;
      const runtime = stage.close.runtimeFiles[0]!;
      await fs.writeFile(
        path.join(copy.ledger.runDirectory, stage.runtimeRootRelative, runtime.path),
        `${JSON.stringify({ envelope: JSON.stringify({ type: 'reasoning', summary: ['secret'], content: [] }) })}\n`,
        'utf8'
      );
    }, ['RUNTIME_HASHES', 'PRIVATE_REASONING_REDACTION']],
    ['branch ancestry', async (source: StudyExecution, copy: ArchiveCopy) => {
      const result = structuredClone(source.result);
      const evaluation = result.stages.find(({ stage }) => stage === 'EVALUATION')!;
      const w1 = evaluation.calls.find(({ assignment }) => assignment.turnId === 'W1')!;
      const siblingFork = evaluation.forks.find(({ instruction }) =>
        instruction?.blockId === w1.assignment.blockId && instruction.branch === 'SELF_REVIEW_AUTHOR'
      )!;
      w1.continuation = structuredClone(siblingFork.result.session!);
      copy.result = result;
      await writeResultReport(copy, result);
    }, ['FORK_BRANCH_ANCESTRY']],
    ['model settings', async (source: StudyExecution, copy: ArchiveCopy) => {
      const result = structuredClone(source.result);
      result.stages[0]!.calls[0]!.call.observedReasoningEffort = 'medium';
      copy.result = result;
      await writeResultReport(copy, result);
    }, ['CALL_SETTINGS']],
    ['scoring', async (source: StudyExecution, copy: ArchiveCopy) => {
      const result = structuredClone(source.result);
      result.calibration.scores[0]!.score.compositeCorrect = false;
      copy.result = result;
      await writeResultReport(copy, result);
    }, ['SCORING_REPRODUCTION']]
  ] as const)('detects tampered %s evidence', async (_label, tamper, expectedChecks) => {
    const source = await completedBaseline();
    const copy = await copyArchive(source);
    await tamper(source, copy);
    const audit = await auditCopiedArchive(source, copy);

    expect(audit.status).toBe('FAILED');
    for (const check of expectedChecks) {
      expect(audit.failures.some((failure) => failure.startsWith(`${check}:`))).toBe(true);
    }
    expect(audit.finalProductDecision)
      .toBe('ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW');
  });

  it('detects deleted fork-accounting evidence instead of trusting the result summary', async () => {
    const source = await completedBaseline();
    const copy = await copyArchive(source);
    const fork = source.result.stages[0]!.forks[0]!;
    await fs.rm(artifactPath(copy, fork.artifactSha256));
    const audit = await auditCopiedArchive(source, copy);

    expect(audit.status).toBe('FAILED');
    expect(audit.failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^(FORK_ARTIFACT_CLOSURE|FORK_ACCOUNTING):/u)
    ]));
  });
});

interface StageBehavior {
  invalidCallKey?: string;
  throwCallKey?: string;
  failedCallKey?: string;
  totalTokens?: number;
  safetyOvershootTokens?: number;
  closeFailure?: boolean;
  reuseForkChild?: boolean;
}

interface TraceEntry {
  kind: 'call' | 'fork' | 'close';
  stage: HardPeer80ProviderStage;
  key: string;
  sourceThread?: string;
  continuationThread?: string | null;
  resultThread?: string;
  resultTree?: string;
}

interface StudyExecution {
  root: string;
  ledger: LabArtifactLedger;
  result: HardPeer80TerminalResult;
  plan: HardPeer80Plan;
  locks: LabComponentLock;
  trace: TraceEntry[];
  drivers: Map<HardPeer80ProviderStage, RecordingDriver>;
  scorer: HardPeer80Scorer;
  calibrationParticipants: HardPeer80ParticipantCorpus;
  evaluationParticipants: HardPeer80ParticipantCorpus;
  calibrationOracle: HardPeer80OracleCorpus;
  evaluationOracle: HardPeer80OracleCorpus;
}

async function executeStudy(options: {
  calibrationCorrect: number;
  stageBehaviors?: Partial<Record<HardPeer80ProviderStage, StageBehavior>>;
  now?: () => number;
}): Promise<StudyExecution> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-hard-peer-80-'));
  temporaryRoots.push(root);
  const calibrationParticipants = await loadHardPeer80ParticipantCorpus(
    FIXTURE_ROOT, 'CALIBRATION'
  );
  const evaluationParticipants = await loadHardPeer80ParticipantCorpus(
    FIXTURE_ROOT, 'EVALUATION'
  );
  const calibrationOracle = await loadHardPeer80OracleCorpus(
    FIXTURE_ROOT, 'CALIBRATION', calibrationParticipants
  );
  const evaluationOracle = await loadHardPeer80OracleCorpus(
    FIXTURE_ROOT, 'EVALUATION', evaluationParticipants
  );
  const plan = buildHardPeer80Plan({
    calibrationCaseIds: calibrationParticipants.records.map(({ caseId }) => caseId),
    evaluationCaseIds: evaluationParticipants.records.map(({ caseId }) => caseId),
    createdAt: '2026-08-03T00:00:00.000Z'
  });
  const locks = testLocks();
  const ledger = new LabArtifactLedger(path.join(root, 'state'), 'hard-peer-80-test');
  await ledger.initialize(buildHardPeer80Manifest({
    runId: ledger.runId,
    plan,
    locks,
    driverId: 'recording-provider-free-v1',
    participantCaseIds: [
      ...calibrationParticipants.records.map(({ caseId }) => caseId),
      ...evaluationParticipants.records.map(({ caseId }) => caseId)
    ],
    createdAt: '2026-08-03T00:00:00.000Z'
  }));
  const runtimeParent = path.join(ledger.runDirectory, 'provider-runtime');
  await Promise.all((['PROBE', 'CALIBRATION', 'EVALUATION'] as const).map((stage) =>
    fs.mkdir(path.join(runtimeParent, stage.toLowerCase()), { recursive: true })
  ));
  const trace: TraceEntry[] = [];
  const drivers = new Map<HardPeer80ProviderStage, RecordingDriver>();
  const scorer = testScorer(calibrationOracle, options.calibrationCorrect, plan);
  const result = await runHardPeer80TerminalStudy({
    runId: ledger.runId,
    fixtureRoot: FIXTURE_ROOT,
    plan,
    locks,
    eligibility: { providerFreeTest: true },
    calibrationParticipants,
    evaluationParticipants,
    loadOracle: async (partition) =>
      structuredClone(partition === 'CALIBRATION' ? calibrationOracle : evaluationOracle),
    ledger,
    createDriver: (stage) => {
      const runtimeRoot = path.join(runtimeParent, stage.toLowerCase());
      const driver = new RecordingDriver(
        stage, runtimeRoot, trace, options.stageBehaviors?.[stage]
      );
      drivers.set(stage, driver);
      return { driver, runtimeRoot };
    },
    scorer,
    expectedModelProvider: 'openai',
    ...(options.now ? { now: options.now } : {})
  });
  return {
    root, ledger, result, plan, locks, trace, drivers, scorer,
    calibrationParticipants, evaluationParticipants, calibrationOracle, evaluationOracle
  };
}

class RecordingDriver implements LabForkableTextDriver {
  readonly id = 'recording-provider-free-v1';
  readonly capabilities: LabDriverCapabilities = {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  };
  private nextThread = 1;
  private nextTurn = 1;
  private readonly turns = new Map<string, string[]>();
  private reusedForkSession?: LabDriverSession;

  constructor(
    private readonly stage: HardPeer80ProviderStage,
    private readonly runtimeRoot: string,
    private readonly trace: TraceEntry[],
    private readonly behavior: StageBehavior = {}
  ) {}

  preflight(input?: LabBoundaryProbeInput): Promise<LabDriverPreflight> {
    return Promise.resolve({
      driverId: this.id,
      ready: true,
      accountPresent: true,
      requiresAuthentication: false,
      models: [{
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'Provider-free exact-model fixture',
        isDefault: true,
        supportedReasoningEfforts: ['high']
      }],
      capabilities: this.capabilities,
      boundary: {
        status: 'ATTESTED',
        requestedModel: input?.model,
        observedModel: input?.model,
        observedModelProvider: 'openai',
        requestedReasoningEffort: input?.reasoningEffort ?? null,
        observedReasoningEffort: input?.reasoningEffort ?? null,
        requestedServiceTier: input?.serviceTier ?? null,
        observedServiceTier: input?.serviceTier ?? null,
        instructionSources: [],
        mcpStartupEvents: [],
        mismatchFields: []
      },
      limitationNotes: ['Provider-free deterministic test driver.']
    });
  }

  async call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const session = input.continuation ?? this.startSession();
    this.trace.push({
      kind: 'call', stage: this.stage, key: input.callKey,
      continuationThread: input.continuation?.providerThreadId ?? null,
      resultThread: session.providerThreadId,
      resultTree: session.providerSessionTreeId
    });
    if (input.callKey === this.behavior.throwCallKey) {
      throw new Error('synthetic thrown provider failure');
    }
    const inherited = this.turns.get(session.providerThreadId);
    if (!inherited) throw new Error('unknown test continuation');
    const providerTurnId = `${this.stage.toLowerCase()}:turn:${this.nextTurn++}`;
    inherited.push(providerTurnId);
    const now = new Date().toISOString();
    const rawText = input.callKey === this.behavior.invalidCallKey
      ? 'not-json'
      : JSON.stringify(publicOutputForPrompt(input.prompt));
    const totalTokens = this.behavior.totalTokens ?? 1_000;
    const outputTokens = Math.min(100, totalTokens);
    const usage: LabTokenUsage = {
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 0
    };
    const safetyOvershootTokens = this.behavior.safetyOvershootTokens ?? 0;
    return {
      callKey: input.callKey,
      session,
      providerTurnId,
      rawText,
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      firstOutputAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      observedModelProvider: 'openai',
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: null,
      usage: { total: usage, last: usage },
      tokenControl: {
        targetOutputTokens: input.maximumOutputTokens,
        safetyCeilingOutputTokens: input.outputTokenSafetyCeiling!,
        providerEnforcedLimit: false,
        usageStatus: 'PROVIDER_REPORTED',
        observedOutputTokens: outputTokens,
        targetOvershootTokens: 0,
        safetyOvershootTokens
      },
      providerStatus: input.callKey === this.behavior.failedCallKey ? 'failed' : 'completed',
      ...(input.callKey === this.behavior.failedCallKey
        ? { failure: {
            kind: 'PROVIDER_ERROR' as const,
            message: 'synthetic returned provider failure'
          } }
        : {}),
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: input.continuation ? 'NOT_REQUIRED' : 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'YES'
      },
      violations: [],
      lifecycle: [{ event: 'completed', at: now }]
    };
  }

  fork(input: LabDriverForkInput): Promise<LabDriverForkResult> {
    const inherited = this.turns.get(input.sourceSession.providerThreadId);
    if (!inherited) throw new Error('unknown test fork source');
    const session = this.behavior.reuseForkChild && this.reusedForkSession
      ? structuredClone(this.reusedForkSession)
      : this.startSession(input.sourceSession.providerSessionTreeId);
    this.reusedForkSession ??= structuredClone(session);
    this.turns.set(session.providerThreadId, [...inherited]);
    const now = new Date().toISOString();
    this.trace.push({
      kind: 'fork', stage: this.stage, key: input.forkKey,
      sourceThread: input.sourceSession.providerThreadId,
      resultThread: session.providerThreadId,
      resultTree: session.providerSessionTreeId
    });
    return Promise.resolve({
      forkKey: input.forkKey,
      sourceSession: structuredClone(input.sourceSession),
      session,
      inheritedProviderTurnIds: [...inherited],
      submittedAt: now,
      acknowledgedAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      observedModelProvider: 'openai',
      requestedReasoningEffort: input.reasoningEffort,
      observedReasoningEffort: input.reasoningEffort,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      providerAccounting: {
        forkMutationSubmitted: 'YES',
        forkMutationAcknowledged: 'YES',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      },
      violations: [],
      lifecycle: [{ event: 'forked', at: now }]
    });
  }

  async close(): Promise<void> {
    this.trace.push({ kind: 'close', stage: this.stage, key: `${this.stage}:close` });
    await fs.writeFile(
      path.join(this.runtimeRoot, 'runtime.json'),
      `${stableJson({ stage: this.stage, calls: this.nextTurn - 1 })}\n`,
      'utf8'
    );
    if (this.behavior.closeFailure) throw new Error('synthetic close failure');
  }

  private startSession(tree?: string): LabDriverSession {
    const ordinal = this.nextThread++;
    const thread = `${this.stage.toLowerCase()}:thread:${ordinal}`;
    const session: LabDriverSession = {
      driverId: this.id,
      providerThreadId: thread,
      providerSessionTreeId: tree ?? `${this.stage.toLowerCase()}:tree:${ordinal}`
    };
    this.turns.set(thread, []);
    return session;
  }
}

function publicOutputForPrompt(prompt: string): HardPeer80PublicOutput {
  const stage = /OUTPUT_STAGE: ([A-Z0-9_]+)/u.exec(prompt)?.[1] as
    HardPeer80PublicOutput['stage'] | undefined;
  const caseText = /\nCASE:\n([^\n]+)\n\nPUBLIC ARTIFACTS:/u.exec(prompt)?.[1];
  if (!stage || !caseText) throw new Error('test prompt lacks stage or case');
  const participantCase = JSON.parse(caseText) as LabParticipantCase;
  return {
    schemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    stage,
    answer: {
      status: 'ANSWER',
      summary: 'A concise provider-free test answer.',
      selectedOptionIds: [participantCase.options[0]!.id],
      confidence: 0.5
    },
    certificate: {
      kind: 'DIRECT',
      statement: 'The public prompt was checked directly.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The prompt is the source.' }],
      payload: stage === 'PROBE'
        ? null
        : {
            kind: 'BOOLEAN_TRUTH_TABLE',
            variableOrder: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
            satisfyingAssignments: ['0000000000'],
            queryTrueAssignments: [],
            queryFalseAssignments: ['0000000000'],
            classification: 'OPEN'
          }
    },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `claim-${index + 1}`,
      propositionId: proposition.id,
      stance: 'ACCEPT' as const,
      statement: 'The proposition is accepted for this structural fixture.',
      evidence: [{
        evidenceId: 'PROMPT', relation: 'SUPPORTS' as const, note: 'The prompt is the source.'
      }],
      assumptionIds: [],
      confidence: 0.5
    })),
    assumptions: [],
    requests: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material review issue is reported.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    abstention: null
  };
}

function testScorer(
  calibrationOracle: HardPeer80OracleCorpus,
  calibrationCorrect: number,
  plan: HardPeer80Plan
): HardPeer80Scorer {
  const correctIds = new Set(
    calibrationOracle.records.slice(0, calibrationCorrect).map(({ caseId }) => caseId)
  );
  return {
    scoreAnswer: (oracle) => answerScore(correctIds.has(oracle.caseId)),
    scoreBlocks: () => ({
      blocks: plan.schedule.evaluationBlockIds.map((blockId) => {
        const assignment = plan.assignments.find((candidate) =>
          candidate.blockId === blockId && candidate.turnId === 'A0'
        )!;
        return scoredBlock(
          blockId,
          assignment.caseId!,
          assignment.repetition as 1 | 2
        );
      }),
      interpretation: {
        status: 'SINGLE_AGENT_DEFAULT',
        informative: true,
        productPilotAuthorized: false,
        failedGates: ['PROVIDER_FREE_TEST_SCORER'],
        metrics: { providerFree: true }
      }
    })
  };
}

function answerScore(compositeCorrect: boolean): HardPeer80AnswerScore {
  return {
    outputValid: true,
    statusCorrect: compositeCorrect,
    optionsCorrect: compositeCorrect,
    claimsCorrect: compositeCorrect,
    evidenceValid: compositeCorrect,
    certificateEligible: compositeCorrect,
    requestCorrect: compositeCorrect,
    abstentionCorrect: compositeCorrect,
    compositeCorrect,
    confidence: 0.5,
    brier: 0.25
  };
}

function scoredBlock(
  blockId: string,
  caseId: string,
  repetition: 1 | 2
): HardPeer80ScoredBlock {
  const score = answerScore(false);
  return {
    blockId,
    caseId,
    repetition,
    domain: 'PROVIDER_FREE_TEST',
    initial: score,
    workbench: score,
    selfReview: score,
    peer: score,
    peerReview: { providerFree: true },
    critiqueAttributableCorrection: false,
    incrementalPeerCorrection: false,
    rightToWrongPeerContamination: false,
    inventedMaterialCriticism: 0,
    harmfulInvalidCritiqueAdoption: false,
    unsupportedDefiniteClosure: false,
    falseDisagreementResolution: false,
    requiredUnresolvedOrRequestPreserved: true,
    conditionUsage: { WORKBENCH: zeroUsage(), SELF_REVIEW: zeroUsage(), PEER: zeroUsage() },
    conditionLatencyMs: { WORKBENCH: 0, SELF_REVIEW: 0, PEER: 0 }
  };
}

function zeroUsage(): LabTokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function testLocks(): LabComponentLock {
  return {
    corpusVersion: 'hard-peer-80-corpus@v1',
    participantCorpusSha256: 'participant-test-lock',
    oracleCorpusSha256: 'oracle-test-lock',
    labSourceSha256: 'source-test-lock',
    preregistrationVersion: 'hard-peer-80-preregistration@v1',
    preregistrationSha256: 'preregistration-test-lock',
    promptVersion: 'hard-peer-80-public-prompts@v1',
    outputSchemaVersion: HARD_PEER_80_OUTPUT_SCHEMA_VERSION,
    scoringVersion: 'hard-peer-80-structured-scoring@v1',
    protocolVersion: 'hard-peer-80-terminal-experiment@v1'
  };
}

async function readEvents(ledger: LabArtifactLedger): Promise<Array<Record<string, unknown>>> {
  const eventRoot = path.join(ledger.runDirectory, 'events');
  const names = (await fs.readdir(eventRoot)).sort();
  return Promise.all(names.map(async (name) =>
    JSON.parse(await fs.readFile(path.join(eventRoot, name), 'utf8')) as Record<string, unknown>
  ));
}

interface ArchiveCopy {
  ledger: LabArtifactLedger;
  result: HardPeer80TerminalResult;
}

async function copyArchive(source: StudyExecution): Promise<ArchiveCopy> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-hard-peer-80-audit-'));
  temporaryRoots.push(root);
  const ledger = new LabArtifactLedger(root, source.ledger.runId);
  await fs.mkdir(path.join(root, 'runs'), { recursive: true });
  await fs.cp(source.ledger.runDirectory, ledger.runDirectory, { recursive: true });
  return { ledger, result: structuredClone(source.result) };
}

async function auditCopiedArchive(source: StudyExecution, copy: ArchiveCopy) {
  return auditHardPeer80Archive({
    ledger: copy.ledger,
    result: copy.result,
    scorer: source.scorer,
    calibrationParticipants: source.calibrationParticipants,
    evaluationParticipants: source.evaluationParticipants,
    calibrationOracle: source.calibrationOracle,
    evaluationOracle: source.evaluationOracle
  });
}

function artifactPath(copy: ArchiveCopy, sha256: string): string {
  return path.join(copy.ledger.runDirectory, 'artifacts', `${sha256}.json`);
}

async function writeResultReport(copy: ArchiveCopy, result: HardPeer80TerminalResult): Promise<void> {
  await fs.writeFile(
    path.join(copy.ledger.runDirectory, 'reports', 'hard-peer-80-terminal-result.json'),
    `${stableJson(result)}\n`,
    'utf8'
  );
}
