import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseAndValidateHardPeer80Output,
  type HardPeer80PublicOutput
} from './hardPeer80Contracts';
import type {
  HardPeer80CallObservation,
  HardPeer80Scorer,
  HardPeer80TerminalResult
} from './hardPeer80Experiment';
import type {
  HardPeer80OracleCorpus,
  HardPeer80ParticipantCorpus
} from './hardPeer80Corpus';
import {
  sha256File,
  sha256Text,
  stableJson,
  type LabArtifactLedger
} from './ledger';
import type { LabTokenUsage } from './textDriver';

export const HARD_PEER_80_ARCHIVE_AUDIT_VERSION =
  'hard-peer-80-independent-archive-audit@v1' as const;

export interface HardPeer80ArchiveAudit {
  schemaVersion: 'task-monki/discourse-lab-hard-peer-80-archive-audit@v1';
  auditVersion: typeof HARD_PEER_80_ARCHIVE_AUDIT_VERSION;
  runId: string;
  status: 'PASSED' | 'FAILED';
  checkedAt: string;
  checks: Array<{ id: string; status: 'PASSED' | 'FAILED'; detail: string }>;
  manifestSha256: string;
  resultReportSha256: string;
  artifactCount: number;
  eventCount: number;
  semanticCallCount: number;
  forkMutationCount: number;
  runtimeFileCount: number;
  failures: string[];
  finalProductDecision:
    | 'SMALL_BOUNDED_PEER_PILOT'
    | 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW';
}

/**
 * Reopens the written archive from disk and recomputes all structural checks.
 * It never calls a provider and does not trust in-memory parser or hash results.
 */
