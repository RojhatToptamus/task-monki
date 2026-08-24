import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabOracleCase,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import {
  loadLabControlledAssignmentOracles,
  loadLabOracleCorpus,
  loadLabParticipantCorpus,
  loadLabPublicIntervention,
  planControlledAssignments,
  type LabControlledAssignment,
  type LabControlledAssignmentOracle,
  type LabParticipantCorpus
} from './corpus';
import {
  LabArtifactLedger,
  sha256File,
  stableJson,
  type LabComponentLock
} from './ledger';
import { acceptedLabOutput, createLabOutputRecord } from './outputValidation';
import { getLabProtocolPlan, listLabProtocolPlans } from './protocols';
import { runLabProtocol, type LabProtocolRunResult } from './runner';
import { scoreLabTrajectory } from './scoring';
import { ScriptedLabTextDriver, type LabTextCallInput } from './textDriver';
import { validateLabInputs } from './validation';

export const LAB_HARNESS_VALIDATION_VERSION = 'h0-validation@v6' as const;

export interface LabHarnessValidationReport {
  schemaVersion: 'task-monki/discourse-lab-h0@v6';
  validationVersion: typeof LAB_HARNESS_VALIDATION_VERSION;
  hypothesisId: 'H0';
  hypothesis: string;
  mechanism: string;
  supportCriterion: string;
  rejectCriterion: string;
  decisionChanged: string;
  startedAt: string;
  completedAt: string;
  status: 'PASSED';
  /** Exact validated inputs/runtime sources for which this H0 report is valid. */
  componentLocks: LabComponentLock;
  scopeLimitations: string[];
  checks: Array<{ checkId: string; status: 'PASSED'; detail: string }>;
  trajectories: Array<{
    caseId: string;
    conditionId: string;
    status: LabProtocolRunResult['status'];
    chargedCalls: number;
    failureCount: number;
  }>;
}

const H0_CASE_IDS = ['DEV-OBJ-03', 'DEV-EVD-04', 'DEV-GAP-01', 'DEV-DEC-01'];

