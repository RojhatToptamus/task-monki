import fs from 'node:fs/promises';
import path from 'node:path';
import { LAB_PARTICIPANT_CASE_SCHEMA_VERSION } from './contracts';
import { CODEX_LAB_TEXT_DRIVER_ID } from './CodexTextDriver';
import {
  LAB_LEDGER_SCHEMA_VERSION,
  sha256Text,
  stableJson,
  type LabArtifactLedger,
  type LabComponentLock,
  type LabRunManifest
} from './ledger';
import {
  LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA,
  LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  validateLabPublicOutputV4,
  type LabPublicOutputV4,
  type LabPublicOutputV4ValidationContext
} from './outputV4';
import type {
  LabDriverPreflight,
  LabTextCallInput,
  LabTextCallResult,
  LabTextDriver
} from './textDriver';

export const H1C_PROBE_REPORT_SCHEMA_VERSION =
  'task-monki/discourse-lab-h1c-schema-probe@v3' as const;
export const H1C_PROBE_VERSION = 'h1c-public-schema-probe@v4' as const;
export const H1C_PROBE_REPORT_NAME = 'h1c-public-schema-probe' as const;
export const H1C_PROBE_DRIVER_ID = CODEX_LAB_TEXT_DRIVER_ID;
export const H1C_PROBE_MODEL = 'gpt-5.6-sol' as const;
export const H1C_PROBE_REASONING_EFFORT = 'high' as const;
export const H1C_PROBE_SERVICE_TIER = 'default' as const;
export const H1C_PROBE_TARGET_OUTPUT_TOKENS = 900 as const;
export const H1C_PROBE_SAFETY_OUTPUT_TOKENS = 25_000 as const;
export const H1C_PROBE_MAXIMUM_CALL_MS = 120_000 as const;
export const H1C_PROBE_MAXIMUM_EXPERIMENT_MS = 180_000 as const;
export const H1C_PROBE_MAXIMUM_CLOSE_MS = 30_000 as const;
export const H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS = 100_000 as const;

const H1C_PROBE_DRAFT: LabPublicOutputV4 = {
  schemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
  completionDisposition: 'COMPLETE',
  answer: {
    summary: 'Draft: the arithmetic answer is not four and the supplemental label is unknown.',
    selectedOptionIds: [],
    epistemicState: 'UNDERDETERMINED',
    assessmentConfidence: 0.7
  },
  propositionAssessments: [
    {
      id: 'probe-draft-assessment-p1',
      propositionId: 'probe-p1',
      topicId: 'probe-topic',
      assessment: 'CONTRADICTED',
      statement: 'The draft rejects the supplied arithmetic proposition.',
      factualEvidence: [{
        sourceId: 'PROMPT', relation: 'CONTRADICTS', note: 'Draft directional claim.'
      }],
      artifactReferences: [],
      assumptionIds: [],
      assessmentConfidence: 0.7
    },
    {
      id: 'probe-draft-assessment-p2',
      propositionId: 'probe-p2',
      topicId: 'probe-topic',
      assessment: 'UNRESOLVED',
      statement: 'The draft lacks a factual source for the supplemental label.',
      factualEvidence: [{
        sourceId: 'PROMPT', relation: 'LIMITS', note: 'The base prompt omits the label.'
      }],
      artifactReferences: [],
      assumptionIds: [],
      assessmentConfidence: 0.95
    }
  ],
  assumptions: [],
  issues: [{
    id: 'probe-draft-issue',
    targetArtifactId: 'CASE',
    targetPropositionId: 'probe-p2',
    kind: 'MISSING_INFORMATION',
    severity: 'MATERIAL',
    statement: 'The draft cannot determine the supplemental label from the base case.',
    factualEvidence: [{
      sourceId: 'PROMPT', relation: 'LIMITS', note: 'The base prompt omits the label.'
    }],
    artifactReferences: [],
    assessmentConfidence: 0.95
  }],
  responses: [],
  disagreements: [],
  resolution: {
    status: 'UNRESOLVED',
    basis: 'INSUFFICIENT_INFORMATION',
    summary: 'The supplemental-label issue remains open in the draft.',
    resolvedIssueIds: [],
    unresolvedIssueIds: ['probe-draft-issue']
  },
  informationRequests: [],
  abstention: null,
  selfCorrections: []
};

const H1C_PROBE_CONTEXT: LabPublicOutputV4ValidationContext = {
  participantCase: {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'H1C-SCHEMA-PROBE',
    question: 'In standard integer arithmetic, what is two plus two?',
    evidence: [],
    propositions: [
      {
        id: 'probe-p1',
        topicId: 'probe-topic',
        text: 'Two plus two equals four.'
      },
      {
        id: 'probe-p2',
        topicId: 'probe-topic',
        text: 'The supplemental label is BLUE.'
      }
    ],
    options: [{ id: 'probe-o4', text: '4' }],
    topics: [{ id: 'probe-topic', label: 'Synthetic compatibility probe' }]
  },
  interactionStage: 'CRITIQUE_RESPONSE',
  visibleInterventionArtifacts: [
    {
      artifactKind: 'POSITION',
      artifactId: 'DRAFT',
      propositionIds: ['probe-p1', 'probe-p2'],
      publicOutput: H1C_PROBE_DRAFT,
      provenance: { sourceLabel: 'synthetic probe draft', containsNewFacts: false }
    },
    {
      artifactKind: 'CRITIQUE',
      artifactId: 'probe-critique',
      issueId: 'probe-issue',
      targetArtifactId: 'DRAFT',
      targetPropositionId: 'probe-p1',
      text: 'Recheck the stated addition using only the ordinary-text case.',
      provenance: { sourceLabel: 'synthetic probe critique', containsNewFacts: false }
    },
    {
      artifactKind: 'FACTUAL_EVIDENCE',
      artifactId: 'probe-evidence-artifact',
      evidenceId: 'probe-evidence',
      text: 'Supplemental label: BLUE.',
      provenance: { sourceLabel: 'synthetic probe evidence', containsNewFacts: true }
    }
  ]
};

