import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { H1C_CORPUS_VERSION, loadH1cParticipantCorpus } from './h1cCorpus';
import {
  assertFreshH1cParticipantQuestions,
  buildH1cHarnessValidationManifest,
  type H1cH0ContractFixtureResult,
  loadH1cH0ValidationReceipt,
  runH1cHarnessValidation
} from './h1cHarnessValidation';
import { H1C_PROMPT_VERSION } from './h1cPrompts';
import { H1C_SCORING_VERSION } from './h1cScoring';
import { H1B_SOURCE_LOCK_VERSION } from './h1bSourceLock';
import {
  H1C_PREREGISTRATION_VERSION,
  H1C_PROTOCOL_VERSION,
  H1C_SEAL_VERSION,
  type H1cValidationReport
} from './h1cValidation';
import { LabArtifactLedger, type LabComponentLock } from './ledger';
import { LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION } from './outputV4';

const fixtureRoot = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('H1c H0 local harness validation', () => {
  it('deterministically validates all 28 templates without provider behavior', async () => {
    const validation = validationFixture();
    const first = await runH1cHarnessValidation({ fixtureRoot, validation });
    const second = await runH1cHarnessValidation({ fixtureRoot, validation });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'PASSED',
      hypothesisId: 'H0-H1C',
      materializedCallCount: 28,
      blockCount: 8,
      providerCallCount: 0,
      topology: { freshCalls: 20, continuationCalls: 8 }
    });
    expect(first.checks).toHaveLength(20);
    expect(first.checks.every((check) => check.status === 'PASSED')).toBe(true);
    expect(first.prompts).toHaveLength(28);
    expect(new Set(first.prompts.map((item) => item.assignmentId)).size).toBe(28);
    expect(first.maximumEstimatedPromptTokens).toBeGreaterThan(0);
    expect(first.maximumEstimatedPromptTokens).toBeLessThanOrEqual(7_000);
    expect(first.promptTemplateSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.scheduleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.contractFixtures).toHaveLength(43);
    expect(
      first.contractFixtures.every(
        (fixture) =>
          fixture.status === 'PASSED' &&
          JSON.stringify(fixture.expected) === JSON.stringify(fixture.observed)
      )
    ).toBe(true);

    const continuations = first.prompts.filter(
      (item) => item.threadMode === 'CONTINUE_INITIAL'
    );
    expect(continuations).toHaveLength(8);
    expect(continuations.every((item) => item.conditionId === 'ACTIVE_SELF_REVIEW')).toBe(true);
    expect(
      continuations.every(
        (item) => item.continuationFromAssignmentId === `${item.blockId}:STRONG_INITIAL`
      )
    ).toBe(true);
    expect(first.prompts.filter((item) => item.conditionId === 'STRONG_INITIAL'))
      .toHaveLength(8);
    expect(first.prompts.filter((item) => item.conditionId !== 'STRONG_INITIAL'))
      .toHaveLength(20);
    expect(first.prompts.filter((item) => item.conditionId !== 'STRONG_INITIAL').every(
      (item) => item.visibleDraftIssueIds.length > 0
    )).toBe(true);
  });

  it('separates structural/provenance rejection from parseable scorer failures in every stage', async () => {
    const report = await runH1cHarnessValidation({
      fixtureRoot,
      validation: validationFixture()
    });
    const fixtures = new Map(
      report.contractFixtures.map((fixture) => [fixture.fixtureId, fixture])
    );
    const stages = new Set(report.contractFixtures.map((fixture) => fixture.interactionStage));

    expect(stages).toEqual(new Set([
      'INITIAL',
      'SELF_REVIEW',
      'CRITIQUE_RESPONSE',
      'EVIDENCE_RESPONSE'
    ]));
    expectFixture(fixtures, 'INITIAL_PROMPT_AS_ISSUE_TARGET_REJECTED', false, null);
    expectFixture(fixtures, 'INITIAL_LEGACY_ANSWER_VALUES_REJECTED', false, null);
    expectFixture(fixtures, 'CRITIQUE_SELF_FOUND_RESPONSE_REJECTED', false, null);
    expectFixture(fixtures, 'CRITIQUE_MISSING_RESPONDS_TO_REJECTED', false, null);
    expectFixture(fixtures, 'CRITIQUE_MISMATCHED_RESPONDS_TO_REJECTED', false, null);
    expectFixture(fixtures, 'CRITIQUE_AS_FACTUAL_SOURCE_REJECTED', false, null);
    expectFixture(
      fixtures,
      'EVIDENCE_ARTIFACT_REFERENCE_NOT_FACTUAL_SUPPORT',
      true,
      false
    );
    expectFixture(fixtures, 'ABSTENTION_MISSING_OBJECT_REJECTED', false, null);

    expectFixture(
      fixtures,
      'INITIAL_DIRECTIONAL_EVIDENCE_OMISSION_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'SELF_REVIEW_DECLARATION_MISMATCH_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'CRITIQUE_OMITTED_ACCOUNTING_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'CRITIQUE_VISIBLE_ISSUE_DISAPPEARS_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'EVIDENCE_ALLOWED_WITHOUT_REQUIRED_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'EVIDENCE_DISALLOWED_REFERENCE_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'REQUEST_MISSING_REQUIRED_TARGET_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(
      fixtures,
      'REQUEST_DISALLOWED_EXTRA_TARGET_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(fixtures, 'REQUEST_WRONG_OWNER_SCORE_FAILURE', true, false);
  });

  it('classifies model and harness failures from typed rules, never lexical wording', async () => {
    const report = await runH1cHarnessValidation({
      fixtureRoot,
      validation: validationFixture()
    });
    const fixtures = new Map(report.contractFixtures.map((item) => [item.fixtureId, item]));

    expectValidationFailure(
      fixtures,
      'SELF_REVIEW_UNKNOWN_ISSUE_OUTPUT_INVALID',
      'v4.resolution.issue-reference',
      'ISSUE_LIFECYCLE',
      'OUTPUT_INVALID'
    );
    expectValidationFailure(
      fixtures,
      'SELF_REVIEW_LEXICAL_PROVENANCE_WORDS_DO_NOT_CLASSIFY',
      'v4.resolution.issue-reference',
      'ISSUE_LIFECYCLE',
      'OUTPUT_INVALID'
    );
    expectValidationFailure(
      fixtures,
      'SELF_REVIEW_CONTEXT_FAULT_MEASUREMENT_UNAVAILABLE',
      'v4.context.position-case-propositions',
      'CONTEXT_INTEGRITY',
      'MEASUREMENT_UNAVAILABLE'
    );
  });

  it('preserves typed DRAFT issue identity and accounts it in every response stage', async () => {
    const report = await runH1cHarnessValidation({
      fixtureRoot,
      validation: validationFixture()
    });
    const fixtures = new Map(report.contractFixtures.map((item) => [item.fixtureId, item]));
    const responseStages = report.prompts.filter((item) => item.conditionId !== 'STRONG_INITIAL');

    expect(new Set(responseStages.map((item) => item.conditionId))).toEqual(new Set([
      'ACTIVE_SELF_REVIEW',
      'VALID_CRITIQUE',
      'PLACEBO_CRITIQUE',
      'DECISIVE_EVIDENCE'
    ]));
    expect(responseStages.every((item) => item.visibleDraftIssueIds.length === 1)).toBe(true);
    expectFixture(fixtures, 'SELF_REVIEW_DRAFT_ISSUE_RETAINED_STABLE_IDENTITY', true, true);
    expectFixture(
      fixtures,
      'SELF_REVIEW_DRAFT_ISSUE_RESOLVED_WITHOUT_REEMISSION',
      true,
      true
    );
    expectValidationFailure(
      fixtures,
      'SELF_REVIEW_DRAFT_ISSUE_IDENTITY_MUTATION_REJECTED',
      'v4.issue.draft-identity-retention',
      'ISSUE_LIFECYCLE',
      'OUTPUT_INVALID'
    );
  });

  it('covers repaired semantics with adversarial positive pairs', async () => {
    const report = await runH1cHarnessValidation({
      fixtureRoot,
      validation: validationFixture()
    });
    const fixtures = new Map(
      report.contractFixtures.map((fixture) => [fixture.fixtureId, fixture])
    );

    expectFixture(fixtures, 'INITIAL_CASE_TARGET_PROMPT_SOURCE_ACCEPTED', true, true);
    expectFixture(fixtures, 'INITIAL_SELECTED_OPTIONS_AUTHORITATIVE', true, true);
    expectFixture(fixtures, 'SELF_REVIEW_NO_CHANGE_ACCEPTED', true, true);
    expectFixture(fixtures, 'SELF_REVIEW_DECLARED_CORRECTION_ACCEPTED', true, true);
    expectFixture(fixtures, 'CRITIQUE_EXTERNAL_RESPONSE_ACCEPTED', true, true);
    expectFixture(
      fixtures,
      'CRITIQUE_REJECTION_NO_DISAGREEMENT_ACCEPTED',
      true,
      true
    );
    expectFixture(fixtures, 'CRITIQUE_REJECTION_RESOLVED_ACCEPTED', true, true);
    expectFixture(fixtures, 'CRITIQUE_REJECTION_FACTUAL_EVIDENCE_ACCEPTED', true, true);
    expectFixture(fixtures, 'CRITIQUE_ACCEPT_NO_MATERIAL_ISSUE_SCORE_FAILURE', true, false);
    expectFixture(fixtures, 'CRITIQUE_PARTIAL_NO_MATERIAL_ISSUE_SCORE_FAILURE', true, false);
    expectFixture(fixtures, 'RESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_ACCEPTED', true, true);
    expectFixture(
      fixtures,
      'UNRESOLVED_DISAGREEMENT_GLOBAL_RESOLVED_SCORE_FAILURE',
      true,
      false
    );
    expectFixture(fixtures, 'EVIDENCE_REQUIRED_PLUS_ALLOWED_ACCEPTED', true, true);
    expectFixture(fixtures, 'EVIDENCE_NULL_ALLOWANCE_UNADJUDICATED_ACCEPTED', true, true);
    expectFixture(fixtures, 'REQUEST_BLOCKING_USER_ACCEPTED', true, true);
    expectFixture(fixtures, 'REQUEST_BLOCKING_DOCUMENT_ACCEPTED', true, true);
    expectFixture(fixtures, 'REQUEST_REQUIRED_SUBSET_ALLOWED_SUPERSET_ACCEPTED', true, true);
    expectFixture(fixtures, 'REQUEST_ESCALATION_INDEPENDENT_OF_TARGETING', true, true);
    expectFixture(fixtures, 'ABSTENTION_EXPLICIT_ACCEPTED', true, true);
    expectFixture(fixtures, 'EXPLICIT_COHORT_DENOMINATOR_ACCOUNTING', true, true);
  });

  it('writes and strictly reloads the content-addressed zero-call H0 receipt', async () => {
    const validation = validationFixture();
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-h0-'));
    temporaryRoots.push(stateRoot);
    const runId = 'h1c-h0-valid';
    const ledger = new LabArtifactLedger(stateRoot, runId);
    await ledger.initialize(
      buildH1cHarnessValidationManifest(
        runId,
        validation.locks,
        '2026-08-02T00:00:00.000Z'
      )
    );

    const report = await runH1cHarnessValidation({ fixtureRoot, validation, ledger });
    const receipt = await loadH1cH0ValidationReceipt(stateRoot, runId, validation.locks);

    expect(receipt.report).toEqual(report);
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await fs.readdir(path.join(ledger.runDirectory, 'events'))).toEqual([
      '000001-h1c_h0_started.json',
      '000002-h1c_h0_passed.json'
    ]);
    expect(await fs.readdir(path.join(ledger.runDirectory, 'artifacts'))).toEqual([
      `${report.promptTemplateSetSha256}.json`
    ]);

    await expect(
      loadH1cH0ValidationReceipt(stateRoot, '../h1c-h0-valid', validation.locks)
    ).rejects.toThrow('unsafe run id');
    await fs.unlink(
      path.join(
        ledger.runDirectory,
        'artifacts',
        `${report.promptTemplateSetSha256}.json`
      )
    );
    await expect(
      loadH1cH0ValidationReceipt(stateRoot, runId, validation.locks)
    ).rejects.toThrow('promptTemplateSetArtifact');
  });

  it('rejects provider-runtime residue, event tampering, and stale active locks', async () => {
    const validation = validationFixture();
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-h0-archive-'));
    temporaryRoots.push(stateRoot);
    const runId = 'h1c-h0-archive-adversarial';
    const ledger = new LabArtifactLedger(stateRoot, runId);
    await ledger.initialize(buildH1cHarnessValidationManifest(runId, validation.locks));
    await runH1cHarnessValidation({ fixtureRoot, validation, ledger });

    const providerDirectory = path.join(ledger.runDirectory, 'provider-runtime');
    await fs.mkdir(providerDirectory);
    await expect(
      loadH1cH0ValidationReceipt(stateRoot, runId, validation.locks)
    ).rejects.toThrow('provider runtime');
    await fs.rmdir(providerDirectory);

    const staleLocks = structuredClone(validation.locks);
    staleLocks.scoringVersion = 'stale-scoring';
    await expect(
      loadH1cH0ValidationReceipt(stateRoot, runId, staleLocks)
    ).rejects.toThrow('manifestLocks');

    const passedEventPath = path.join(
      ledger.runDirectory,
      'events',
      '000002-h1c_h0_passed.json'
    );
    const event = JSON.parse(await fs.readFile(passedEventPath, 'utf8')) as {
      detail: { assignments: number };
    };
    event.detail.assignments = 27;
    await fs.writeFile(passedEventPath, `${JSON.stringify(event)}\n`, 'utf8');
    await expect(
      loadH1cH0ValidationReceipt(stateRoot, runId, validation.locks)
    ).rejects.toThrow('events');
  });

  it('rejects stale component locks before materializing any prompt', async () => {
    const validation = validationFixture();
    validation.locks.outputSchemaVersion = 'stale-output-contract';

    await expect(
      runH1cHarnessValidation({ fixtureRoot, validation })
    ).rejects.toThrow('outputSchemaVersion');
  });

  it('rejects a source lock that omits an executed Codex boundary file', async () => {
    const validation = validationFixture();
    validation.sourceLock.sourceFiles = validation.sourceLock.sourceFiles.filter(
      (file) => file !== 'src/core/agent/codex/CodexAppServerSupervisor.ts'
    );

    await expect(
      runH1cHarnessValidation({ fixtureRoot, validation })
    ).rejects.toThrow('transitiveBoundarySourceLock');
  });

  it('rejects a participant-visible placebo/truth label instead of merely reporting success', async () => {
    const copiedFixtureRoot = await copyH1cFixture();
    const participantPath = path.join(
      copiedFixtureRoot,
      'corpus',
      'h1c-v3',
      'participants',
      'development.json'
    );
    const participant = JSON.parse(await fs.readFile(participantPath, 'utf8')) as {
      records: Array<{ placeboCritique?: { statement: string } }>;
    };
    participant.records[0]!.placeboCritique!.statement =
      `PLACEBO treatment label. ${participant.records[0]!.placeboCritique!.statement}`;
    await fs.writeFile(participantPath, `${JSON.stringify(participant, null, 2)}\n`, 'utf8');

    await expect(
      runH1cHarnessValidation({
        fixtureRoot: copiedFixtureRoot,
        validation: validationFixture()
      })
    ).rejects.toThrow('non-neutral label PLACEBO');
  });

  it('rejects an exposed development question even when the case id is new', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const exposed = JSON.parse(await fs.readFile(
      path.join(
        fixtureRoot,
        'corpus',
        'h1c-v1',
        'participants',
        'development.json'
      ),
      'utf8'
    )) as { records: Array<{ participantCase: { question: string } }> };
    participants.records[0]!.participantCase.question =
      exposed.records[0]!.participantCase.question;

    expect(() => assertFreshH1cParticipantQuestions(participants.records)).toThrow(
      'fresh-case gate rejected an exposed question'
    );
  });

  it('rejects every frozen H1c-v2 development question', async () => {
    const participants = await loadH1cParticipantCorpus(fixtureRoot);
    const frozen = JSON.parse(await fs.readFile(
      path.join(
        fixtureRoot,
        'corpus',
        'h1c-v2',
        'participants',
        'development.json'
      ),
      'utf8'
    )) as { records: Array<{ participantCase: { question: string } }> };

    for (const [index, record] of frozen.records.entries()) {
      const candidate = structuredClone(participants.records);
      candidate[0]!.participantCase.question = record.participantCase.question;
      expect(
        () => assertFreshH1cParticipantQuestions(candidate),
        `frozen v2 question ${index + 1}`
      ).toThrow('fresh-case gate rejected an exposed question');
    }
  });
});