export async function runHarnessValidation(
  fixtureRoot: string,
  ledger?: LabArtifactLedger
): Promise<LabHarnessValidationReport> {
  const startedAt = new Date().toISOString();
  const firstSeal = await validateLabInputs(fixtureRoot);
  const secondSeal = await validateLabInputs(fixtureRoot);
  if (JSON.stringify(firstSeal) !== JSON.stringify(secondSeal)) {
    throw new Error('Repeated seal validation produced different component locks.');
  }
  await assertEvaluationOnlyImports(path.resolve(fixtureRoot, '..', '..'));
  const participants = await loadLabParticipantCorpus(fixtureRoot, 'DEVELOPMENT');
  const selected = participants.cases.filter((item) => H0_CASE_IDS.includes(item.caseId));
  if (selected.length !== H0_CASE_IDS.length) throw new Error('H0 development cases are unavailable.');
  // Allocation is projected to opaque assignment ids before execution. Scorer
  // truth itself is not opened until both participant passes have settled.
  const controlledAssignments = await planControlledAssignments(fixtureRoot, 'DEVELOPMENT');
  const trajectories: LabHarnessValidationReport['trajectories'] = [];
  const prefixes = new Map<string, { prompts: string[]; outputs: string[] }>();
  const unscored: Array<{ run: LabProtocolRunResult; participantCase: LabParticipantCase }> = [];

  // CONTROL_CASE_ONLY_B1 belongs exclusively to the separately sealed H1b
  // cohort. This function is the immutable v8 H0 replay validator.
  for (const plan of listLabProtocolPlans().filter(
    (candidate) => candidate.conditionId !== 'CONTROL_CASE_ONLY_B1'
  )) {
    const isControlled = plan.conditionId.startsWith('CONTROL_');
    const assignments = isControlled
      ? [controlledAssignments.find((item) => item.conditionId === plan.conditionId)]
      : selected.map((participantCase) => ({ participantCase }));
    for (const assignment of assignments) {
      if (!assignment) throw new Error(`H0 lacks a controlled assignment for ${plan.conditionId}.`);
      const participantCase = 'participantCase' in assignment
        ? assignment.participantCase
        : participants.cases.find((item) => item.caseId === assignment.caseId)!;
      const intervention = 'participantCase' in assignment
        ? undefined
        : await loadLabPublicIntervention(fixtureRoot, assignment);
      const recorded: { prompts: string[]; outputs: string[] } = { prompts: [], outputs: [] };
      const callRecords: Array<{ callId: string; prompt: string; output: string }> = [];
      const driver = new ScriptedLabTextDriver((call) => {
        const output = JSON.stringify(scriptedPublicOutput(participantCase, call));
        callRecords.push({ callId: call.callKey.split(':').at(-1)!, prompt: call.prompt, output });
        return output;
      });
      const run = await runLabProtocol({
        participantCase,
        plan,
        driver,
        modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
        limits: {
          maximumCalls: plan.maximumCalls,
          maximumRounds: Math.max(1, plan.maximumRounds),
          maximumInputTokensPerCall: 7_000,
          maximumObservedTotalTokens: 50_000,
          maximumCallMs: 2_000,
          maximumExperimentMs: 30_000,
          maximumConcurrency: 2
        },
        ledger,
        intervention,
        ...('participantCase' in assignment
          ? {}
          : { assignmentId: assignment.assignmentId })
      });
      await driver.close();
      if (run.status !== 'COMPLETED' || run.calls.some((call) => call.failure)) {
        throw new Error(`Scripted H0 trajectory failed: ${run.caseId}/${run.conditionId}`);
      }
      const orderedRecords = plan.calls.map((call) =>
        callRecords.find((item) => item.callId === call.id)!
      );
      recorded.prompts.push(...orderedRecords.map((item) => item.prompt));
      recorded.outputs.push(...orderedRecords.map((item) => item.output));
      unscored.push({ run, participantCase });
      prefixes.set(`${participantCase.caseId}:${plan.conditionId}`, recorded);
    }
  }

  const replay = await runDeterministicReplayPass(
    fixtureRoot,
    participants,
    selected,
    controlledAssignments
  );
  assertReplayMatches(unscored, prefixes, replay.runs, replay.prefixes);
  await assertContextualReferenceControls(fixtureRoot, participants, controlledAssignments);

  // This is the first point at which scorer truth is opened.
  const [oracles, interventionOracles] = await Promise.all([
    loadLabOracleCorpus(fixtureRoot, participants),
    loadLabControlledAssignmentOracles(fixtureRoot, controlledAssignments)
  ]);
  assertParticipantPromptsSanitized(
    [prefixes, replay.prefixes],
    participants,
    controlledAssignments,
    oracles,
    interventionOracles
  );
  const oracleByCase = new Map(oracles.map((item) => [item.caseId, item]));
  for (const { run, participantCase } of unscored) {
    const oracle = oracleByCase.get(participantCase.caseId)!;
    const score = scoreLabTrajectory({
      participantCase,
      oracleCase: oracle,
      artifacts: run.artifacts,
      initialArtifactIds: run.initialArtifactIds,
      terminalArtifactIds: run.terminalArtifactIds,
      transitionLinks: run.transitionLinks
    });
    if (score.totalChargedCalls !== run.realizedBudget.dispatchedCalls || score.failureCount !== 0) {
      throw new Error(`Scripted H0 ledger/scoring mismatch: ${run.caseId}/${run.conditionId}`);
    }
    trajectories.push({
      caseId: run.caseId,
      conditionId: run.conditionId,
      status: run.status,
      chargedCalls: score.totalChargedCalls,
      failureCount: score.failureCount
    });
  }

  assertParserRoundTrip(unscored);
  assertHandScoredTransition(unscored, oracleByCase);
  await assertFaultAndBudgetControls(selected[0]!);

  assertFrozenPrefix(prefixes, 'DEV-OBJ-03', 'MAP_ONLY_B3', 'ABC_B5', 2);
  assertAuditPrefixDefinitions();
  assertAuditSessionSemantics(
    await runSessionSemanticsCase(selected[0]!, 'SAME_C_AUDIT_B6'),
    await runSessionSemanticsCase(selected[0]!, 'RECONSTRUCTED_C_AUDIT_B6'),
    await runSessionSemanticsCase(selected[0]!, 'FRESH_D_AUDIT_B6')
  );
  const completedAt = new Date().toISOString();
  const report: LabHarnessValidationReport = {
    schemaVersion: 'task-monki/discourse-lab-h0@v6',
    validationVersion: LAB_HARNESS_VALIDATION_VERSION,
    hypothesisId: 'H0',
    hypothesis:
      'The deterministic lab plumbing can validate sealed inputs, sanitized participant prompts, exact structured response targets for every controlled signal kind, contextual references, finite scripted plans, declared prefixes and lineage, boundary outcomes, and failure accounting without importing product authority.',
    mechanism: 'Synthetic scripted outputs and harness instrumentation only; no provider or model-quality mechanism.',
    supportCriterion:
      'Two independent scripted passes, participant-prompt sanitization, empty controlled-signal response-target projections across NONE, PEER_MESSAGE, PEER_SET, and EVIDENCE_PACKET, contextual invalid-reference rejection and repair, parser round-trip, one hand-scored fixture transition, byte-identical constructed prefixes, session lineage, finite-limit/failure injections, ledger accounting, and import boundaries pass.',
    rejectCriterion:
      'Any allocation/category or scorer-only label reaches a participant payload, a hallucinated contextual reference is accepted, or any changed prefix, lineage conflation, missing call, scorer mismatch, budget violation, or product-authority import occurs fails H0.',
    decisionChanged:
      'Passing validates harness plumbing and the sealed v8 controlled-signal response-target, natural-completion target, emergency-threshold, and fail-closed retrospective-accounting contract. A fresh live boundary attestation is still required before H1 development; H2-H7 remain gated.',
    startedAt,
    completedAt,
    status: 'PASSED',
    componentLocks: structuredClone(firstSeal.locks),
    scopeLimitations: [
      'H0 uses authored scripted outputs and does not measure model behavior or semantic quality.',
      'One hand-scored fixture checks score computation, not construct validity across the corpus.',
      'H0 does not attest a live provider, provider-enforced limits, live harness text isolation, complete live usage telemetry, or streaming interruption.',
      'H0 does not make H2-H7 executable or eligible; replay-only and deferred arms remain blocked.'
    ],
    checks: [
      {
        checkId: 'SEALED_INPUTS_TWICE',
        status: 'PASSED',
        detail: `${firstSeal.verifiedFiles.length} sealed inputs and the H0-H7 preregistration structure matched twice; this is not semantic construct validation.`
      },
      {
        checkId: 'TRUTH_FIREWALL_AND_IMPORT_BOUNDARY',
        status: 'PASSED',
        detail: 'Participant loaders have no scorer path; lab sources import no Task/review/Git/GitHub/renderer/Electron authority.'
      },
      {
        checkId: 'PARTICIPANT_PROMPT_SANITIZATION',
        status: 'PASSED',
        detail: 'Both scripted passes parsed every public-case payload and rejected internal case, category, allocation, condition, and unique scorer-only labels.'
      },
      {
        checkId: 'CONTEXTUAL_REFERENCE_REJECTION_AND_REPAIR',
        status: 'PASSED',
        detail: 'NONE, PEER_MESSAGE, PEER_SET, and EVIDENCE_PACKET prompts exposed an empty structured response-target list; a shape-valid invented targetIssueId was rejected and repaired for every signal kind, and repeating it failed finitely without an accepted semantic output.'
      },
      {
        checkId: 'FINITE_PROTOCOL_MATRIX',
        status: 'PASSED',
        detail: `${trajectories.length} trajectories across the currently executable scripted plans completed twice with identical public results, bounded calls, and zero failures.`
      },
      {
        checkId: 'FROZEN_PREFIX_CONSTRUCTION',
        status: 'PASSED',
        detail: 'Scripted MAP_ONLY/ABC A/B prompts and outputs were byte-identical, and every audit plan retains the exact ABC call definitions; live frozen-prefix branch replay is not implemented.'
      },
      {
        checkId: 'AUDITOR_SESSION_IDENTITY',
        status: 'PASSED',
        detail: 'Same-C continued C; reconstructed-C and fresh-D used independent sessions.'
      },
      {
        checkId: 'DETERMINISTIC_SCORING_AND_LEDGER',
        status: 'PASSED',
        detail: 'Every dispatched scripted attempt was accounted separately from provider turns; parser replay and one sealed hand-score matched without establishing metric construct validity.'
      },
      {
        checkId: 'NON_EXECUTABLE_CONDITION_GATES',
        status: 'PASSED',
        detail: `${firstSeal.nonExecutableProtocolConditions.length} replay-only or preregistration-only conditions were explicitly declared and excluded from dispatch.`
      },
      {
        checkId: 'FAILURE_AND_HARD_LIMIT_INJECTION',
        status: 'PASSED',
        detail: 'Schema repair, invalid-after-repair, call/round rejection, driver timeout, scripted per-call output-token enforcement, and post-call aggregate-token stop produced finite outcomes. This checks injected plumbing only; it does not attest live natural completion, provider usage, or emergency streaming interruption.'
      }
    ],
    trajectories
  };
  if (ledger) await assertLedgerCompleteness(ledger);
  await ledger?.writeReport('h0-validation', report);
  return report;
}