export async function auditHardPeer80Archive(input: {
  ledger: LabArtifactLedger;
  result: HardPeer80TerminalResult;
  scorer: HardPeer80Scorer;
  calibrationParticipants: HardPeer80ParticipantCorpus;
  evaluationParticipants: HardPeer80ParticipantCorpus;
  calibrationOracle: HardPeer80OracleCorpus;
  evaluationOracle: HardPeer80OracleCorpus;
}): Promise<HardPeer80ArchiveAudit> {
  const failures: string[] = [];
  const checks: HardPeer80ArchiveAudit['checks'] = [];
  const pass = (id: string, detail: string) => checks.push({ id, status: 'PASSED', detail });
  const fail = (id: string, detail: string) => {
    checks.push({ id, status: 'FAILED', detail });
    failures.push(`${id}:${detail}`);
  };
  const runDirectory = input.ledger.runDirectory;
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const resultPath = path.join(runDirectory, 'reports', 'hard-peer-80-terminal-result.json');
  const manifest = await readRealJson<Record<string, unknown>>(manifestPath);
  const diskResult = await readRealJson<HardPeer80TerminalResult>(resultPath);
  if (stableJson(diskResult) === stableJson(input.result)) {
    pass('RESULT_RELOAD', 'The written terminal result exactly matches the returned result.');
  } else {
    fail('RESULT_RELOAD', 'The written and returned terminal results differ.');
  }
  if (
    manifest.runId === diskResult.runId &&
    stableJson(manifest.locks) === stableJson(diskResult.componentLocks)
  ) {
    pass('MANIFEST_BINDING', 'Manifest run id and component locks match the result.');
  } else {
    fail('MANIFEST_BINDING', 'Manifest identity or component locks differ.');
  }

  const artifactsDirectory = path.join(runDirectory, 'artifacts');
  const artifactNames = (await fs.readdir(artifactsDirectory)).sort();
  const artifactHashes = new Set<string>();
  for (const name of artifactNames) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
      fail('ARTIFACT_FILENAMES', `Unexpected artifact filename ${name}.`);
      continue;
    }
    const expected = name.slice(0, 64);
    const observed = await sha256File(path.join(artifactsDirectory, name));
    if (observed !== expected) fail('ARTIFACT_HASHES', `Artifact ${name} hash mismatch.`);
    artifactHashes.add(expected);
  }
  if (!failures.some((item) => item.startsWith('ARTIFACT_'))) {
    pass('ARTIFACT_HASHES', `${artifactNames.length} content-addressed artifacts verified.`);
  }

  const eventDirectory = path.join(runDirectory, 'events');
  const eventNames = (await fs.readdir(eventDirectory)).sort();
  const events: Array<Record<string, unknown>> = [];
  for (const [index, name] of eventNames.entries()) {
    const event = await readRealJson<Record<string, unknown>>(path.join(eventDirectory, name));
    events.push(event);
    const sequence = index + 1;
    if (event.sequence !== sequence || !name.startsWith(String(sequence).padStart(6, '0'))) {
      fail('EVENT_SEQUENCE', `Event ${name} is not contiguous at ${sequence}.`);
    }
    if (
      typeof event.artifactSha256 === 'string' &&
      !artifactHashes.has(event.artifactSha256)
    ) {
      fail('EVENT_ARTIFACT_LINKS', `Event ${name} references a missing artifact.`);
    }
  }
  if (!failures.some((item) => item.startsWith('EVENT_'))) {
    pass('EVENT_SEQUENCE', `${eventNames.length} contiguous event records verified.`);
  }

  // All remaining checks use the independently reloaded report. The returned
  // in-memory object is only a cross-check and is never the audit source of truth.
  const calls = diskResult.stages.flatMap(({ calls }) => calls);
  const turnIds = new Set<string>();
  for (const observation of calls) {
    await verifyCallObservation(observation, artifactsDirectory, artifactHashes, fail);
    const turnId = observation.call.providerTurnId;
    if (turnId && turnIds.has(turnId)) {
      fail('PROVIDER_TURN_UNIQUENESS', `Duplicate turn for ${observation.assignment.callId}.`);
    } else if (turnId) {
      turnIds.add(turnId);
    }
    if (
      observation.call.providerAccounting.providerTurnStarted === 'YES' &&
      !turnId
    ) {
      fail('PROVIDER_TURN_UNIQUENESS', `Started call ${observation.assignment.callId} has no turn id.`);
    }
  }
  if (!failures.some((item) =>
    item.startsWith('CALL_') || item.startsWith('PROVIDER_TURN_')
  )) {
    pass('CALL_REPARSE', `${calls.length} raw calls and public outputs revalidated.`);
  }
  verifyCallAccounting(
    calls,
    events.filter(({ eventType }) => eventType === 'HARD_PEER_80_CALL_SUBMITTED'),
    diskResult,
    pass,
    fail
  );

  const forks = diskResult.stages.flatMap(({ forks }) => forks);
  for (const observation of forks) {
    if (!artifactHashes.has(observation.artifactSha256)) {
      fail('FORK_ARTIFACT_CLOSURE', `Fork ${observation.result.forkKey} has a missing artifact.`);
      continue;
    }
    const archived = await readRealJson<Record<string, unknown>>(
      path.join(artifactsDirectory, `${observation.artifactSha256}.json`)
    );
    const expected = observation.instruction
      ? {
          kind: 'HARD_PEER_80_EVALUATION_FORK',
          instruction: observation.instruction,
          result: observation.result
        }
      : { kind: 'HARD_PEER_80_PROBE_FORK', result: observation.result };
    if (stableJson(archived) !== stableJson(expected)) {
      fail('FORK_ARTIFACT_RELOAD', `Fork ${observation.result.forkKey} differs from its artifact.`);
    }
  }
  const submittedForks = forks.filter(({ result }) =>
    result.providerAccounting.forkMutationSubmitted === 'YES'
  ).length;
  if (
    submittedForks === diskResult.accounting.forkMutations &&
    forks.every(({ result }) =>
      result.providerAccounting.providerTurnStarted === 'NO' &&
      result.providerAccounting.billableModelCall === 'NO'
    )
  ) {
    pass('FORK_ACCOUNTING', `${forks.length} non-model fork mutations are accounted.`);
  } else {
    fail('FORK_ACCOUNTING', 'Fork mutation count or model-call status is inconsistent.');
  }

  verifyForkBranchAncestryAndSettings(diskResult, pass, fail);
  verifyExecutionTopology(diskResult, calls.length, forks.length, pass, fail);
  verifyScoring({ ...input, result: diskResult }, pass, fail);

  let runtimeFileCount = 0;
  for (const stage of diskResult.stages) {
    const runtimeRoot = safeChild(runDirectory, stage.runtimeRootRelative);
    if (stage.close.runtimeFiles.length === 0) {
      fail('RUNTIME_HASHES', `${stage.stage} has no archived provider-runtime file.`);
    }
    for (const record of stage.close.runtimeFiles) {
      runtimeFileCount += 1;
      const filePath = safeChild(runtimeRoot, record.path);
      const observed = await sha256File(filePath).catch(() => 'MISSING');
      if (observed !== record.sha256) {
        fail('RUNTIME_HASHES', `${stage.stage}/${record.path} changed or is missing.`);
      }
      await assertNoPersistedReasoning(filePath).catch((error) => {
        fail('PRIVATE_REASONING_REDACTION', `${stage.stage}/${record.path}: ${message(error)}`);
      });
    }
  }
  if (!failures.some((item) =>
    item.startsWith('RUNTIME_') || item.startsWith('PRIVATE_REASONING_')
  )) {
    pass('RUNTIME_HASHES', `${runtimeFileCount} provider-runtime files and redaction boundaries verified.`);
  }

  const status = failures.length === 0 ? 'PASSED' : 'FAILED';
  const finalProductDecision =
    status === 'PASSED' &&
    diskResult.status === 'COMPLETED' &&
    diskResult.candidateProductDecision === 'SMALL_BOUNDED_PEER_PILOT'
      ? 'SMALL_BOUNDED_PEER_PILOT'
      : 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW';
  const audit: HardPeer80ArchiveAudit = {
    schemaVersion: 'task-monki/discourse-lab-hard-peer-80-archive-audit@v1',
    auditVersion: HARD_PEER_80_ARCHIVE_AUDIT_VERSION,
    runId: diskResult.runId,
    status,
    checkedAt: new Date().toISOString(),
    checks,
    manifestSha256: await sha256File(manifestPath),
    resultReportSha256: await sha256File(resultPath),
    artifactCount: artifactNames.length,
    eventCount: eventNames.length,
    semanticCallCount: diskResult.accounting.semanticCalls,
    forkMutationCount: forks.length,
    runtimeFileCount,
    failures,
    finalProductDecision
  };
  await input.ledger.writeReport('hard-peer-80-archive-audit', audit);
  return audit;
}