function validationFixture(): H1cValidationReport {
  const locks: LabComponentLock = {
    corpusVersion: H1C_CORPUS_VERSION,
    participantCorpusSha256: 'a'.repeat(64),
    oracleCorpusSha256: 'b'.repeat(64),
    labSourceSha256: 'c'.repeat(64),
    preregistrationVersion: H1C_PREREGISTRATION_VERSION,
    preregistrationSha256: 'd'.repeat(64),
    promptVersion: H1C_PROMPT_VERSION,
    outputSchemaVersion: LAB_PUBLIC_OUTPUT_V4_SCHEMA_VERSION,
    scoringVersion: H1C_SCORING_VERSION,
    protocolVersion: H1C_PROTOCOL_VERSION
  };
  return {
    valid: true,
    sealVersion: H1C_SEAL_VERSION,
    preregistrationVersion: H1C_PREREGISTRATION_VERSION,
    verifiedFiles: [
      {
        path: 'evaluation/discourse-lab/corpus/h1c-v3/participants/development.json',
        audience: 'PARTICIPANT',
        sha256: locks.participantCorpusSha256
      },
      {
        path: 'evaluation/discourse-lab/corpus/h1c-v3/scorer-only/development-oracles.json',
        audience: 'SCORER_ONLY',
        sha256: locks.oracleCorpusSha256
      },
      {
        path: 'evaluation/discourse-lab/preregistration/h1c-v3.json',
        audience: 'HARNESS',
        sha256: locks.preregistrationSha256
      }
    ],
    sourceLock: {
      version: H1B_SOURCE_LOCK_VERSION,
      entryFiles: ['src/dev/discourseLab/h1cCli.ts'],
      sourceFiles: [
        'src/core/agent/codex/CodexAppServerSupervisor.ts',
        'src/core/agent/codex/CodexPermissionProfile.ts',
        'src/core/agent/codex/CodexRpcClient.ts',
        'src/core/discourse/DiscourseWorkspace.ts',
        'src/dev/discourseLab/CodexTextDriver.ts',
        'src/dev/discourseLab/h1cHarnessValidation.ts',
        'src/dev/discourseLab/h1cPrompts.ts',
        'src/dev/discourseLab/outputV3.ts',
        'src/dev/discourseLab/outputV4.ts'
      ],
      sha256: locks.labSourceSha256
    },
    locks
  };
}