export const H1C_PROBE_PROMPT = [
  `DISCOURSE_PROTOCOL_LAB_SCHEMA_PROBE_VERSION: ${H1C_PROBE_VERSION}`,
  `PUBLIC_OUTPUT_SCHEMA_VERSION: ${LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION}`,
  '',
  'This is a harmless ordinary-text 2 + 2 compatibility probe, not a corpus case.',
  'Use only the synthetic case and public artifacts below. Do not use tools, files,',
  'repositories, browsing, apps, MCP, outside context, or private chain-of-thought.',
  '',
  'Return exactly one public-output-v4 JSON object with these public results:',
  '- completionDisposition COMPLETE; selected option probe-o4;',
  '  epistemicState RESOLVED.',
  '- Exactly two proposition assessments: probe-assessment-p1 SUPPORTS probe-p1 from',
  '  factual source PROMPT, and probe-assessment-p2 SUPPORTS probe-p2 from factual',
  '  source probe-evidence.',
  '- Exactly one response, probe-response-1, ACCEPTING probe-issue on probe-critique.',
  '  It must use a RESPONDS_TO artifact reference, cite PROMPT rather than the critique',
  '  as factual evidence, and list probe-assessment-p1 as changed.',
  '- No assumptions, new issues, self-corrections, disagreements, information requests, or abstention.',
  '- Resolution RESOLVED by FACTUAL_EVIDENCE with both probe-issue and the visible',
  '  DRAFT issue probe-draft-issue resolved, and no unresolved issue.',
  '- Do not add analysis, rationale, scratchpad, or hidden-reasoning fields.',
  '',
  'SYNTHETIC CASE AND PUBLIC ARTIFACTS:',
  stableJson(H1C_PROBE_CONTEXT)
].join('\n');

export const H1C_PROBE_OUTPUT_SCHEMA_SHA256 = sha256Text(
  `${stableJson(LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA)}\n`
);
export const H1C_PROBE_PROMPT_SHA256 = sha256Text(H1C_PROBE_PROMPT);
export const H1C_PROBE_CONTEXT_SHA256 = sha256Text(
  `${stableJson(H1C_PROBE_CONTEXT)}\n`
);

export interface H1cProbeFailureDetail extends Record<string, unknown> {
  name: string;
  message: string;
  cause?: H1cProbeFailureDetail;
  errors?: H1cProbeFailureDetail[];
  omittedErrors?: number;
  truncated?: true;
}

export interface H1cProbeCloseResult {
  status: 'CLEAN' | 'FAILED' | 'TIMED_OUT';
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  maximumMs: number;
  boundaryViolations: string[];
  failure?: H1cProbeFailureDetail;
}

export interface H1cProbeValidationError {
  path: string;
  code: string;
  message: string;
}

export interface H1cProbeReport {
  schemaVersion: typeof H1C_PROBE_REPORT_SCHEMA_VERSION;
  probeVersion: typeof H1C_PROBE_VERSION;
  runId: string;
  status: 'PASSED' | 'FAILED';
  startedAt: string;
  completedAt: string;
  componentLocks: LabComponentLock;
  componentLocksSha256: string;
  driverId: typeof H1C_PROBE_DRIVER_ID;
  model: typeof H1C_PROBE_MODEL;
  reasoningEffort: typeof H1C_PROBE_REASONING_EFFORT;
  serviceTier: typeof H1C_PROBE_SERVICE_TIER;
  publicOutputSchemaVersion: typeof LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION;
  publicOutputSchemaSha256: string;
  promptSha256: string;
  contextSha256: string;
  budgets: {
    maximumAttempts: 1;
    targetOutputTokens: typeof H1C_PROBE_TARGET_OUTPUT_TOKENS;
    safetyOutputTokens: typeof H1C_PROBE_SAFETY_OUTPUT_TOKENS;
    maximumObservedTotalTokens: typeof H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS;
    maximumCallMs: typeof H1C_PROBE_MAXIMUM_CALL_MS;
    maximumExperimentMs: typeof H1C_PROBE_MAXIMUM_EXPERIMENT_MS;
    maximumCloseMs: typeof H1C_PROBE_MAXIMUM_CLOSE_MS;
  };
  boundary: LabDriverPreflight | null;
  /** Full provider result, including raw text, usage, lifecycle, violations, and failure. */
  call: LabTextCallResult | null;
  localValidation: {
    status: 'PASSED' | 'FAILED' | 'NOT_RUN';
    errors: H1cProbeValidationError[];
  };
  semanticValidation: {
    status: 'PASSED' | 'FAILED' | 'NOT_RUN';
    failedChecks: string[];
  };
  close: H1cProbeCloseResult;
  latency: {
    probeElapsedMs: number;
    callElapsedMs: number | null;
    submitToAcknowledgementMs: number | null;
    acknowledgementToStartMs: number | null;
    startToFirstOutputMs: number | null;
    closeElapsedMs: number;
  };
  operationFailure?: H1cProbeFailureDetail;
  failedChecks: string[];
}

export interface H1cProbeReceipt {
  runId: string;
  manifestSha256: string;
  reportSha256: string;
  componentLocksSha256: string;
  publicOutputSchemaSha256: string;
  promptSha256: string;
  contextSha256: string;
  report: H1cProbeReport;
}

export interface H1cProbeDriver extends LabTextDriver {
  getProcessBoundaryViolations(): string[];
}

export function h1cProbeManifestBudget(): LabRunManifest['budgets'] {
  return {
    maximumCalls: 1,
    maximumRounds: 1,
    maximumOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
    maximumOutputTokenSafetyCeiling: H1C_PROBE_SAFETY_OUTPUT_TOKENS,
    maximumObservedTotalTokens: H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS,
    maximumCallMs: H1C_PROBE_MAXIMUM_CALL_MS,
    maximumExperimentMs: H1C_PROBE_MAXIMUM_EXPERIMENT_MS
  };
}

