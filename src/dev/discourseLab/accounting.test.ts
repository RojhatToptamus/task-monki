import { describe, expect, it } from 'vitest';
import {
  LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
  LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
  type LabParticipantCase,
  type LabPublicOutput
} from './contracts';
import { getLabProtocolPlan } from './protocols';
import { runLabProtocol } from './runner';
import {
  ScriptedLabTextDriver,
  type LabDriverPreflight,
  type LabTextCallInput,
  type LabTextCallResult,
  type LabTextDriver
} from './textDriver';

describe('Discourse Protocol Lab provider accounting', () => {
  it('does not infer thread attestation, turn start, or billability from ids and timestamps', async () => {
    const driver = new AccountingDriver({
      sessionAttestation: 'UNKNOWN',
      threadStartStatus: 'UNKNOWN',
      providerTurnStarted: 'UNKNOWN',
      billableModelCall: 'UNKNOWN'
    });
    const run = await runOneCall(driver);

    expect(run.callAccounting[0]).toMatchObject({
      threadStartRequested: true,
      threadStartStatus: 'UNKNOWN',
      sessionAttestation: 'UNKNOWN',
      providerThreadId: 'provider-thread-without-attestation',
      providerTurnId: 'provider-turn-without-start-evidence',
      providerTurnStarted: 'UNKNOWN',
      billableModelCall: 'UNKNOWN'
    });
    expect(run.realizedBudget).toMatchObject({
      providerThreadsAttested: 0,
      providerThreadStartsNotStarted: 0,
      threadStartUnknown: 1,
      providerTurnsStarted: 0,
      providerTurnsNotStarted: 0,
      providerTurnStartUnknown: 1,
      billableModelCalls: 0,
      nonBillableModelCalls: 0,
      billableModelCallsUnknown: 1
    });
  });

  it('counts explicit billing evidence independently from an explicit provider turn start', async () => {
    const unknownBilling = await runOneCall(new AccountingDriver({
      sessionAttestation: 'ATTESTED',
      threadStartStatus: 'ATTESTED',
      providerTurnStarted: 'YES',
      billableModelCall: 'UNKNOWN'
    }));
    const knownBilling = await runOneCall(new AccountingDriver({
      sessionAttestation: 'ATTESTED',
      threadStartStatus: 'ATTESTED',
      providerTurnStarted: 'YES',
      billableModelCall: 'YES'
    }));

    expect(unknownBilling.realizedBudget).toMatchObject({
      providerTurnsStarted: 1,
      billableModelCalls: 0,
      nonBillableModelCalls: 0,
      billableModelCallsUnknown: 1
    });
    expect(knownBilling.realizedBudget).toMatchObject({
      providerTurnsStarted: 1,
      billableModelCalls: 1,
      nonBillableModelCalls: 0,
      billableModelCallsUnknown: 0
    });
  });

  it('records scripted sessions as explicitly attested and explicitly non-billable', async () => {
    const run = await runOneCall(
      new ScriptedLabTextDriver(() => JSON.stringify(publicOutput()))
    );

    expect(run.callAccounting[0]).toMatchObject({
      threadStartStatus: 'ATTESTED',
      sessionAttestation: 'ATTESTED',
      providerTurnStarted: 'YES',
      billableModelCall: 'NO'
    });
    expect(run.realizedBudget).toMatchObject({
      providerThreadsAttested: 1,
      providerTurnsStarted: 1,
      billableModelCalls: 0,
      nonBillableModelCalls: 1,
      billableModelCallsUnknown: 0
    });
  });

  it('scopes repeated case/condition calls to the sealed assignment identity', async () => {
    const first = await runOneCall(
      new ScriptedLabTextDriver(() => JSON.stringify(publicOutput())),
      'bundle-a:variant-0'
    );
    const second = await runOneCall(
      new ScriptedLabTextDriver(() => JSON.stringify(publicOutput())),
      'bundle-b:variant-0'
    );

    expect(first.assignmentId).toBe('bundle-a:variant-0');
    expect(second.assignmentId).toBe('bundle-b:variant-0');
    expect(first.callAccounting[0]?.callKey).toContain('assignment:bundle-a:variant-0');
    expect(second.callAccounting[0]?.callKey).toContain('assignment:bundle-b:variant-0');
    expect(first.callAccounting[0]?.callKey).not.toBe(second.callAccounting[0]?.callKey);
  });

  it('retains natural completion beyond the concise-output target without censoring it', async () => {
    const run = await runOneCall(new RetrospectiveUsageDriver(1_050));

    expect(run.status).toBe('COMPLETED');
    expect(run.calls[0]?.failure).toBeUndefined();
    expect(run.calls[0]?.tokenControl).toMatchObject({
      targetOutputTokens: 900,
      safetyCeilingOutputTokens: 25_000,
      providerEnforcedLimit: false,
      observedOutputTokens: 1_050,
      targetOvershootTokens: 150,
      safetyOvershootTokens: 0,
      usageStatus: 'PROVIDER_REPORTED'
    });
    expect(run.realizedBudget.outputTokens).toBe(1_050);
    expect(run.callAccounting).toHaveLength(1);
    expect(run.artifacts[0]?.output.acceptedAttemptNumber).toBe(1);
  });

  it('stops before repair or another call when provider usage is unavailable', async () => {
    const run = await runOneCall(new RetrospectiveUsageDriver(null));

    expect(run.status).toBe('STOPPED');
    expect(run.stopReason).toBe('TOKEN_ACCOUNTING_UNAVAILABLE');
    expect(run.calls).toHaveLength(1);
    expect(run.callAccounting).toHaveLength(1);
    expect(run.calls[0]?.tokenControl).toMatchObject({
      providerEnforcedLimit: false,
      usageStatus: 'UNAVAILABLE',
      observedOutputTokens: null,
      targetOvershootTokens: null,
      safetyOvershootTokens: null
    });
    expect(run.realizedBudget.totalTokens).toBeNull();
  });
});