function verifyForkBranchAncestryAndSettings(
  result: HardPeer80TerminalResult,
  pass: (id: string, detail: string) => void,
  fail: (id: string, detail: string) => void
): void {
  const calls = result.stages.flatMap(({ calls }) => calls);
  const forks = result.stages.flatMap(({ forks }) => forks);
  const callById = new Map<string, HardPeer80CallObservation>();
  let settingsValid = true;
  let ancestryValid = true;
  const settingsFailure = (detail: string) => {
    settingsValid = false;
    fail('CALL_SETTINGS', detail);
  };
  const ancestryFailure = (detail: string) => {
    ancestryValid = false;
    fail('FORK_BRANCH_ANCESTRY', detail);
  };

  const freshThreads = new Set<string>();
  const freshTrees = new Set<string>();
  for (const observation of calls) {
    const { assignment, call, continuation } = observation;
    if (callById.has(assignment.callId)) {
      ancestryFailure(`Duplicate archived call id ${assignment.callId}.`);
    }
    callById.set(assignment.callId, observation);
    const planned = result.plan.assignments.find(({ callId }) => callId === assignment.callId);
    if (!planned || stableJson(planned) !== stableJson(assignment)) {
      ancestryFailure(`${assignment.callId} differs from its frozen assignment.`);
    }
    if (
      call.requestedModel !== result.plan.model.id ||
      call.observedModel !== result.plan.model.id ||
      call.requestedReasoningEffort !== result.plan.model.reasoningEffort ||
      call.observedReasoningEffort !== result.plan.model.reasoningEffort ||
      call.requestedServiceTier !== result.plan.model.serviceTier ||
      call.observedServiceTier !== result.plan.model.serviceTier ||
      call.seed !== null
    ) {
      settingsFailure(`${assignment.callId} did not use the exact frozen model/settings.`);
    }
    if (!call.session?.providerThreadId || !call.session.providerSessionTreeId) {
      ancestryFailure(`${assignment.callId} has no complete provider session identity.`);
      continue;
    }
    if (continuation) {
      if (
        stableJson(continuation) !== stableJson(call.session) ||
        call.providerAccounting.threadStartStatus !== 'NOT_REQUIRED'
      ) {
        ancestryFailure(`${assignment.callId} did not continue its recorded parent session.`);
      }
    } else {
      if (call.providerAccounting.threadStartStatus !== 'ATTESTED') {
        ancestryFailure(`${assignment.callId} is not attested as a fresh thread.`);
      }
      if (freshThreads.has(call.session.providerThreadId)) {
        ancestryFailure(`${assignment.callId} reused a purportedly fresh thread.`);
      }
      if (freshTrees.has(call.session.providerSessionTreeId)) {
        ancestryFailure(`${assignment.callId} reused a purportedly fresh session tree.`);
      }
      freshThreads.add(call.session.providerThreadId);
      freshTrees.add(call.session.providerSessionTreeId);
    }
  }
  if (result.status === 'COMPLETED') {
    const observedIds = [...callById.keys()].sort();
    const plannedIds = result.plan.assignments.map(({ callId }) => callId).sort();
    if (stableJson(observedIds) !== stableJson(plannedIds)) {
      ancestryFailure('The completed run does not contain every frozen call assignment exactly once.');
    }
  }

  const ownedThreads = new Set(freshThreads);
  const observedEvaluationForkById = new Map<string, typeof forks[number]>();
  for (const observation of forks) {
    const { instruction, result: fork } = observation;
    const source = fork.sourceSession;
    const child = fork.session;
    if (
      fork.requestedModel !== result.plan.model.id ||
      fork.observedModel !== result.plan.model.id ||
      fork.requestedReasoningEffort !== result.plan.model.reasoningEffort ||
      fork.observedReasoningEffort !== result.plan.model.reasoningEffort ||
      fork.requestedServiceTier !== result.plan.model.serviceTier ||
      fork.observedServiceTier !== result.plan.model.serviceTier
    ) {
      settingsFailure(`${fork.forkKey} did not preserve the exact frozen model/settings.`);
    }
    if (
      !child?.providerThreadId ||
      !child.providerSessionTreeId ||
      !source.providerThreadId ||
      !source.providerSessionTreeId ||
      child.providerThreadId === source.providerThreadId ||
      child.providerSessionTreeId !== source.providerSessionTreeId ||
      child.driverId !== source.driverId ||
      ownedThreads.has(child.providerThreadId)
    ) {
      ancestryFailure(`${fork.forkKey} has invalid or reused child-session ancestry.`);
    } else {
      ownedThreads.add(child.providerThreadId);
    }
    if (instruction) {
      const planned = result.plan.forks.find(({ forkId }) => fork.forkKey === forkId);
      if (
        !planned ||
        stableJson(planned) !== stableJson(instruction) ||
        observedEvaluationForkById.has(fork.forkKey)
      ) {
        ancestryFailure(`${fork.forkKey} differs from or duplicates its frozen fork instruction.`);
      }
      observedEvaluationForkById.set(fork.forkKey, observation);
    }
  }

  const probeStage = result.stages.find(({ stage }) => stage === 'PROBE');
  const probeCall = probeStage?.calls[0];
  for (const observation of probeStage?.forks ?? []) {
    if (
      observation.instruction !== null ||
      observation.result.forkKey !== 'probe:fork:one' ||
      !probeCall ||
      stableJson(observation.result.sourceSession) !== stableJson(probeCall.call.session) ||
      stableJson(observation.result.inheritedProviderTurnIds) !==
        stableJson([probeCall.call.providerTurnId])
    ) {
      ancestryFailure('The probe fork does not inherit exactly the probe source turn.');
    }
  }

  const evaluationStage = result.stages.find(({ stage }) => stage === 'EVALUATION');
  if (evaluationStage) {
    for (const blockId of result.plan.schedule.evaluationBlockIds) {
      const blockCalls = evaluationStage.calls.filter(
        ({ assignment }) => assignment.blockId === blockId
      );
      const blockForks = evaluationStage.forks.filter(
        ({ instruction }) => instruction?.blockId === blockId
      );
      if (blockCalls.length === 0 && blockForks.length === 0) continue;
      const a0 = blockCalls.find(({ assignment }) => assignment.turnId === 'A0');
      if (!a0?.call.session || !a0.call.providerTurnId) {
        ancestryFailure(`${blockId} has branch evidence without a complete A0 source.`);
        continue;
      }
      const branchCalls = blockCalls.filter(({ assignment }) => assignment.turnId !== 'A0');
      if (branchCalls.length > 0 && blockForks.length !== 3) {
        ancestryFailure(`${blockId} began a branch before all three author forks existed.`);
      }
      for (const observation of blockForks) {
        const { instruction, result: fork } = observation;
        if (
          !instruction ||
          fork.forkKey !== instruction.forkId ||
          stableJson(fork.sourceSession) !== stableJson(a0.call.session) ||
          stableJson(fork.inheritedProviderTurnIds) !== stableJson([a0.call.providerTurnId])
        ) {
          ancestryFailure(`${blockId}/${fork.forkKey} does not inherit exactly A0.`);
        }
        const firstBranch = callById.get(instruction?.firstBranchCallId ?? '');
        if (
          firstBranch &&
          (
            stableJson(firstBranch.continuation) !== stableJson(fork.session) ||
            stableJson(firstBranch.call.session) !== stableJson(fork.session)
          )
        ) {
          ancestryFailure(`${blockId}/${instruction!.firstBranchCallId} is not on its declared fork child.`);
        }
      }
      if (branchCalls.length > 0) {
        const firstBranchMs = Math.min(...branchCalls.map(({ call }) => Date.parse(call.submittedAt)));
        if (
          blockForks.some(({ result: fork }) =>
            !Number.isFinite(Date.parse(fork.completedAt)) ||
            Date.parse(fork.completedAt) > firstBranchMs
          )
        ) {
          ancestryFailure(`${blockId} has a fork completed after branch execution began.`);
        }
      }
      const p1 = blockCalls.find(({ assignment }) => assignment.turnId === 'P1');
      if (
        p1 &&
        (
          p1.continuation !== null ||
          p1.assignment.threadMode !== 'FRESH' ||
          p1.call.session?.providerSessionTreeId === a0.call.session.providerSessionTreeId ||
          blockForks.some(({ result: fork }) =>
            fork.session?.providerThreadId === p1.call.session?.providerThreadId
          )
        )
      ) {
        ancestryFailure(`${blockId}/P1 is not an oracle-blind fresh peer session.`);
      }
      for (const finalTurn of ['W2', 'S2'] as const) {
        const final = blockCalls.find(({ assignment }) => assignment.turnId === finalTurn);
        if (!final) continue;
        const parent = final.assignment.parentCallId
          ? callById.get(final.assignment.parentCallId)
          : undefined;
        if (
          !parent?.call.session ||
          stableJson(final.continuation) !== stableJson(parent.call.session) ||
          stableJson(final.call.session) !== stableJson(parent.call.session)
        ) {
          ancestryFailure(`${blockId}/${finalTurn} does not continue its prior branch call.`);
        }
      }
    }
  }

  if (settingsValid) {
    pass('CALL_SETTINGS', `${calls.length} calls and ${forks.length} forks preserve Sol/high/default/null-seed settings.`);
  }
  if (ancestryValid) {
    pass('FORK_BRANCH_ANCESTRY', 'Fresh sessions, A0 forks, peer isolation, and direct branch continuations reproduce.');
  }
}