export function buildH1cProbeManifest(input: {
  runId: string;
  componentLocks: LabComponentLock;
  providerUsageExplicitlyAuthorized: true;
  createdAt?: string;
}): LabRunManifest {
  assertSafeRunId(input.runId);
  assertH1cComponentLocks(input.componentLocks);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!validTimestamp(createdAt)) throw new Error('H1c probe manifest createdAt is invalid.');
  return {
    schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
    runId: input.runId,
    phase: 'HARNESS_VALIDATION',
    status: 'PLANNED',
    createdAt,
    driver: {
      id: H1C_PROBE_DRIVER_ID,
      model: H1C_PROBE_MODEL,
      modelProvider: 'openai',
      reasoningEffort: H1C_PROBE_REASONING_EFFORT,
      serviceTier: H1C_PROBE_SERVICE_TIER,
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
    locks: structuredClone(input.componentLocks),
    caseIds: [],
    conditionIds: [],
    budgets: h1cProbeManifestBudget(),
    providerUsageExplicitlyAuthorized: input.providerUsageExplicitlyAuthorized
  };
}

export function h1cProbeBoundaryAllowsDispatch(boundary: LabDriverPreflight): boolean {
  return (
    boundary.driverId === H1C_PROBE_DRIVER_ID &&
    boundary.ready &&
    boundary.accountPresent &&
    !boundary.requiresAuthentication &&
    boundary.capabilities.textOnlyProviderEnforced === false &&
    boundary.capabilities.hardOutputTokenLimit === false &&
    boundary.capabilities.hardCallTimeLimit === true &&
    boundary.capabilities.harnessVerifiedTextIsolation === true &&
    boundary.capabilities.streamingOutputTokenInterrupt === true &&
    boundary.capabilities.providerReportedTokenUsage === true &&
    boundary.boundary.status === 'ATTESTED' &&
    !boundary.boundary.failure &&
    boundary.boundary.requestedModel === H1C_PROBE_MODEL &&
    boundary.boundary.observedModel === H1C_PROBE_MODEL &&
    boundary.boundary.observedModelProvider === 'openai' &&
    boundary.boundary.requestedReasoningEffort === H1C_PROBE_REASONING_EFFORT &&
    boundary.boundary.observedReasoningEffort === H1C_PROBE_REASONING_EFFORT &&
    boundary.boundary.requestedServiceTier === H1C_PROBE_SERVICE_TIER &&
    boundary.boundary.observedServiceTier === H1C_PROBE_SERVICE_TIER &&
    boundary.boundary.instructionSources.length === 0 &&
    boundary.boundary.mcpStartupEvents.length === 0 &&
    boundary.boundary.mismatchFields.length === 0 &&
    boundary.models.some(
      (candidate) =>
        (candidate.id === H1C_PROBE_MODEL || candidate.model === H1C_PROBE_MODEL) &&
        candidate.supportedReasoningEfforts.includes(H1C_PROBE_REASONING_EFFORT)
    )
  );
}

export function buildH1cProbeReport(input: {
  runId: string;
  startedAt: string;
  completedAt: string;
  componentLocks: LabComponentLock;
  boundary: LabDriverPreflight | null;
  call: LabTextCallResult | null;
  close: H1cProbeCloseResult;
  operationFailure?: H1cProbeFailureDetail;
}): H1cProbeReport {
  assertSafeRunId(input.runId);
  assertH1cComponentLocks(input.componentLocks);
  const validation = validateProbeRawOutput(input.call?.rawText);
  const partial: Omit<H1cProbeReport, 'status' | 'failedChecks'> = {
    schemaVersion: H1C_PROBE_REPORT_SCHEMA_VERSION,
    probeVersion: H1C_PROBE_VERSION,
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    componentLocks: structuredClone(input.componentLocks),
    componentLocksSha256: componentLocksSha256(input.componentLocks),
    driverId: H1C_PROBE_DRIVER_ID,
    model: H1C_PROBE_MODEL,
    reasoningEffort: H1C_PROBE_REASONING_EFFORT,
    serviceTier: H1C_PROBE_SERVICE_TIER,
    publicOutputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    publicOutputSchemaSha256: H1C_PROBE_OUTPUT_SCHEMA_SHA256,
    promptSha256: H1C_PROBE_PROMPT_SHA256,
    contextSha256: H1C_PROBE_CONTEXT_SHA256,
    budgets: {
      maximumAttempts: 1,
      targetOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
      safetyOutputTokens: H1C_PROBE_SAFETY_OUTPUT_TOKENS,
      maximumObservedTotalTokens: H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS,
      maximumCallMs: H1C_PROBE_MAXIMUM_CALL_MS,
      maximumExperimentMs: H1C_PROBE_MAXIMUM_EXPERIMENT_MS,
      maximumCloseMs: H1C_PROBE_MAXIMUM_CLOSE_MS
    },
    boundary: input.boundary ? structuredClone(input.boundary) : null,
    call: input.call ? structuredClone(input.call) : null,
    localValidation: validation.local,
    semanticValidation: validation.semantic,
    close: structuredClone(input.close),
    latency: probeLatency(input.startedAt, input.completedAt, input.call, input.close),
    ...(input.operationFailure
      ? { operationFailure: structuredClone(input.operationFailure) }
      : {})
  };
  const failedChecks = h1cProbeProblems(partial);
  return {
    ...partial,
    status: failedChecks.length === 0 ? 'PASSED' : 'FAILED',
    failedChecks
  };
}