class RetrospectiveUsageDriver implements LabTextDriver {
  readonly id = 'retrospective-usage-test-v1';
  readonly capabilities = {
    textOnlyProviderEnforced: false,
    hardOutputTokenLimit: false,
    harnessVerifiedTextIsolation: true,
    streamingOutputTokenInterrupt: true,
    providerReportedTokenUsage: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;

  constructor(private readonly observedOutputTokens: number | null) {}

  preflight(): Promise<LabDriverPreflight> {
    throw new Error('Not used by this runner-level test.');
  }

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const now = new Date().toISOString();
    const usage = this.observedOutputTokens === null
      ? undefined
      : {
          totalTokens: this.observedOutputTokens + 100,
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: this.observedOutputTokens,
          reasoningOutputTokens: 50
        };
    return Promise.resolve({
      callKey: input.callKey,
      session: { driverId: this.id, providerThreadId: 'retrospective-thread' },
      providerTurnId: 'retrospective-turn',
      rawText: JSON.stringify(publicOutput()),
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      firstOutputAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: null,
      providerStatus: 'completed',
      ...(usage ? { usage: { total: usage, last: usage } } : {}),
      tokenControl: {
        targetOutputTokens: input.maximumOutputTokens,
        safetyCeilingOutputTokens: input.outputTokenSafetyCeiling!,
        providerEnforcedLimit: false,
        usageStatus: usage ? 'PROVIDER_REPORTED' : 'UNAVAILABLE',
        observedOutputTokens: this.observedOutputTokens,
        targetOvershootTokens: this.observedOutputTokens === null
          ? null
          : Math.max(0, this.observedOutputTokens - input.maximumOutputTokens),
        safetyOvershootTokens: this.observedOutputTokens === null
          ? null
          : Math.max(0, this.observedOutputTokens - input.outputTokenSafetyCeiling!)
      },
      providerAccounting: {
        sessionAttestation: 'ATTESTED',
        threadStartStatus: 'ATTESTED',
        providerTurnStarted: 'YES',
        billableModelCall: 'UNKNOWN'
      },
      violations: [],
      lifecycle: [{ event: 'completed', at: now }]
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class AccountingDriver implements LabTextDriver {
  readonly id = 'explicit-accounting-test-v1';
  readonly capabilities = {
    textOnlyProviderEnforced: true,
    hardOutputTokenLimit: true,
    hardCallTimeLimit: true,
    continuation: true,
    samplingSeed: false
  } as const;

  constructor(
    private readonly evidence: LabTextCallResult['providerAccounting']
  ) {}

  preflight(): Promise<LabDriverPreflight> {
    throw new Error('Not used by this runner-level test.');
  }

  call(input: LabTextCallInput): Promise<LabTextCallResult> {
    const now = new Date().toISOString();
    return Promise.resolve({
      callKey: input.callKey,
      session: {
        driverId: this.id,
        providerThreadId: 'provider-thread-without-attestation'
      },
      providerTurnId: 'provider-turn-without-start-evidence',
      rawText: JSON.stringify(publicOutput()),
      submittedAt: now,
      acknowledgedAt: now,
      startedAt: now,
      firstOutputAt: now,
      completedAt: now,
      requestedModel: input.model,
      observedModel: input.model,
      requestedServiceTier: input.serviceTier ?? null,
      observedServiceTier: input.serviceTier ?? null,
      seed: null,
      providerStatus: 'completed',
      providerAccounting: { ...this.evidence },
      violations: [],
      lifecycle: [
        { event: 'submitted', at: now },
        { event: 'completed', at: now }
      ]
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function runOneCall(driver: LabTextDriver, assignmentId?: string) {
  const plan = getLabProtocolPlan('CONTROL_NO_FEEDBACK_B1');
  const run = await runLabProtocol({
    participantCase: participantCase(),
    plan,
    driver,
    assignmentId,
    intervention: {
      bundleId: 'accounting-bundle',
      variantId: 'accounting-variant',
      fixedInitial: {
        artifactId: 'private-initial-id',
        answer: 'The proposition is supported.',
        status: 'ANSWER',
        assessments: [{ claimId: 'p1', stance: 'ACCEPT' }]
      },
      signalKind: 'NONE',
      artifacts: []
    },
    modelConfiguration: { model: 'accounting-test' },
    limits: {
      maximumCalls: 1,
      maximumRounds: 1,
      maximumInputTokensPerCall: 4_000,
      outputTokenSafetyCeilingPerCall: 25_000,
      maximumObservedTotalTokens: 10_000,
      maximumCallMs: 1_000,
      maximumExperimentMs: 10_000,
      maximumConcurrency: 1
    }
  });
  await driver.close();
  return run;
}

function participantCase(): LabParticipantCase {
  return {
    schemaVersion: LAB_PARTICIPANT_CASE_SCHEMA_VERSION,
    caseId: 'accounting-case',
    question: 'Assess the proposition.',
    evidence: [{ id: 'PROMPT', text: 'Facts stated in the question.' }],
    propositions: [{ id: 'p1', topicId: 'case', text: 'The proposition is supported.' }],
    options: [],
    topics: [{ id: 'case', label: 'case' }]
  };
}

function publicOutput(): LabPublicOutput {
  return {
    schemaVersion: LAB_PUBLIC_OUTPUT_SCHEMA_VERSION,
    status: 'ANSWER',
    answer: { summary: 'The proposition is supported.', values: [], selectedOptionIds: [] },
    claims: [{
      id: 'claim-1',
      propositionId: 'p1',
      topicId: 'case',
      stance: 'ACCEPT',
      statement: 'The proposition is supported.',
      evidence: [{ evidenceId: 'PROMPT', relation: 'SUPPORTS', note: 'The public question.' }],
      assumptionIds: [],
      confidence: 0.8
    }],
    assumptions: [],
    issues: [],
    responses: [],
    disagreements: [],
    resolution: {
      status: 'NO_DISAGREEMENT',
      basis: 'NO_MATERIAL_ISSUE',
      summary: 'No material issue.',
      resolvedIssueIds: [],
      unresolvedIssueIds: []
    },
    userQuestions: [],
    confidence: 0.8
  };
}