interface ReplayPass {
  runs: Array<{ run: LabProtocolRunResult; participantCase: LabParticipantCase }>;
  prefixes: Map<string, { prompts: string[]; outputs: string[] }>;
}

async function runDeterministicReplayPass(
  fixtureRoot: string,
  participants: LabParticipantCorpus,
  selected: LabParticipantCase[],
  controlledAssignments: LabControlledAssignment[]
): Promise<ReplayPass> {
  const runs: ReplayPass['runs'] = [];
  const prefixes: ReplayPass['prefixes'] = new Map();
  for (const plan of listLabProtocolPlans().filter(
    (candidate) => candidate.conditionId !== 'CONTROL_CASE_ONLY_B1'
  )) {
    const isControlled = plan.conditionId.startsWith('CONTROL_');
    const assignments = isControlled
      ? [controlledAssignments.find((item) => item.conditionId === plan.conditionId)]
      : selected.map((participantCase) => ({ participantCase }));
    for (const assignment of assignments) {
      if (!assignment) throw new Error(`Replay lacks an assignment for ${plan.conditionId}.`);
      const participantCase = 'participantCase' in assignment
        ? assignment.participantCase
        : participants.cases.find((item) => item.caseId === assignment.caseId)!;
      const intervention = 'participantCase' in assignment
        ? undefined
        : await loadLabPublicIntervention(fixtureRoot, assignment);
      const recorded = { prompts: [] as string[], outputs: [] as string[] };
      const callRecords: Array<{ callId: string; prompt: string; output: string }> = [];
      const driver = new ScriptedLabTextDriver((call) => {
        const output = JSON.stringify(scriptedPublicOutput(participantCase, call));
        callRecords.push({ callId: call.callKey.split(':').at(-1)!, prompt: call.prompt, output });
        return output;
      });
      const run = await runLabProtocol({
        participantCase,
        plan,
        driver,
        modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
        limits: normalLimits(plan),
        intervention
      });
      await driver.close();
      if (run.status !== 'COMPLETED' || run.calls.some((call) => call.failure)) {
        throw new Error(`Second H0 pass failed: ${run.caseId}/${run.conditionId}`);
      }
      const orderedRecords = plan.calls.map((call) =>
        callRecords.find((item) => item.callId === call.id)!
      );
      recorded.prompts.push(...orderedRecords.map((item) => item.prompt));
      recorded.outputs.push(...orderedRecords.map((item) => item.output));
      runs.push({ run, participantCase });
      prefixes.set(`${participantCase.caseId}:${plan.conditionId}`, recorded);
    }
  }
  return { runs, prefixes };
}