export async function runH1cProbe(input: {
  runId: string;
  componentLocks: LabComponentLock;
  ledger: LabArtifactLedger;
  driver: H1cProbeDriver;
}): Promise<{ runId: string; runDirectory: string; report: H1cProbeReport }> {
  assertSafeRunId(input.runId);
  assertH1cComponentLocks(input.componentLocks);
  input.ledger.assertRunContext('HARNESS_VALIDATION', input.componentLocks);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const deadlineMs = startedMs + H1C_PROBE_MAXIMUM_EXPERIMENT_MS;
  let boundary: LabDriverPreflight | null = null;
  let call: LabTextCallResult | null = null;
  let operationFailure: H1cProbeFailureDetail | undefined;
  try {
    boundary = await input.driver.preflight({
      model: H1C_PROBE_MODEL,
      reasoningEffort: H1C_PROBE_REASONING_EFFORT,
      serviceTier: H1C_PROBE_SERVICE_TIER,
      maximumCallMs: Math.min(30_000, H1C_PROBE_MAXIMUM_CALL_MS),
      experimentDeadlineMs: deadlineMs
    });
    await persistH1cProbeEvidence(
      input.ledger,
      {
        kind: 'H1C_PROBE_BOUNDARY',
        probeVersion: H1C_PROBE_VERSION,
        boundary
      },
      {
        eventType: 'H1C_PROBE_BOUNDARY_RECORDED',
        occurredAt: new Date().toISOString(),
        detail: { dispatchAllowed: h1cProbeBoundaryAllowsDispatch(boundary) }
      }
    );
    if (h1cProbeBoundaryAllowsDispatch(boundary)) {
      const callInput: LabTextCallInput = {
        callKey: `${H1C_PROBE_VERSION}:attempt-1`,
        prompt: H1C_PROBE_PROMPT,
        outputSchema: LAB_PUBLIC_OUTPUT_V4_JSON_SCHEMA as Record<string, unknown>,
        model: H1C_PROBE_MODEL,
        reasoningEffort: H1C_PROBE_REASONING_EFFORT,
        serviceTier: H1C_PROBE_SERVICE_TIER,
        maximumOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
        outputTokenSafetyCeiling: H1C_PROBE_SAFETY_OUTPUT_TOKENS,
        maximumCallMs: H1C_PROBE_MAXIMUM_CALL_MS,
        experimentDeadlineMs: deadlineMs
      };
      await input.ledger.append({
        eventType: 'H1C_PROBE_CALL_SUBMITTED',
        occurredAt: new Date().toISOString(),
        callId: callInput.callKey,
        detail: {
          model: callInput.model,
          reasoningEffort: callInput.reasoningEffort,
          serviceTier: callInput.serviceTier,
          promptSha256: H1C_PROBE_PROMPT_SHA256,
          contextSha256: H1C_PROBE_CONTEXT_SHA256,
          publicOutputSchemaSha256: H1C_PROBE_OUTPUT_SCHEMA_SHA256
        }
      });
      call = await input.driver.call(callInput);
      await persistH1cProbeEvidence(
        input.ledger,
        {
          kind: 'H1C_PROBE_RAW_CALL',
          probeVersion: H1C_PROBE_VERSION,
          call
        },
        {
          eventType: call.failure ? 'H1C_PROBE_CALL_FAILED' : 'H1C_PROBE_CALL_COMPLETED',
          occurredAt: call.completedAt,
          callId: call.callKey,
          detail: {
            providerStatus: call.providerStatus,
            observedTotalTokens: call.usage?.total.totalTokens ?? null,
            observedOutputTokens: call.usage?.total.outputTokens ?? null,
            lifecycleEvents: call.lifecycle.length,
            violations: call.violations.length
          }
        }
      );
    }
  } catch (error) {
    operationFailure = serializeH1cProbeFailure(error);
    operationFailure = await persistH1cProbeOperationFailure(
      input.ledger,
      operationFailure,
      boundary,
      call
    );
  }
  const close = await closeH1cProbeDriver(
    input.driver,
    Math.max(1, Math.min(H1C_PROBE_MAXIMUM_CLOSE_MS, deadlineMs - Date.now()))
  );
  try {
    await persistH1cProbeEvidence(
      input.ledger,
      {
        kind: 'H1C_PROBE_CLOSE',
        probeVersion: H1C_PROBE_VERSION,
        close
      },
      {
        eventType: close.status === 'CLEAN'
          ? 'H1C_PROBE_DRIVER_CLOSED'
          : 'H1C_PROBE_DRIVER_CLOSE_FAILED',
        occurredAt: close.completedAt,
        detail: {
          status: close.status,
          elapsedMs: close.elapsedMs,
          boundaryViolations: close.boundaryViolations.length
        }
      }
    );
  } catch (error) {
    operationFailure = combineH1cProbeFailures(
      operationFailure,
      serializeH1cProbeFailure(error),
      'H1c probe operation and close-evidence persistence failed.'
    );
  }
  const report = buildH1cProbeReport({
    runId: input.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    componentLocks: input.componentLocks,
    boundary,
    call,
    close,
    operationFailure
  });
  await input.ledger.writeReport(H1C_PROBE_REPORT_NAME, report);
  return { runId: input.runId, runDirectory: input.ledger.runDirectory, report };
}

async function persistH1cProbeEvidence(
  ledger: LabArtifactLedger,
  value: unknown,
  event: {
    eventType: string;
    occurredAt: string;
    callId?: string;
    detail?: Record<string, unknown>;
  }
): Promise<string> {
  const artifact = await ledger.putArtifact(value);
  await ledger.append({ ...event, artifactSha256: artifact.sha256 });
  return artifact.sha256;
}

async function persistH1cProbeOperationFailure(
  ledger: LabArtifactLedger,
  failure: H1cProbeFailureDetail,
  boundary: LabDriverPreflight | null,
  call: LabTextCallResult | null
): Promise<H1cProbeFailureDetail> {
  try {
    await persistH1cProbeEvidence(
      ledger,
      {
        kind: 'H1C_PROBE_OPERATION_FAILURE',
        probeVersion: H1C_PROBE_VERSION,
        boundary,
        call,
        failure
      },
      {
        eventType: 'H1C_PROBE_OPERATION_FAILED',
        occurredAt: new Date().toISOString(),
        callId: call?.callKey ?? `${H1C_PROBE_VERSION}:attempt-1`,
        detail: { failureName: failure.name }
      }
    );
    return failure;
  } catch (error) {
    return combineH1cProbeFailures(
      failure,
      serializeH1cProbeFailure(error),
      'H1c probe operation and failure-evidence persistence failed.'
    );
  }
}