async function verifyCallObservation(
  observation: HardPeer80CallObservation,
  artifactDirectory: string,
  artifactHashes: ReadonlySet<string>,
  fail: (id: string, detail: string) => void
): Promise<void> {
  const required = [
    observation.promptArtifactSha256,
    observation.rawCallArtifactSha256,
    observation.parsedOutputArtifactSha256
  ];
  if (required.some((hash) => !artifactHashes.has(hash))) {
    fail('CALL_ARTIFACT_CLOSURE', `${observation.assignment.callId} has a missing artifact.`);
    return;
  }
  const promptArtifact = await readRealJson<{
    prompt: string;
    context: Parameters<typeof parseAndValidateHardPeer80Output>[1];
  }>(path.join(artifactDirectory, `${observation.promptArtifactSha256}.json`));
  const rawArtifact = await readRealJson<{ call: HardPeer80CallResultLike }>(
    path.join(artifactDirectory, `${observation.rawCallArtifactSha256}.json`)
  );
  const parsedArtifact = await readRealJson<{
    output: HardPeer80PublicOutput | null;
    validationErrors: HardPeer80CallObservation['validationErrors'];
  }>(
    path.join(artifactDirectory, `${observation.parsedOutputArtifactSha256}.json`)
  );
  if (
    sha256Text(promptArtifact.prompt) !== observation.promptSha256 ||
    rawArtifact.call.callKey !== observation.assignment.callId
  ) {
    fail('CALL_PROMPT_BINDING', `${observation.assignment.callId} prompt or call identity differs.`);
  }
  if (stableJson(rawArtifact.call) !== stableJson(observation.call)) {
    fail('CALL_RAW_RELOAD', `${observation.assignment.callId} raw call differs.`);
  }
  const parsed = parseAndValidateHardPeer80Output(
    rawArtifact.call.rawText,
    promptArtifact.context
  );
  const recomputed = parsed.ok ? parsed.value : null;
  const recomputedErrors = parsed.ok
    ? []
    : parsed.errors.map(({ path, code, message }) => ({ path, code, message }));
  if (
    stableJson(recomputed) !== stableJson(observation.output) ||
    stableJson(recomputed) !== stableJson(parsedArtifact.output) ||
    stableJson(recomputedErrors) !== stableJson(observation.validationErrors) ||
    stableJson(recomputedErrors) !== stableJson(parsedArtifact.validationErrors)
  ) {
    fail('CALL_REPARSE', `${observation.assignment.callId} public output does not reproduce.`);
  }
}

