import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from './ledger';
import { validateH1cInputs } from './h1cValidation';

const SOURCE_FIXTURE_ROOT = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const INPUTS = [
  {
    relative: 'evaluation/discourse-lab/corpus/h1c-v3/participants/development.json',
    audience: 'PARTICIPANT'
  },
  {
    relative: 'evaluation/discourse-lab/corpus/h1c-v3/scorer-only/development-oracles.json',
    audience: 'SCORER_ONLY'
  },
  {
    relative: 'evaluation/discourse-lab/preregistration/h1c-v3.json',
    audience: 'HARNESS'
  }
] as const;

type MutablePreregistration = Record<string, unknown>;
type Mutation = readonly [path: string, replacement: unknown];

interface MutableSeal {
  confirmationStatus: string;
  files: Array<{
    path: string;
    audience: 'PARTICIPANT' | 'SCORER_ONLY' | 'HARNESS';
    sha256: string;
  }>;
}

const confirmationMutations = [
  ['scope.confirmationOpened', true],
  ['confirmationLock.h1cConfirmationCorpusExists', true],
  ['confirmationLock.status', 'OPENED']
] as const satisfies readonly Mutation[];

const scopeMutations = [
  ['scope.allowedContext', 'REPOSITORY'],
  ['scope.toolsBrowsingRepositoriesTasksCode', 'ALLOWED'],
  ['scope.participantTruthAccess', true],
  ['scope.hiddenChainOfThoughtRequestedOrStored', true],
  ['scope.productBehaviorMayChange', true],
  ['scope.newHeldOutDevelopmentCases', 5],
  ['scope.repetitionsPerCase', 3],
  ['scope.liveInitialSharedWithinBlock', false],
  ['scope.activeSelfReviewUsesSameThread', false],
  ['scope.reviewAndEvidenceResponsesUseFreshThreads', false],
  ['scope.critiqueAddsNewFacts', true],
  ['scope.evidenceAddsGenuinelyNewFacts', false],
  ['scope.schemaRepairs', 1],
  ['scope.signalGenerationCostIncluded', true],
  ['scope.minorityPreservationEstimable', true],
  ['scope.archivedH1cV1OrV2CausallyRescored', true],
  ['scope.answerSummarySemanticsAdjudicated', true],
  ['scope.thisTurnProviderCallsAllowed', true],
  ['scope.futureExecutionAuthorized', true],
  ['scope.futureExecutionRequiresFreshExactModelProbe', false],
  ['scope.futureExecutionRequiresExplicitAuthorization', false]
] as const satisfies readonly Mutation[];

const budgetMutations = [
  ['budget.maximumPrimaryCalls', 29],
  ['budget.maximumCalls', 29],
  ['budget.maximumPreparedPromptEstimateTokensPerCall', 7001],
  ['budget.targetOutputTokensPerCall', 901],
  ['budget.targetIsCensoringLimit', true],
  ['budget.emergencyOutputTokenSafetyCeilingPerCall', 25001],
  ['budget.maximumObservedTotalTokens', 300001],
  ['budget.maximumCallMs', 120001],
  ['budget.maximumExperimentMs', 2400001]
] as const satisfies readonly Mutation[];

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('H1c sealed development inputs', () => {
  it('accepts the exact preregistration after a real three-file development-only seal', async () => {
    const fixture = await createSealedFixture();

    const result = await validateH1cInputs(fixture.fixtureRoot);

    expect(result).toMatchObject({
      valid: true,
      sealVersion: 'h1c-seal-v3',
      preregistrationVersion: 'h1c-preregistration-v3'
    });
    expect(result.verifiedFiles).toHaveLength(3);
    expect(result.verifiedFiles.map((entry) => entry.audience).sort()).toEqual([
      'HARNESS',
      'PARTICIPANT',
      'SCORER_ONLY'
    ]);
    expect(result.locks).toMatchObject({
      corpusVersion: 'h1c-assay-corpus@v3',
      preregistrationVersion: 'h1c-preregistration-v3',
      scoringVersion: 'h1c-assay-metrics@v3'
    });
    expect(result.sourceLock.entryFiles).toEqual(['src/dev/discourseLab/h1cCli.ts']);
    expect(result.sourceLock.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(INPUTS.map((input) => [input.relative] as const))(
    'fails closed when sealed input %s changes after sealing',
    async (relative) => {
      const fixture = await createSealedFixture();
      await fs.appendFile(path.join(fixture.projectRoot, relative), '\n');

      await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
        'Sealed H1c input changed'
      );
    }
  );

  it('rejects participant and scorer audience swaps without relying on content hashes', async () => {
    const fixture = await createSealedFixture();
    const sealPath = path.join(fixture.fixtureRoot, 'seal-h1c-v3.json');
    const seal = JSON.parse(await fs.readFile(sealPath, 'utf8')) as MutableSeal;
    const participant = seal.files.find((entry) => entry.audience === 'PARTICIPANT');
    const scorer = seal.files.find((entry) => entry.audience === 'SCORER_ONLY');
    expect(participant).toBeDefined();
    expect(scorer).toBeDefined();
    participant!.audience = 'SCORER_ONLY';
    scorer!.audience = 'PARTICIPANT';
    await fs.writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

    await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
      'H1c seal does not exactly map participant, scorer, and preregistration inputs to their audiences'
    );
  });

  it.each(confirmationMutations)(
    'rejects confirmation opening through %s even after re-sealing',
    async (mutationPath, replacement) => {
      const fixture = await createSealedFixture();
      await mutatePreregistration(fixture.projectRoot, (value) => {
        replaceNestedValue(value, mutationPath, replacement);
      });
      await writeSeal(fixture.projectRoot, fixture.fixtureRoot);

      await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
        'H1c preregistration contract is invalid'
      );
    }
  );

  it.each(scopeMutations)(
    'rejects a changed %s scope decision even after re-sealing',
    async (mutationPath, replacement) => {
      const fixture = await createSealedFixture();
      await mutatePreregistration(fixture.projectRoot, (value) => {
        replaceNestedValue(value, mutationPath, replacement);
      });
      await writeSeal(fixture.projectRoot, fixture.fixtureRoot);

      await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
        'H1c preregistration contract is invalid'
      );
    }
  );

  it.each(budgetMutations)(
    'rejects a changed %s budget decision even after re-sealing',
    async (mutationPath, replacement) => {
      const fixture = await createSealedFixture();
      await mutatePreregistration(fixture.projectRoot, (value) => {
        replaceNestedValue(value, mutationPath, replacement);
      });
      await writeSeal(fixture.projectRoot, fixture.fixtureRoot);

      await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
        'H1c preregistration contract is invalid'
      );
    }
  );

  it('rejects a seal that claims confirmation is available', async () => {
    const fixture = await createSealedFixture();
    const sealPath = path.join(fixture.fixtureRoot, 'seal-h1c-v3.json');
    const seal = JSON.parse(await fs.readFile(sealPath, 'utf8')) as MutableSeal;
    seal.confirmationStatus = 'AVAILABLE';
    await fs.writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

    await expect(validateH1cInputs(fixture.fixtureRoot)).rejects.toThrow(
      'H1c seal header or development-only boundary is invalid'
    );
  });
});