function combineH1cProbeFailures(
  first: H1cProbeFailureDetail | undefined,
  second: H1cProbeFailureDetail,
  message: string
): H1cProbeFailureDetail {
  if (!first) return second;
  return { name: 'AggregateError', message, errors: [first, second] };
}

export async function closeH1cProbeDriver(
  driver: H1cProbeDriver,
  maximumMs: number = H1C_PROBE_MAXIMUM_CLOSE_MS
): Promise<H1cProbeCloseResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => driver.close())
    .then(() => ({ status: 'CLEAN' as const }))
    .catch((error) => ({
      status: 'FAILED' as const,
      failure: serializeH1cProbeFailure(error)
    }));
  const timeout = new Promise<{
    status: 'TIMED_OUT';
    failure: H1cProbeFailureDetail;
  }>((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'TIMED_OUT',
      failure: {
        name: 'TimeoutError',
        message: `Codex H1c probe driver close exceeded ${maximumMs} ms.`
      }
    }), maximumMs);
  });
  const outcome = await Promise.race([close, timeout]);
  if (timer) clearTimeout(timer);
  const completedMs = Date.now();
  let boundaryViolations: string[] = [];
  try {
    boundaryViolations = driver.getProcessBoundaryViolations();
  } catch (error) {
    const boundaryFailure = serializeH1cProbeFailure(error);
    const closeFailure = 'failure' in outcome ? outcome.failure : undefined;
    return {
      status: 'FAILED',
      failure: closeFailure
        ? {
            name: 'AggregateError',
            message: 'Driver close and boundary inspection both failed.',
            errors: [closeFailure, boundaryFailure]
          }
        : boundaryFailure,
      startedAt,
      completedAt: new Date(completedMs).toISOString(),
      elapsedMs: Math.max(0, completedMs - startedMs),
      maximumMs,
      boundaryViolations: []
    };
  }
  return {
    ...outcome,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    elapsedMs: Math.max(0, completedMs - startedMs),
    maximumMs,
    boundaryViolations: [...boundaryViolations]
  };
}

export async function loadH1cProbeReceipt(
  stateRoot: string,
  runId: string,
  activeLocks: LabComponentLock
): Promise<H1cProbeReceipt> {
  assertSafeRunId(runId);
  assertH1cComponentLocks(activeLocks);
  const root = path.resolve(stateRoot);
  const runs = path.join(root, 'runs');
  const runDirectory = path.join(runs, runId);
  const reports = path.join(runDirectory, 'reports');
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const reportPath = path.join(reports, `${H1C_PROBE_REPORT_NAME}.json`);
  await Promise.all([
    assertRealDirectory(root),
    assertRealDirectory(runs),
    assertRealDirectory(runDirectory),
    assertRealDirectory(reports),
    assertRealFile(manifestPath),
    assertRealFile(reportPath)
  ]);
  const [manifestText, reportText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(reportPath, 'utf8')
  ]);
  let manifest: LabRunManifest;
  let report: H1cProbeReport;
  try {
    manifest = JSON.parse(manifestText) as LabRunManifest;
    report = JSON.parse(reportText) as H1cProbeReport;
  } catch {
    throw new Error('H1c schema-probe receipt contains invalid JSON.');
  }
  let manifestProblems: string[];
  let reportProblems: string[];
  try {
    manifestProblems = h1cProbeManifestProblems(manifest, runId, activeLocks);
    reportProblems = h1cProbeReceiptProblems(report, runId, activeLocks);
  } catch {
    throw new Error('H1c schema-probe receipt has an invalid shape.');
  }
  if (manifestProblems.length > 0) {
    throw new Error(
      `H1c schema-probe manifest failed: ${[...new Set(manifestProblems)].join(', ')}.`
    );
  }
  if (reportProblems.length > 0) {
    throw new Error(
      `H1c schema-probe report failed: ${[...new Set(reportProblems)].join(', ')}.`
    );
  }
  return {
    runId,
    manifestSha256: sha256Text(manifestText),
    reportSha256: sha256Text(reportText),
    componentLocksSha256: report.componentLocksSha256,
    publicOutputSchemaSha256: report.publicOutputSchemaSha256,
    promptSha256: report.promptSha256,
    contextSha256: report.contextSha256,
    report
  };
}

export function serializeH1cProbeFailure(error: unknown): H1cProbeFailureDetail {
  return serializeFailureNode(error, { remainingNodes: 32, ancestors: new Set<object>() }, 0);
}

function h1cProbeManifestProblems(
  manifest: LabRunManifest,
  runId: string,
  activeLocks: LabComponentLock
): string[] {
  const problems: string[] = [];
  if (manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION) problems.push('schemaVersion');
  if (manifest.runId !== runId) problems.push('runId');
  if (manifest.phase !== 'HARNESS_VALIDATION') problems.push('phase');
  if (manifest.status !== 'PLANNED') problems.push('status');
  if (!validTimestamp(manifest.createdAt)) problems.push('createdAt');
  if (stableJson(manifest.locks) !== stableJson(activeLocks)) problems.push('locks');
  if (manifest.driver?.id !== H1C_PROBE_DRIVER_ID) problems.push('driverId');
  if (
    manifest.driver?.model !== H1C_PROBE_MODEL ||
    manifest.driver?.modelProvider !== 'openai'
  ) problems.push('model');
  if (manifest.driver?.reasoningEffort !== H1C_PROBE_REASONING_EFFORT) {
    problems.push('reasoningEffort');
  }
  if (manifest.driver?.serviceTier !== H1C_PROBE_SERVICE_TIER) {
    problems.push('serviceTier');
  }
  if (
    manifest.driver?.boundaryClass !== 'H1_DEVELOPMENT_HARNESS_VERIFIED' ||
    manifest.driver.hardOutputTokenLimit ||
    !manifest.driver.hardCallTimeLimit ||
    manifest.driver.textOnlyAttestation !== 'HARNESS_DETECTED' ||
    !manifest.driver.harnessVerifiedTextIsolation ||
    !manifest.driver.streamingOutputTokenInterrupt ||
    !manifest.driver.providerReportedTokenUsage ||
    manifest.driver.seed !== null ||
    manifest.driver.seedControl !== 'UNSUPPORTED'
  ) problems.push('driverBoundary');
  if (stableJson(manifest.budgets) !== stableJson(h1cProbeManifestBudget())) {
    problems.push('budgets');
  }
  if (manifest.caseIds.length !== 0 || manifest.conditionIds.length !== 0) {
    problems.push('corpusScope');
  }
  if (!manifest.providerUsageExplicitlyAuthorized) problems.push('providerAuthorization');
  return problems;
}