function verifyCallAccounting(
  calls: readonly HardPeer80CallObservation[],
  submissionEvents: readonly Record<string, unknown>[],
  result: HardPeer80TerminalResult,
  pass: (id: string, detail: string) => void,
  fail: (id: string, detail: string) => void
): void {
  const submittedCallIds = submissionEvents.map(({ callId }) =>
    typeof callId === 'string' ? callId : null
  );
  const uniqueSubmittedCallIds = new Set(submittedCallIds.filter(
    (callId): callId is string => callId !== null
  ));
  const submissionClosureValid = !(
    uniqueSubmittedCallIds.size !== submissionEvents.length ||
    calls.some(({ assignment }) => !uniqueSubmittedCallIds.has(assignment.callId))
  );
  if (!submissionClosureValid) {
    fail(
      'SEMANTIC_CALL_ACCOUNTING',
      'Submitted call events are missing, duplicated, or do not cover returned observations.'
    );
  }
  const usageKnownCalls = calls.filter(({ call }) => call.usage?.last).length;
  const usage = calls.reduce(
    (sum, { call }) => addUsage(sum, call.usage?.last),
    zeroUsage()
  );
  const providerTurnsStarted = calls.filter(({ call }) =>
    call.providerAccounting.providerTurnStarted === 'YES'
  ).length;
  const summedLatencyMs = calls.reduce((sum, { latencyMs }) => sum + (latencyMs ?? 0), 0);
  const targetOutputOvershootCalls = calls.filter(({ call }) =>
    (call.tokenControl?.targetOvershootTokens ?? 0) > 0
  ).length;
  const targetOutputOvershootTokens = calls.reduce((sum, { call }) =>
    sum + (call.tokenControl?.targetOvershootTokens ?? 0), 0
  );
  const safetyOutputOvershootCalls = calls.filter(({ call }) =>
    (call.tokenControl?.safetyOvershootTokens ?? 0) > 0
  ).length;
  const safetyOutputOvershootTokens = calls.reduce((sum, { call }) =>
    sum + (call.tokenControl?.safetyOvershootTokens ?? 0), 0
  );
  const observed = {
    // A driver may throw after dispatch and before returning a call result. The
    // write-ahead submission event remains the authoritative attempt count.
    semanticCalls: submissionEvents.length,
    providerTurnsStarted,
    usageKnownCalls,
    observedIncrementalUsage: usage,
    summedLatencyMs,
    targetOutputOvershootCalls,
    targetOutputOvershootTokens,
    safetyOutputOvershootCalls,
    safetyOutputOvershootTokens
  };
  const expected = { ...result.accounting, forkMutations: undefined };
  delete (expected as { forkMutations?: number }).forkMutations;
  if (
    stableJson(observed) === stableJson(expected) &&
    submissionClosureValid
  ) {
    pass(
      'SEMANTIC_CALL_ACCOUNTING',
      `${submissionEvents.length} submitted calls and ${calls.length} returned observations are recomputed.`
    );
  } else {
    if (submissionClosureValid) {
      fail('SEMANTIC_CALL_ACCOUNTING', 'Recomputed calls, usage, latency, or overshoot differ from the result.');
    }
  }
}