function normalLimits(plan: ReturnType<typeof getLabProtocolPlan>) {
  return {
    maximumCalls: plan.maximumCalls,
    maximumRounds: Math.max(1, plan.maximumRounds),
    maximumInputTokensPerCall: 7_000,
    maximumObservedTotalTokens: 50_000,
    maximumCallMs: 2_000,
    maximumExperimentMs: 30_000,
    maximumConcurrency: 2
  };
}

function assertReplayMatches(
  firstRuns: Array<{ run: LabProtocolRunResult }>,
  firstPrefixes: Map<string, { prompts: string[]; outputs: string[] }>,
  secondRuns: Array<{ run: LabProtocolRunResult }>,
  secondPrefixes: Map<string, { prompts: string[]; outputs: string[] }>
): void {
  const fingerprint = (run: LabProtocolRunResult) => stableJson({
    caseId: run.caseId,
    conditionId: run.conditionId,
    status: run.status,
    stopReason: run.stopReason ?? null,
    artifacts: run.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      actorId: artifact.actorId,
      stage: artifact.stage,
      parentArtifactIds: artifact.parentArtifactIds,
      attempts: artifact.output.attempts.map((attempt) => ({
        purpose: attempt.purpose,
        rawText: attempt.rawText,
        charged: attempt.charged,
        validationErrors: attempt.validationErrors
      })),
      status: artifact.output.status
    })),
    initialArtifactIds: run.initialArtifactIds,
    terminalArtifactIds: run.terminalArtifactIds,
    transitionLinks: run.transitionLinks,
    dispatchedCalls: run.realizedBudget.dispatchedCalls,
    providerTurnsStarted: run.realizedBudget.providerTurnsStarted,
    totalTokens: run.realizedBudget.totalTokens
  });
  if (
    stableJson(firstRuns.map((item) => fingerprint(item.run))) !==
    stableJson(secondRuns.map((item) => fingerprint(item.run)))
  ) {
    throw new Error('Two clean H0 passes produced different public trajectories or accounting.');
  }
  if (stableJson([...firstPrefixes]) !== stableJson([...secondPrefixes])) {
    const keys = new Set([...firstPrefixes.keys(), ...secondPrefixes.keys()]);
    const mismatch = [...keys].find(
      (key) => stableJson(firstPrefixes.get(key)) !== stableJson(secondPrefixes.get(key))
    );
    throw new Error(
      `Two clean H0 passes produced different participant prompts or outputs${mismatch ? ` for ${mismatch}` : ''}.`
    );
  }
}

function assertParticipantPromptsSanitized(
  passes: readonly Map<string, { prompts: string[]; outputs: string[] }>[],
  participants: LabParticipantCorpus,
  assignments: readonly LabControlledAssignment[],
  oracles: readonly LabOracleCase[],
  assignmentOracles: readonly LabControlledAssignmentOracle[]
): void {
  const participantByCase = new Map(participants.cases.map((item) => [item.caseId, item]));
  const forbiddenLabels = new Set([
    ...participants.cases.map((item) => item.caseId),
    ...assignments.flatMap((item) => [
      item.assignmentId,
      item.bundleId,
      item.variantId,
      item.conditionId
    ]),
    ...oracles.flatMap((item) => [item.evaluationKind, ...item.mechanismTags]),
    ...assignmentOracles.flatMap((item) => [item.treatment, item.expectedTransition])
  ]);
  const forbiddenJsonKeys = [
    'caseId',
    'partition',
    'domain',
    'bundleId',
    'variantId',
    'fixedInitial',
    'treatment',
    'truthBearing',
    'targetClaimIds',
    'expectedTransition',
    'mechanismTags',
    'acceptedFinalStatuses',
    'acceptedAnswerValueSets',
    'acceptedAnswerOptionSets',
    'expectedMaterialIssues',
    'metricOpportunities',
    'participantAccess'
  ];

  for (const pass of passes) {
    for (const [trajectoryKey, record] of pass) {
      const separator = trajectoryKey.indexOf(':');
      const caseId = separator === -1 ? trajectoryKey : trajectoryKey.slice(0, separator);
      const participantCase = participantByCase.get(caseId);
      if (!participantCase) {
        throw new Error(`H0 prompt sanitation cannot resolve trajectory ${trajectoryKey}.`);
      }
      for (const prompt of record.prompts) {
        for (const label of forbiddenLabels) {
          if (label && prompt.includes(label)) {
            throw new Error(
              `H0 participant prompt leaked internal allocation or scorer label ${label}.`
            );
          }
        }
        for (const key of forbiddenJsonKeys) {
          if (prompt.includes(`"${key}":`)) {
            throw new Error(`H0 participant prompt leaked scorer-only field ${key}.`);
          }
        }

        const publicCase = promptJsonSection(prompt, 'Public case:');
        if (!publicCase || typeof publicCase !== 'object' || Array.isArray(publicCase)) {
          throw new Error('H0 participant prompt lacks a parseable public-case projection.');
        }
        const topics = (publicCase as { topics?: unknown }).topics;
        if (
          !Array.isArray(topics) ||
          topics.length !== participantCase.topics.length ||
          topics.some(
            (topic) =>
              !topic ||
              typeof topic !== 'object' ||
              (topic as { label?: unknown }).label !== 'case topic'
          )
        ) {
          throw new Error(`H0 participant prompt exposed a category label for ${caseId}.`);
        }
        const publicCaseText = stableJson(publicCase);
        for (const topic of participantCase.topics) {
          if (
            topic.label !== 'case topic' &&
            publicCaseText.includes(JSON.stringify(topic.label))
          ) {
            throw new Error(`H0 public-case payload exposed private category ${topic.label}.`);
          }
        }
      }
    }
  }
}