function h1cProbeReceiptProblems(
  report: H1cProbeReport,
  runId: string,
  activeLocks: LabComponentLock
): string[] {
  const problems: string[] = [];
  if (report.schemaVersion !== H1C_PROBE_REPORT_SCHEMA_VERSION) problems.push('schemaVersion');
  if (report.probeVersion !== H1C_PROBE_VERSION) problems.push('probeVersion');
  if (report.runId !== runId) problems.push('runId');
  if (report.status !== 'PASSED') problems.push('status');
  if (stableJson(report.componentLocks) !== stableJson(activeLocks)) problems.push('locks');
  if (report.componentLocksSha256 !== componentLocksSha256(activeLocks)) {
    problems.push('locksDigest');
  }
  if (report.driverId !== H1C_PROBE_DRIVER_ID) problems.push('driverId');
  if (report.model !== H1C_PROBE_MODEL) problems.push('model');
  if (report.reasoningEffort !== H1C_PROBE_REASONING_EFFORT) problems.push('reasoningEffort');
  if (report.serviceTier !== H1C_PROBE_SERVICE_TIER) problems.push('serviceTier');
  if (report.publicOutputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION) {
    problems.push('outputSchemaVersion');
  }
  if (report.publicOutputSchemaSha256 !== H1C_PROBE_OUTPUT_SCHEMA_SHA256) {
    problems.push('outputSchemaDigest');
  }
  if (report.promptSha256 !== H1C_PROBE_PROMPT_SHA256) problems.push('promptDigest');
  if (report.contextSha256 !== H1C_PROBE_CONTEXT_SHA256) problems.push('contextDigest');

  const recomputedValidation = validateProbeRawOutput(report.call?.rawText);
  if (stableJson(report.localValidation) !== stableJson(recomputedValidation.local)) {
    problems.push('localValidationRecord');
  }
  if (stableJson(report.semanticValidation) !== stableJson(recomputedValidation.semantic)) {
    problems.push('semanticValidationRecord');
  }
  const recomputedProblems = h1cProbeProblems(report);
  problems.push(...recomputedProblems);
  if (stableJson(report.failedChecks) !== stableJson(recomputedProblems)) {
    problems.push('failedChecks');
  }
  return [...new Set(problems)];
}

function h1cProbeProblems(
  report: Omit<H1cProbeReport, 'status' | 'failedChecks'> | H1cProbeReport
): string[] {
  const problems: string[] = [];
  if (!validTimestampOrder(report.startedAt, report.completedAt)) problems.push('probeTiming');
  if (report.componentLocksSha256 !== componentLocksSha256(report.componentLocks)) {
    problems.push('locksDigest');
  }
  if (
    report.publicOutputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION ||
    report.publicOutputSchemaSha256 !== H1C_PROBE_OUTPUT_SCHEMA_SHA256 ||
    report.promptSha256 !== H1C_PROBE_PROMPT_SHA256 ||
    report.contextSha256 !== H1C_PROBE_CONTEXT_SHA256
  ) problems.push('inputDigests');
  if (!report.boundary || !h1cProbeBoundaryAllowsDispatch(report.boundary)) {
    problems.push('boundaryAttestation');
  }
  const call = report.call;
  if (!call) {
    problems.push('oneCall');
  } else {
    if (call.callKey !== `${H1C_PROBE_VERSION}:attempt-1`) problems.push('callKey');
    if (
      call.requestedModel !== H1C_PROBE_MODEL ||
      call.observedModel !== H1C_PROBE_MODEL ||
      call.observedModelProvider !== 'openai' ||
      call.requestedReasoningEffort !== H1C_PROBE_REASONING_EFFORT ||
      call.observedReasoningEffort !== H1C_PROBE_REASONING_EFFORT ||
      call.requestedServiceTier !== H1C_PROBE_SERVICE_TIER ||
      call.observedServiceTier !== H1C_PROBE_SERVICE_TIER ||
      call.seed !== null
    ) problems.push('callSettings');
    if (call.failure) problems.push('providerAcceptance');
    if (call.violations.length !== 0) problems.push('boundaryViolations');
    if (!cleanCallLifecycle(call)) problems.push('cleanTerminalLifecycle');
    if (!completeProviderUsage(call)) problems.push('completeProviderUsage');
  }
  if (report.localValidation.status !== 'PASSED' || report.localValidation.errors.length !== 0) {
    problems.push('localOutputValidation');
  }
  if (
    report.semanticValidation.status !== 'PASSED' ||
    report.semanticValidation.failedChecks.length !== 0
  ) problems.push('semanticOutputValidation');
  if (
    report.close.status !== 'CLEAN' ||
    report.close.failure ||
    report.close.maximumMs <= 0 ||
    report.close.maximumMs > H1C_PROBE_MAXIMUM_CLOSE_MS ||
    !validTimestampOrder(report.close.startedAt, report.close.completedAt) ||
    report.close.elapsedMs !== elapsedMs(report.close.startedAt, report.close.completedAt)
  ) problems.push('cleanClose');
  if (
    !Array.isArray(report.close.boundaryViolations) ||
    report.close.boundaryViolations.length !== 0
  ) problems.push('processBoundaryViolations');
  if (report.operationFailure) problems.push('operationFailure');
  if (stableJson(report.budgets) !== stableJson({
    maximumAttempts: 1,
    targetOutputTokens: H1C_PROBE_TARGET_OUTPUT_TOKENS,
    safetyOutputTokens: H1C_PROBE_SAFETY_OUTPUT_TOKENS,
    maximumObservedTotalTokens: H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS,
    maximumCallMs: H1C_PROBE_MAXIMUM_CALL_MS,
    maximumExperimentMs: H1C_PROBE_MAXIMUM_EXPERIMENT_MS,
    maximumCloseMs: H1C_PROBE_MAXIMUM_CLOSE_MS
  })) problems.push('budgets');
  const expectedLatency = probeLatency(
    report.startedAt,
    report.completedAt,
    report.call,
    report.close
  );
  if (stableJson(report.latency) !== stableJson(expectedLatency)) problems.push('latency');
  return [...new Set(problems)];
}

