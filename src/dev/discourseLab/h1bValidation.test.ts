import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from './ledger';
import { validateH1bInputs } from './h1bValidation';

const SOURCE_FIXTURE_ROOT = path.join(process.cwd(), 'evaluation', 'discourse-lab');
const INPUTS = [
  {
    relative: 'evaluation/discourse-lab/corpus/h1b-v1/participants/development.json',
    audience: 'PARTICIPANT'
  },
  {
    relative: 'evaluation/discourse-lab/corpus/h1b-v1/scorer-only/development-oracles.json',
    audience: 'SCORER_ONLY'
  },
  {
    relative: 'evaluation/discourse-lab/preregistration/h1b-v1.json',
    audience: 'HARNESS'
  }
] as const;

interface MutablePreregistration {
  experiment: {
    primaryCalls: number;
    blocks: number;
    repetitionsPerCell: number;
  };
  scope: {
    confirmationOpened: boolean;
  };
  budget: {
    maximumPrimaryCalls: number;
    maximumCalls: number;
    maximumObservedTotalTokens: number;
  };
  confirmationLock: {
    status: string;
    h1bConfirmationCorpusExists: boolean;
  };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('H1b sealed development inputs', () => {
  it('accepts the exact preregistration after a real three-file seal is created', async () => {
    const fixture = await createSealedFixture();

    const result = await validateH1bInputs(fixture.fixtureRoot);

    expect(result).toMatchObject({
      valid: true,
      sealVersion: 'h1b-seal-v1',
      preregistrationVersion: 'h1b-preregistration-v1'
    });
    expect(result.verifiedFiles).toHaveLength(3);
    expect(result.verifiedFiles.map((entry) => entry.audience).sort()).toEqual([
      'HARNESS',
      'PARTICIPANT',
      'SCORER_ONLY'
    ]);
    expect(result.locks).toMatchObject({
      corpusVersion: 'h1b-text-corpus-v1',
      preregistrationVersion: 'h1b-preregistration-v1',
      scoringVersion: 'h1b-contextual-metrics@v1'
    });
    expect(result.sourceLock.entryFiles).toEqual(['src/dev/discourseLab/h1bCli.ts']);
    expect(result.sourceLock.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when any sealed input changes after sealing', async () => {
    const fixture = await createSealedFixture();
    const participantPath = path.join(
      fixture.projectRoot,
      'evaluation/discourse-lab/corpus/h1b-v1/participants/development.json'
    );
    await fs.appendFile(participantPath, '\n');

    await expect(validateH1bInputs(fixture.fixtureRoot)).rejects.toThrow(
      'Sealed H1b input changed'
    );
  });

  it('rejects confirmation opening even when the modified preregistration is re-sealed', async () => {
    for (const mutate of [
      (value: MutablePreregistration) => {
        value.scope.confirmationOpened = true;
      },
      (value: MutablePreregistration) => {
        value.confirmationLock.h1bConfirmationCorpusExists = true;
      },
      (value: MutablePreregistration) => {
        value.confirmationLock.status = 'OPENED';
      }
    ]) {
      const fixture = await createSealedFixture();
      await mutatePreregistration(fixture.projectRoot, mutate);
      await writeSeal(fixture.projectRoot, fixture.fixtureRoot);

      await expect(validateH1bInputs(fixture.fixtureRoot)).rejects.toThrow(
        'H1b preregistration contract is invalid'
      );
    }
  });

  it('rejects changed calls, blocks, repetitions, and token budget after a valid re-seal', async () => {
    const mutations: Array<(value: MutablePreregistration) => void> = [
      (value) => {
        value.experiment.primaryCalls = 53;
      },
      (value) => {
        value.experiment.blocks = 17;
      },
      (value) => {
        value.experiment.repetitionsPerCell = 2;
      },
      (value) => {
        value.budget.maximumPrimaryCalls = 53;
      },
      (value) => {
        value.budget.maximumCalls = 55;
      },
      (value) => {
        value.budget.maximumObservedTotalTokens = 599_999;
      }
    ];
    for (const mutate of mutations) {
      const fixture = await createSealedFixture();
      await mutatePreregistration(fixture.projectRoot, mutate);
      await writeSeal(fixture.projectRoot, fixture.fixtureRoot);

      await expect(validateH1bInputs(fixture.fixtureRoot)).rejects.toThrow(
        'H1b preregistration contract is invalid'
      );
    }
  });

  it('rejects a seal that claims confirmation is available', async () => {
    const fixture = await createSealedFixture();
    const sealPath = path.join(fixture.fixtureRoot, 'seal-h1b-v1.json');
    const seal = JSON.parse(await fs.readFile(sealPath, 'utf8')) as {
      confirmationStatus: string;
    };
    seal.confirmationStatus = 'AVAILABLE';
    await fs.writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

    await expect(validateH1bInputs(fixture.fixtureRoot)).rejects.toThrow(
      'H1b seal header or development-only boundary is invalid'
    );
  });
});

async function createSealedFixture(): Promise<{
  projectRoot: string;
  fixtureRoot: string;
}> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-h1b-seal-'));
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
  const sourceEntry = path.join(projectRoot, 'src', 'dev', 'discourseLab', 'h1bCli.ts');
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
    'evaluation/discourse-lab/preregistration/h1b-v1.json'
  );
  const value = JSON.parse(
    await fs.readFile(preregistrationPath, 'utf8')
  ) as MutablePreregistration;
  mutate(value);
  await fs.writeFile(preregistrationPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSeal(projectRoot: string, fixtureRoot: string): Promise<void> {
  const files = await Promise.all(INPUTS.map(async (input) => ({
    path: input.relative,
    audience: input.audience,
    sha256: await sha256File(path.join(projectRoot, input.relative))
  })));
  const seal = {
    schemaVersion: 'discourse-lab-h1b-seal@1',
    sealVersion: 'h1b-seal-v1',
    corpusVersion: 'h1b-text-corpus-v1',
    preregistrationVersion: 'h1b-preregistration-v1',
    digestAlgorithm: 'SHA-256',
    partition: 'DEVELOPMENT_ONLY',
    confirmationStatus: 'ABSENT_CLOSED',
    files
  };
  await fs.writeFile(
    path.join(fixtureRoot, 'seal-h1b-v1.json'),
    `${JSON.stringify(seal, null, 2)}\n`
  );
}