function promptJsonSection(prompt: string, heading: string): unknown {
  const lines = prompt.split('\n');
  const headingIndex = lines.indexOf(heading);
  if (headingIndex === -1 || headingIndex + 1 >= lines.length) return undefined;
  try {
    return JSON.parse(lines[headingIndex + 1]!);
  } catch {
    return undefined;
  }
}

function assertParserRoundTrip(
  records: Array<{ run: LabProtocolRunResult }>
): void {
  for (const { run } of records) {
    for (const artifact of run.artifacts) {
      const accepted = acceptedLabOutput(artifact);
      if (!accepted) continue;
      const raw = artifact.output.attempts.find((attempt) => attempt.output)?.rawText;
      if (!raw) throw new Error(`H0 parser lost accepted raw text for ${artifact.artifactId}.`);
      const reparsed = createLabOutputRecord({ callId: 'h0-round-trip', rawText: raw });
      const reparsedOutput = acceptedLabOutput({ ...artifact, output: reparsed });
      if (!reparsedOutput || stableJson(reparsedOutput) !== stableJson(accepted)) {
        throw new Error(`H0 parser round-trip changed ${artifact.artifactId}.`);
      }
    }
  }
}

function assertHandScoredTransition(
  records: Array<{ run: LabProtocolRunResult; participantCase: LabParticipantCase }>,
  oracleByCase: Map<string, LabOracleCase>
): void {
  const record = records.find(
    (item) =>
      item.run.caseId === 'DEV-OBJ-03' &&
      item.run.conditionId === 'CONTROL_NO_FEEDBACK_B1'
  );
  if (!record) throw new Error('H0 hand-scored transition fixture is missing.');
  const score = scoreLabTrajectory({
    participantCase: record.participantCase,
    oracleCase: oracleByCase.get(record.run.caseId)!,
    artifacts: record.run.artifacts,
    initialArtifactIds: record.run.initialArtifactIds,
    terminalArtifactIds: record.run.terminalArtifactIds,
    transitionLinks: record.run.transitionLinks
  });
  if (
    score.wrongToRightCorrection.count !== 2 ||
    score.wrongToRightCorrection.opportunities !== 3 ||
    score.wrongToRightCorrection.rate !== 2 / 3
  ) {
    throw new Error('H0 hand-scored wrong-to-right transition did not equal 2/3.');
  }
}