function verifyExecutionTopology(
  result: HardPeer80TerminalResult,
  callCount: number,
  forkCount: number,
  pass: (id: string, detail: string) => void,
  fail: (id: string, detail: string) => void
): void {
  const stages = result.stages.map(({ stage }) => stage);
  const completedShape =
    result.status === 'COMPLETED' &&
    stableJson(stages) === stableJson(['PROBE', 'CALIBRATION', 'EVALUATION']) &&
    result.stages.every(({ status, stopReason, close }) =>
      status === 'COMPLETED' && stopReason === null && close.status === 'CLEAN'
    ) &&
    callCount === 76 &&
    forkCount === 31 &&
    result.calibration.gate === 'PASSED' &&
    result.evaluation.scored;
  const stoppedShape =
    result.status === 'STOPPED' &&
    result.stopReason !== null &&
    result.candidateProductDecision === 'ONE_STRONG_AGENT_OPTIONAL_BOUNDED_SELF_REVIEW' &&
    callCount <= 76 &&
    forkCount <= 31;
  if (completedShape || stoppedShape) {
    pass('EXECUTION_TOPOLOGY', completedShape
      ? 'The completed archive contains exactly 76 calls and 31 non-model forks.'
      : 'The stopped archive remains within the frozen call/fork topology and defaults safely.');
  } else {
    fail('EXECUTION_TOPOLOGY', 'Stage, close, call, fork, or terminal-decision topology is inconsistent.');
  }
}