function cleanCallLifecycle(call: LabTextCallResult): boolean {
  if (
    !call.session ||
    call.session.driverId !== H1C_PROBE_DRIVER_ID ||
    !call.providerTurnId ||
    !call.acknowledgedAt ||
    !call.startedAt ||
    !call.firstOutputAt ||
    call.providerStatus !== 'completed' ||
    call.providerAccounting.sessionAttestation !== 'ATTESTED' ||
    call.providerAccounting.threadStartStatus !== 'ATTESTED' ||
    call.providerAccounting.providerTurnStarted !== 'YES' ||
    !validTimestampOrder(call.submittedAt, call.acknowledgedAt) ||
    !validTimestampOrderWithBackwardTolerance(call.acknowledgedAt, call.startedAt, 999) ||
    !validTimestampOrder(call.startedAt, call.firstOutputAt) ||
    !validTimestampOrder(call.firstOutputAt, call.completedAt)
  ) return false;
  return lifecycleEventsAreOrdered(call.lifecycle.map((item) => item.event));
}

function lifecycleEventsAreOrdered(events: readonly string[]): boolean {
  const firstIndex = new Map<string, number>();
  events.forEach((event, index) => {
    if (!firstIndex.has(event)) firstIndex.set(event, index);
  });
  const before = (left: string, right: string): boolean => {
    const leftIndex = firstIndex.get(left);
    const rightIndex = firstIndex.get(right);
    return leftIndex !== undefined && rightIndex !== undefined && leftIndex < rightIndex;
  };
  return before('submitted', 'acknowledged') &&
    before('acknowledged', 'started') &&
    before('started', 'terminal') &&
    before('terminal', 'result-recorded') &&
    before('started', 'provider-usage-observed') &&
    before('provider-usage-observed', 'result-recorded');
}