async function assertContextualReferenceControls(
  fixtureRoot: string,
  participants: LabParticipantCorpus,
  assignments: readonly LabControlledAssignment[]
): Promise<void> {
  const representatives = new Map<string, {
    assignment: LabControlledAssignment;
    participantCase: LabParticipantCase;
    intervention: Awaited<ReturnType<typeof loadLabPublicIntervention>>;
  }>();
  for (const assignment of assignments) {
    const intervention = await loadLabPublicIntervention(fixtureRoot, assignment);
    if (representatives.has(intervention.signalKind)) continue;
    const participantCase = participants.cases.find((item) => item.caseId === assignment.caseId);
    if (!participantCase) throw new Error('H0 contextual-reference case is unavailable.');
    representatives.set(intervention.signalKind, { assignment, participantCase, intervention });
  }
  const requiredSignalKinds = ['NONE', 'PEER_MESSAGE', 'PEER_SET', 'EVIDENCE_PACKET'];
  if (requiredSignalKinds.some((signalKind) => !representatives.has(signalKind))) {
    throw new Error('H0 controlled-signal response-target coverage is incomplete.');
  }

  for (const signalKind of requiredSignalKinds) {
    const representative = representatives.get(signalKind)!;
    const { assignment, participantCase, intervention } = representative;
    const plan = getLabProtocolPlan(assignment.conditionId);
    const validOutput = scriptedPublicOutput(participantCase, {
      callKey: 'h0:context:response',
      prompt: '',
      outputSchema: {},
      model: 'scripted',
      reasoningEffort: 'none',
      seed: 17,
      maximumOutputTokens: plan.calls[0]!.maxOutputTokens,
      maximumCallMs: 2_000,
      experimentDeadlineMs: Date.now() + 30_000
    });
    const signalArtifactId = intervention.artifacts
      .map((artifact) => artifact.artifactId)
      .find((artifactId): artifactId is string => typeof artifactId === 'string');
    const invalidOutput = structuredClone(validOutput);
    invalidOutput.responses = [{
      id: 'response-1',
      targetArtifactId: signalArtifactId ?? 'INITIAL',
      targetIssueId: 'issue-1',
      disposition: 'REJECT',
      statement: 'This response target was not supplied as a structured issue.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'Scripted H0 fixture.' }],
      changedClaimIds: []
    }];

    let primaryPrompt = '';
    const repairingDriver = new ScriptedLabTextDriver((call, index) => {
      if (index === 0) primaryPrompt = call.prompt;
      return JSON.stringify(index === 0 ? invalidOutput : validOutput);
    });
    const repaired = await runLabProtocol({
      participantCase,
      plan,
      driver: repairingDriver,
      intervention,
      modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
      limits: { ...normalLimits(plan), maximumCalls: plan.maximumCalls + 1 }
    });
    await repairingDriver.close();
    const repairedArtifact = repaired.artifacts.at(-1);
    const responseTargets = promptJsonSection(
      primaryPrompt,
      'Valid structured response targets (exact ids; empty means responses must be []):'
    );
    if (
      stableJson(responseTargets) !== '[]' ||
      !primaryPrompt.includes('Never invent a targetIssueId for a plain-text signal') ||
      repaired.status !== 'COMPLETED' ||
      repaired.realizedBudget.dispatchedCalls !== 2 ||
      repairedArtifact?.output.status !== 'VALID' ||
      repairedArtifact.output.acceptedAttemptNumber !== 2 ||
      !repairedArtifact.output.attempts[0]?.validationErrors.some(
        (error) => error.code === 'INVALID_REFERENCE' &&
          error.path === '$.responses[0].targetIssueId'
      )
    ) {
      throw new Error(
        `H0 did not enforce the empty structured response-target contract for ${signalKind}.`
      );
    }
  }

  const rejectionFixture = representatives.get('PEER_MESSAGE')!;
  const rejectionPlan = getLabProtocolPlan(rejectionFixture.assignment.conditionId);
  const invalidOutput = scriptedPublicOutput(rejectionFixture.participantCase, {
    callKey: 'h0:context:response',
    prompt: '',
    outputSchema: {},
    model: 'scripted',
    reasoningEffort: 'none',
    seed: 17,
    maximumOutputTokens: rejectionPlan.calls[0]!.maxOutputTokens,
    maximumCallMs: 2_000,
    experimentDeadlineMs: Date.now() + 30_000
  });
  invalidOutput.responses = [{
    id: 'response-1',
    targetArtifactId: 'peer-1',
    targetIssueId: 'issue-1',
    disposition: 'REJECT',
    statement: 'This response target was not supplied as a structured issue.',
    evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'Scripted H0 fixture.' }],
    changedClaimIds: []
  }];
  const rejectingDriver = new ScriptedLabTextDriver(() => JSON.stringify(invalidOutput));
  const rejected = await runLabProtocol({
    participantCase: rejectionFixture.participantCase,
    plan: rejectionPlan,
    driver: rejectingDriver,
    intervention: rejectionFixture.intervention,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: { ...normalLimits(rejectionPlan), maximumCalls: rejectionPlan.maximumCalls + 1 }
  });
  await rejectingDriver.close();
  if (
    rejected.status !== 'FAILED' ||
    rejected.stopReason !== 'SCHEMA_FAILURE_AFTER_REPAIR' ||
    rejected.realizedBudget.dispatchedCalls !== 2 ||
    rejected.artifacts.at(-1)?.output.status !== 'INVALID' ||
    rejected.artifacts.at(-1)?.output.acceptedAttemptNumber !== null
  ) {
    throw new Error('H0 accepted an invented contextual reference after its bounded repair.');
  }
}