function verifyScoring(
  input: Parameters<typeof auditHardPeer80Archive>[0],
  pass: (id: string, detail: string) => void,
  fail: (id: string, detail: string) => void
): void {
  try {
    const calibrationCalls = input.result.stages
      .find(({ stage }) => stage === 'CALIBRATION')?.calls ?? [];
    const calibrationOracle = new Map(
      input.calibrationOracle.records.map((oracle) => [oracle.caseId, oracle])
    );
    const calibrationScores = calibrationCalls.map((call) => {
      const oracle = calibrationOracle.get(call.assignment.caseId!);
      if (!oracle) throw new Error(`Missing calibration oracle ${call.assignment.caseId}.`);
      return { caseId: oracle.caseId, score: input.scorer.scoreAnswer(oracle, call.output) };
    });
    if (
      input.result.calibration.scored &&
      stableJson(calibrationScores) !== stableJson(input.result.calibration.scores)
    ) {
      throw new Error('Calibration scores do not reproduce.');
    }
    if (input.result.evaluation.scored) {
      const evaluationCalls = input.result.stages
        .find(({ stage }) => stage === 'EVALUATION')?.calls ?? [];
      const rescored = input.scorer.scoreBlocks({
        plan: input.result.plan,
        records: input.evaluationParticipants.records,
        oracles: input.evaluationOracle.records,
        calls: evaluationCalls
      });
      if (
        stableJson(rescored.blocks) !== stableJson(input.result.evaluation.blocks) ||
        stableJson(rescored.interpretation) !==
          stableJson(input.result.evaluation.interpretation)
      ) {
        throw new Error('Evaluation scores or terminal interpretation do not reproduce.');
      }
    } else if (input.result.evaluation.blocks.length > 0) {
      throw new Error('An unscored evaluation retains scored blocks.');
    }
    pass('SCORING_REPRODUCTION', 'Calibration and any completed evaluation scores reproduce from archived outputs.');
  } catch (error) {
    fail('SCORING_REPRODUCTION', message(error));
  }
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

function addUsage(left: LabTokenUsage, right: LabTokenUsage | undefined): LabTokenUsage {
  if (!right) return left;
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens
  };
}