async function createSealedFixture(): Promise<{
  projectRoot: string;
  fixtureRoot: string;
}> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1c-seal-'));
  temporaryRoots.push(projectRoot);
  const fixtureRoot = path.join(projectRoot, 'evaluation', 'discourse-lab');
  for (const input of INPUTS) {
    const destination = path.join(projectRoot, input.relative);
    const source = path.join(
      SOURCE_FIXTURE_ROOT,
      path.relative('evaluation/discourse-lab', input.relative)
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  const sourceEntry = path.join(projectRoot, 'src', 'dev', 'discourseLab', 'h1cCli.ts');
  await fs.mkdir(path.dirname(sourceEntry), { recursive: true });
  await fs.writeFile(sourceEntry, 'export {};\n');
  await writeSeal(projectRoot, fixtureRoot);
  return { projectRoot, fixtureRoot };
}

async function mutatePreregistration(
  projectRoot: string,
  mutate: (value: MutablePreregistration) => void
): Promise<void> {
  const preregistrationPath = path.join(
    projectRoot,
    'evaluation/discourse-lab/preregistration/h1c-v3.json'
  );
  const value = JSON.parse(
    await fs.readFile(preregistrationPath, 'utf8')
  ) as MutablePreregistration;
  mutate(value);
  await fs.writeFile(preregistrationPath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceNestedValue(
  value: MutablePreregistration,
  dottedPath: string,
  replacement: unknown
): void {
  const segments = dottedPath.split('.');
  const leaf = segments.pop();
  if (!leaf) throw new Error(`Invalid mutation path: ${dottedPath}.`);
  let parent = value;
  for (const segment of segments) {
    const child = parent[segment];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(`Invalid mutation path: ${dottedPath}.`);
    }
    parent = child as Record<string, unknown>;
  }
  parent[leaf] = replacement;
}

async function writeSeal(projectRoot: string, fixtureRoot: string): Promise<void> {
  const files = await Promise.all(
    INPUTS.map(async (input) => ({
      path: input.relative,
      audience: input.audience,
      sha256: await sha256File(path.join(projectRoot, input.relative))
    }))
  );
  const seal = {
    schemaVersion: 'discourse-lab-h1c-seal@3',
    sealVersion: 'h1c-seal-v3',
    corpusVersion: 'h1c-assay-corpus@v3',
    preregistrationVersion: 'h1c-preregistration-v3',
    digestAlgorithm: 'SHA-256',
    partition: 'DEVELOPMENT_ONLY',
    confirmationStatus: 'ABSENT_CLOSED',
    files
  };
  await fs.writeFile(
    path.join(fixtureRoot, 'seal-h1c-v3.json'),
    `${JSON.stringify(seal, null, 2)}\n`
  );
}