async function assertFaultAndBudgetControls(participantCase: LabParticipantCase): Promise<void> {
  const plan = getLabProtocolPlan('SELF_REVIEW_B3');
  await expectRunRejection(
    participantCase,
    plan,
    { ...normalLimits(plan), maximumCalls: plan.maximumCalls - 1 },
    'call ceiling'
  );
  const auditPlan = getLabProtocolPlan('SAME_C_AUDIT_B6');
  await expectRunRejection(
    participantCase,
    auditPlan,
    { ...normalLimits(auditPlan), maximumRounds: auditPlan.maximumRounds - 1 },
    'round ceiling'
  );

  const outputLimitedCalls = plan.calls.map((call, index) => ({
    ...call,
    maxOutputTokens: index === 0 ? 1 : call.maxOutputTokens
  }));
  const outputLimitedPlan = {
    ...plan,
    calls: outputLimitedCalls,
    maximumOutputTokens: outputLimitedCalls.reduce(
      (sum, call) => sum + call.maxOutputTokens,
      0
    )
  };
  const outputLimitDriver = new ScriptedLabTextDriver((call) =>
    JSON.stringify(scriptedPublicOutput(participantCase, call))
  );
  const outputLimitRun = await runLabProtocol({
    participantCase,
    plan: outputLimitedPlan,
    driver: outputLimitDriver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: normalLimits(outputLimitedPlan)
  });
  await outputLimitDriver.close();
  const limitedCall = outputLimitRun.calls[0];
  if (
    outputLimitRun.status !== 'STOPPED' ||
    outputLimitRun.stopReason !== 'HARD_TOKEN_CAP' ||
    limitedCall?.failure?.kind !== 'TOKEN_LIMIT_EXCEEDED' ||
    (limitedCall.usage?.last.outputTokens ?? Number.POSITIVE_INFINITY) > 1 ||
    Buffer.byteLength(limitedCall.rawText, 'utf8') > 4
  ) {
    throw new Error('H0 scripted per-call output-token limit was not enforced at the boundary.');
  }

  const aggregateTokenDriver = new ScriptedLabTextDriver((call) =>
    JSON.stringify(scriptedPublicOutput(participantCase, call))
  );
  const aggregateTokenRun = await runLabProtocol({
    participantCase,
    plan,
    driver: aggregateTokenDriver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: { ...normalLimits(plan), maximumObservedTotalTokens: 1 }
  });
  await aggregateTokenDriver.close();
  if (
    aggregateTokenRun.status !== 'STOPPED' ||
    aggregateTokenRun.stopReason !== 'HARD_TOKEN_CAP'
  ) {
    throw new Error('H0 aggregate token-limit injection did not stop at the hard boundary.');
  }

  const timeDriver = new ScriptedLabTextDriver(async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return JSON.stringify(scriptedPublicOutput(participantCase, call));
  });
  const timeRun = await runLabProtocol({
    participantCase,
    plan,
    driver: timeDriver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: { ...normalLimits(plan), maximumExperimentMs: 1 }
  });
  await timeDriver.close();
  if (timeRun.status !== 'STOPPED' || timeRun.stopReason !== 'HARD_TIME_CAP') {
    throw new Error('H0 time-limit injection did not stop at the hard boundary.');
  }

  const repairDriver = new ScriptedLabTextDriver((call, index) =>
    index === 0 ? '{' : JSON.stringify(scriptedPublicOutput(participantCase, call))
  );
  const repairRun = await runLabProtocol({
    participantCase,
    plan,
    driver: repairDriver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: { ...normalLimits(plan), maximumCalls: plan.maximumCalls + 1 }
  });
  await repairDriver.close();
  if (
    repairRun.status !== 'COMPLETED' ||
    !repairRun.artifacts[0]?.output.repairAttempted ||
    repairRun.realizedBudget.dispatchedCalls !== plan.maximumCalls + 1
  ) {
    throw new Error('H0 charged schema-repair injection did not complete exactly once.');
  }

  const invalidDriver = new ScriptedLabTextDriver(() => '{');
  const invalidRun = await runLabProtocol({
    participantCase,
    plan,
    driver: invalidDriver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: { ...normalLimits(plan), maximumCalls: plan.maximumCalls + 1 }
  });
  await invalidDriver.close();
  if (invalidRun.status !== 'FAILED' || invalidRun.stopReason !== 'SCHEMA_FAILURE_AFTER_REPAIR') {
    throw new Error('H0 invalid-after-repair injection did not fail finitely.');
  }
}

async function expectRunRejection(
  participantCase: LabParticipantCase,
  plan: ReturnType<typeof getLabProtocolPlan>,
  limits: ReturnType<typeof normalLimits>,
  expected: string
): Promise<void> {
  const driver = new ScriptedLabTextDriver((call) =>
    JSON.stringify(scriptedPublicOutput(participantCase, call))
  );
  let message = '';
  try {
    await runLabProtocol({
      participantCase,
      plan,
      driver,
      modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
      limits
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await driver.close();
  }
  if (!message.includes(expected)) throw new Error(`H0 did not reject the lower ${expected}.`);
}

async function assertLedgerCompleteness(ledger: LabArtifactLedger): Promise<void> {
  const eventDirectory = path.join(ledger.runDirectory, 'events');
  const eventNames = (await fs.readdir(eventDirectory)).sort();
  const events = await Promise.all(
    eventNames.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(eventDirectory, name), 'utf8')) as {
        sequence: number;
        eventType: string;
      }
    )
  );
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error('H0 ledger event sequence is incomplete.');
  }
  const submitted = events.filter((event) => event.eventType === 'CALL_SUBMITTED').length;
  const settled = events.filter(
    (event) => event.eventType === 'CALL_COMPLETED' || event.eventType === 'CALL_FAILED'
  ).length;
  if (submitted !== settled) throw new Error('H0 ledger lost an attempted call settlement.');

  const artifactDirectory = path.join(ledger.runDirectory, 'artifacts');
  for (const name of await fs.readdir(artifactDirectory)) {
    if (!name.endsWith('.json')) throw new Error(`Unexpected H0 artifact file: ${name}`);
    const digest = await sha256File(path.join(artifactDirectory, name));
    if (name !== `${digest}.json`) throw new Error(`H0 artifact digest mismatch: ${name}`);
  }
}