function completeProviderUsage(call: LabTextCallResult): boolean {
  const usage = call.usage;
  const control = call.tokenControl;
  if (!usage || !control || control.usageStatus !== 'PROVIDER_REPORTED') return false;
  if (
    control.targetOutputTokens !== H1C_PROBE_TARGET_OUTPUT_TOKENS ||
    control.safetyCeilingOutputTokens !== H1C_PROBE_SAFETY_OUTPUT_TOKENS ||
    control.providerEnforcedLimit ||
    control.observedOutputTokens !== usage.last.outputTokens ||
    control.targetOvershootTokens !== Math.max(
      0,
      usage.last.outputTokens - H1C_PROBE_TARGET_OUTPUT_TOKENS
    ) ||
    control.safetyOvershootTokens !== Math.max(
      0,
      usage.last.outputTokens - H1C_PROBE_SAFETY_OUTPUT_TOKENS
    ) ||
    control.safetyOvershootTokens !== 0 ||
    usage.total.totalTokens > H1C_PROBE_MAXIMUM_OBSERVED_TOTAL_TOKENS ||
    stableJson(usage.total) !== stableJson(usage.last)
  ) return false;
  return [usage.total, usage.last].every((item) =>
    [
      item.totalTokens,
      item.inputTokens,
      item.cachedInputTokens,
      item.outputTokens,
      item.reasoningOutputTokens
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    item.totalTokens === item.inputTokens + item.outputTokens &&
    item.cachedInputTokens <= item.inputTokens &&
    item.reasoningOutputTokens <= item.outputTokens
  );
}

function validateProbeRawOutput(rawText: string | undefined): {
  local: H1cProbeReport['localValidation'];
  semantic: H1cProbeReport['semanticValidation'];
} {
  if (rawText === undefined) {
    return {
      local: { status: 'NOT_RUN', errors: [] },
      semantic: { status: 'NOT_RUN', failedChecks: [] }
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return {
      local: {
        status: 'FAILED',
        errors: [{ path: '$', code: 'INVALID_JSON', message: 'Probe output is not valid JSON.' }]
      },
      semantic: { status: 'NOT_RUN', failedChecks: [] }
    };
  }
  const validation = validateLabPublicOutputV4(value, H1C_PROBE_CONTEXT);
  if (!validation.ok) {
    return {
      local: { status: 'FAILED', errors: structuredClone(validation.errors) },
      semantic: { status: 'NOT_RUN', failedChecks: [] }
    };
  }
  const failedChecks = semanticProbeProblems(validation.value);
  return {
    local: { status: 'PASSED', errors: [] },
    semantic: {
      status: failedChecks.length === 0 ? 'PASSED' : 'FAILED',
      failedChecks
    }
  };
}

function semanticProbeProblems(output: LabPublicOutputV4): string[] {
  const problems: string[] = [];
  if (
    output.completionDisposition !== 'COMPLETE' ||
    output.answer.epistemicState !== 'RESOLVED' ||
    stableJson(output.answer.selectedOptionIds) !== stableJson(['probe-o4'])
  ) problems.push('answer');
  const assessments = new Map(
    output.propositionAssessments.map((assessment) => [assessment.propositionId, assessment])
  );
  const p1 = assessments.get('probe-p1');
  const p2 = assessments.get('probe-p2');
  if (
    output.propositionAssessments.length !== 2 ||
    p1?.id !== 'probe-assessment-p1' ||
    p1.assessment !== 'SUPPORTED' ||
    !p1.factualEvidence.some(
      (reference) => reference.sourceId === 'PROMPT' && reference.relation === 'SUPPORTS'
    )
  ) problems.push('promptProposition');
  if (
    p2?.id !== 'probe-assessment-p2' ||
    p2.assessment !== 'SUPPORTED' ||
    !p2.factualEvidence.some(
      (reference) =>
        reference.sourceId === 'probe-evidence' && reference.relation === 'SUPPORTS'
    )
  ) problems.push('evidenceProposition');
  const response = output.responses[0];
  if (
    output.responses.length !== 1 ||
    response?.id !== 'probe-response-1' ||
    response.targetArtifactId !== 'probe-critique' ||
    response.targetIssueId !== 'probe-issue' ||
    response.disposition !== 'ACCEPT' ||
    !response.changedAssessmentIds.includes('probe-assessment-p1') ||
    !response.artifactReferences.some(
      (reference) =>
        reference.artifactId === 'probe-critique' && reference.relation === 'RESPONDS_TO'
    ) ||
    response.factualEvidence.some((reference) =>
      ['probe-critique', 'probe-issue'].includes(reference.sourceId)
    ) ||
    !response.factualEvidence.some(
      (reference) => reference.sourceId === 'PROMPT' && reference.relation === 'SUPPORTS'
    )
  ) problems.push('critiqueResponse');
  if (
    output.assumptions.length !== 0 ||
    output.issues.length !== 0 ||
    output.selfCorrections.length !== 0 ||
    output.disagreements.length !== 0 ||
    output.informationRequests.length !== 0 ||
    output.abstention !== null
  ) problems.push('emptySurfaces');
  if (
    output.resolution.status !== 'RESOLVED' ||
    output.resolution.basis !== 'FACTUAL_EVIDENCE' ||
    stableJson([...output.resolution.resolvedIssueIds].sort()) !==
      stableJson(['probe-draft-issue', 'probe-issue']) ||
    output.resolution.unresolvedIssueIds.length !== 0
  ) problems.push('resolution');
  return problems;
}

function probeLatency(
  startedAt: string,
  completedAt: string,
  call: LabTextCallResult | null,
  close: H1cProbeCloseResult
): H1cProbeReport['latency'] {
  return {
    probeElapsedMs: elapsedMs(startedAt, completedAt),
    callElapsedMs: call ? elapsedMs(call.submittedAt, call.completedAt) : null,
    submitToAcknowledgementMs: call?.acknowledgedAt
      ? elapsedMs(call.submittedAt, call.acknowledgedAt)
      : null,
    acknowledgementToStartMs: call?.acknowledgedAt && call.startedAt
      ? elapsedMs(call.acknowledgedAt, call.startedAt)
      : null,
    startToFirstOutputMs: call?.startedAt && call.firstOutputAt
      ? elapsedMs(call.startedAt, call.firstOutputAt)
      : null,
    closeElapsedMs: close.elapsedMs
  };
}

function componentLocksSha256(locks: LabComponentLock): string {
  return sha256Text(`${stableJson(locks)}\n`);
}

function assertH1cComponentLocks(locks: LabComponentLock): void {
  const digests = [
    locks.participantCorpusSha256,
    locks.oracleCorpusSha256,
    locks.labSourceSha256,
    locks.preregistrationSha256
  ];
  if (
    !locks.corpusVersion ||
    !locks.preregistrationVersion ||
    !locks.promptVersion ||
    locks.outputSchemaVersion !== LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION ||
    !locks.scoringVersion ||
    !locks.protocolVersion ||
    digests.some((value) => !/^[a-f0-9]{64}$/u.test(value))
  ) {
    throw new Error('H1c probe requires complete active v4 component locks.');
  }
}

function serializeFailureNode(
  error: unknown,
  state: { remainingNodes: number; ancestors: Set<object> },
  depth: number
): H1cProbeFailureDetail {
  if (depth >= 8 || state.remainingNodes <= 0) {
    return {
      name: 'TruncatedFailure',
      message: 'Nested failure detail exceeded the bounded probe limit.',
      truncated: true
    };
  }
  if (typeof error === 'object' && error !== null) {
    if (state.ancestors.has(error)) {
      return {
        name: 'CircularFailure',
        message: 'Nested failure detail contains a cycle.',
        truncated: true
      };
    }
    state.ancestors.add(error);
  }
  state.remainingNodes -= 1;
  const detail: H1cProbeFailureDetail = {
    name: boundedFailureText(error instanceof Error ? error.name : 'UnknownError'),
    message: boundedFailureText(error instanceof Error ? error.message : safeFailureText(error))
  };
  if (error instanceof Error && error.cause !== undefined) {
    detail.cause = serializeFailureNode(error.cause, state, depth + 1);
  }
  if (error instanceof AggregateError) {
    const nested = Array.from(error.errors);
    const available = Math.max(0, state.remainingNodes);
    detail.errors = nested
      .slice(0, available)
      .map((candidate) => serializeFailureNode(candidate, state, depth + 1));
    if (nested.length > detail.errors.length) {
      detail.omittedErrors = nested.length - detail.errors.length;
      detail.truncated = true;
    }
  }
  if (typeof error === 'object' && error !== null) state.ancestors.delete(error);
  return detail;
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validTimestampOrder(startedAt: string, completedAt: string): boolean {
  return validTimestamp(startedAt) &&
    validTimestamp(completedAt) &&
    Date.parse(completedAt) >= Date.parse(startedAt);
}

function validTimestampOrderWithBackwardTolerance(
  startedAt: string,
  completedAt: string,
  maximumBackwardMs: number
): boolean {
  // Codex turn.startedAt is reported in whole seconds. The lifecycle array
  // remains the ordering authority; this permits only its truncation window.
  return validTimestamp(startedAt) &&
    validTimestamp(completedAt) &&
    Date.parse(completedAt) + maximumBackwardMs >= Date.parse(startedAt);
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === '..') {
    throw new Error('H1c schema-probe receipt has an unsafe run id.');
  }
}

async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`H1c schema-probe receipt directory is unavailable or unsafe: ${directory}`);
  }
}

async function assertRealFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`H1c schema-probe receipt file is unavailable or unsafe: ${filePath}`);
  }
}

function boundedFailureText(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`;
}

function safeFailureText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unprintable failure]';
  }
}