type HardPeer80CallResultLike = { rawText: string } & Record<string, unknown>;

async function readRealJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Archive input is not a real file: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function safeChild(parent: string, relative: string): string {
  const candidate = path.resolve(parent, relative);
  const rel = path.relative(path.resolve(parent), candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Archive path escapes its owner: ${relative}`);
  }
  return candidate;
}

async function assertNoPersistedReasoning(filePath: string): Promise<void> {
  if (!/\.(?:json|jsonl|ndjson)$/iu.test(filePath)) return;
  const text = await fs.readFile(filePath, 'utf8');
  const lines = filePath.endsWith('.json') ? [text] : text.split('\n').filter(Boolean);
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    visit(value, 0);
  }

  function visit(value: unknown, depth: number): void {
    if (depth > 12) {
      throw new Error('Nested provider runtime payload exceeded the redaction-audit depth.');
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'reasoning') {
      const summary = Array.isArray(record.summary) ? record.summary : [];
      const content = Array.isArray(record.content) ? record.content : [];
      const allowedMarker = record.content === '[OMITTED: private model reasoning is not a lab artifact]';
      if (summary.length > 0 || content.length > 0 || (!allowedMarker && typeof record.content === 'string')) {
        throw new Error('A provider reasoning item retained non-redacted content.');
      }
    }
    Object.values(record).forEach((child) => visit(child, depth + 1));
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