function scriptedPublicOutput(
  participantCase: LabParticipantCase,
  input: LabTextCallInput
): LabPublicOutput {
  const callId = input.callKey.split(':').at(-1)!;
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: { summary: `Scripted public output for ${callId}.`, values: [], selectedOptionIds: [] },
    claims: participantCase.propositions.map((proposition, index) => ({
      id: `c-out-${index + 1}`,
      propositionId: proposition.id,
      topicId: proposition.topicId,
      stance: 'ACCEPT',
      statement: proposition.text,
      evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'Scripted H0 fixture.' }],
      assumptionIds: [],
      confidence: 0.5
    })),
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: `Scripted H0 resolution for ${callId}.`,
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.5
  };
}

function assertFrozenPrefix(
  values: Map<string, { prompts: string[]; outputs: string[] }>,
  caseId: string,
  leftCondition: string,
  rightCondition: string,
  prefixLength: number
): void {
  const left = values.get(`${caseId}:${leftCondition}`);
  const right = values.get(`${caseId}:${rightCondition}`);
  if (!left || !right) throw new Error('H0 frozen-prefix trajectories are missing.');
  if (
    stableJson(left.prompts.slice(0, prefixLength)) !==
      stableJson(right.prompts.slice(0, prefixLength)) ||
    stableJson(left.outputs.slice(0, prefixLength)) !==
      stableJson(right.outputs.slice(0, prefixLength))
  ) {
    throw new Error(
      `H0 detected a non-identical ${prefixLength}-call frozen prefix for ${leftCondition}/${rightCondition}.`
    );
  }
}

function assertAuditPrefixDefinitions(): void {
  const abcCalls = getLabProtocolPlan('ABC_B5').calls;
  for (const conditionId of [
    'SAME_C_AUDIT_B6',
    'RECONSTRUCTED_C_AUDIT_B6',
    'FRESH_D_AUDIT_B6'
  ] as const) {
    const auditPrefix = getLabProtocolPlan(conditionId).calls.slice(0, abcCalls.length);
    if (stableJson(auditPrefix) !== stableJson(abcCalls)) {
      throw new Error(`${conditionId} changed the frozen ABC call definitions.`);
    }
  }
}

async function runSessionSemanticsCase(
  participantCase: LabParticipantCase,
  conditionId: 'SAME_C_AUDIT_B6' | 'RECONSTRUCTED_C_AUDIT_B6' | 'FRESH_D_AUDIT_B6'
): Promise<LabProtocolRunResult> {
  const driver = new ScriptedLabTextDriver((call) =>
    JSON.stringify(scriptedPublicOutput(participantCase, call))
  );
  const plan = getLabProtocolPlan(conditionId);
  const run = await runLabProtocol({
    participantCase,
    plan,
    driver,
    modelConfiguration: { model: 'scripted', reasoningEffort: 'none', seed: 17 },
    limits: {
      maximumCalls: plan.maximumCalls,
      maximumRounds: plan.maximumRounds,
      maximumInputTokensPerCall: 7_000,
      maximumObservedTotalTokens: 50_000,
      maximumCallMs: 2_000,
      maximumExperimentMs: 30_000,
      maximumConcurrency: 2
    }
  });
  await driver.close();
  return run;
}

function assertAuditSessionSemantics(
  same: LabProtocolRunResult,
  reconstructed: LabProtocolRunResult,
  fresh: LabProtocolRunResult
): void {
  const calls = (run: LabProtocolRunResult) =>
    new Map(run.calls.map((call) => [call.callKey.split(':').at(-1), call]));
  const sameCalls = calls(same);
  const reconstructedCalls = calls(reconstructed);
  const freshCalls = calls(fresh);
  if (
    sameCalls.get('C')?.session?.providerThreadId !==
    sameCalls.get('audit')?.session?.providerThreadId
  ) {
    throw new Error('Same-C audit did not continue the mapper session.');
  }
  if (
    reconstructedCalls.get('C')?.session?.providerThreadId ===
    reconstructedCalls.get('audit')?.session?.providerThreadId ||
    freshCalls.get('C')?.session?.providerThreadId ===
    freshCalls.get('audit')?.session?.providerThreadId
  ) {
    throw new Error('Fresh reconstructed/D audit reused latent C session state.');
  }
}

async function assertEvaluationOnlyImports(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'src', 'dev', 'discourseLab');
  const fileNames = (await fs.readdir(directory)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
  );
  const forbidden = [
    'TaskManagerService',
    'FileTaskStore',
    'DiscourseService',
    'FileDiscourseStore',
    '/git/',
    'GitHub',
    '/renderer/',
    '/electron/'
  ];
  for (const name of fileNames) {
    const source = await fs.readFile(path.join(directory, name), 'utf8');
    const importText = source
      .split('\n')
      .filter((line) => /^import\b/u.test(line.trim()) || /\bfrom\s+['"]/u.test(line))
      .join('\n');
    for (const token of forbidden) {
      if (importText.includes(token)) {
        throw new Error(`Evaluation-only lab source ${name} references forbidden authority ${token}.`);
      }
    }
  }
}