async function copyH1cFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-fixture-'));
  temporaryRoots.push(root);
  const participantDirectory = path.join(root, 'corpus', 'h1c-v3', 'participants');
  const oracleDirectory = path.join(root, 'corpus', 'h1c-v3', 'scorer-only');
  await Promise.all([
    fs.mkdir(participantDirectory, { recursive: true }),
    fs.mkdir(oracleDirectory, { recursive: true })
  ]);
  await Promise.all([
    fs.copyFile(
      path.join(fixtureRoot, 'corpus', 'h1c-v3', 'participants', 'development.json'),
      path.join(participantDirectory, 'development.json')
    ),
    fs.copyFile(
      path.join(fixtureRoot, 'corpus', 'h1c-v3', 'scorer-only', 'development-oracles.json'),
      path.join(oracleDirectory, 'development-oracles.json')
    )
  ]);
  return root;
}

function expectFixture(
  fixtures: ReadonlyMap<string, H1cH0ContractFixtureResult>,
  fixtureId: string,
  contractAccepted: boolean,
  semanticCheckPassed: boolean | null
): void {
  const fixture = fixtures.get(fixtureId);
  expect(fixture, `missing fixture ${fixtureId}`).toBeDefined();
  expect(fixture?.expected.contractAccepted).toBe(contractAccepted);
  expect(fixture?.observed.contractAccepted).toBe(contractAccepted);
  expect(fixture?.expected.semanticCheckPassed).toBe(semanticCheckPassed);
  expect(fixture?.observed.semanticCheckPassed).toBe(semanticCheckPassed);
}

function expectValidationFailure(
  fixtures: ReadonlyMap<string, H1cH0ContractFixtureResult>,
  fixtureId: string,
  ruleId: string,
  domain: NonNullable<
    H1cH0ContractFixtureResult['observed']['validationFailure']
  >['domain'],
  measurementEffect: NonNullable<
    H1cH0ContractFixtureResult['observed']['validationFailure']
  >['measurementEffect']
): void {
  const fixture = fixtures.get(fixtureId);
  expect(fixture, `missing fixture ${fixtureId}`).toBeDefined();
  expect(fixture?.observed.contractAccepted).toBe(false);
  expect(fixture?.observed.validationFailure).toEqual({
    ruleId,
    domain,
    measurementEffect
  });
  expect(fixture?.expected.validationFailure).toEqual(fixture?.observed.validationFailure);
}
