import { seedTaskMonkiDevelopmentData, type DevSeedScenarioSet } from './seedData';

interface CliOptions {
  rootDir?: string;
  storeDir?: string;
  repositoryPath?: string;
  worktreeRoot?: string;
  previewRoot?: string;
  appSettingsPath?: string;
  scenarioSet?: DevSeedScenarioSet;
  reset?: boolean;
  help?: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const manifest = await seedTaskMonkiDevelopmentData({
    rootDir: options.rootDir,
    storeDir: options.storeDir,
    repositoryPath: options.repositoryPath,
    worktreeRoot: options.worktreeRoot,
    previewRoot: options.previewRoot,
    appSettingsPath: options.appSettingsPath,
    scenarioSet: options.scenarioSet,
    reset: options.reset
  });

  console.log(`Seeded Task Monki development data: ${manifest.rootDir}`);
  console.log(`Manifest: ${manifest.manifestPath}`);
  console.log(`Environment file: ${manifest.envFilePath}`);
  console.log('');
  for (const [key, value] of Object.entries(manifest.env)) {
    console.log(`export ${key}=${JSON.stringify(value)}`);
  }
  console.log('Seed files are mode 0600.');
  console.log('');
  console.log('Then run:');
  console.log('  npm run dev:api');
  console.log('  npm run dev:renderer');
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--reset':
        options.reset = true;
        break;
      case '--root':
        options.rootDir = readValue(args, ++index, arg);
        break;
      case '--store-dir':
        options.storeDir = readValue(args, ++index, arg);
        break;
      case '--repo-path':
        options.repositoryPath = readValue(args, ++index, arg);
        break;
      case '--worktree-root':
        options.worktreeRoot = readValue(args, ++index, arg);
        break;
      case '--preview-root':
        options.previewRoot = readValue(args, ++index, arg);
        break;
      case '--app-settings-path':
        options.appSettingsPath = readValue(args, ++index, arg);
        break;
      case '--scenario-set':
        options.scenarioSet = readScenarioSet(readValue(args, ++index, arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readScenarioSet(value: string): DevSeedScenarioSet {
  if (['all', 'board', 'agent', 'review', 'delivery', 'completion', 'workflow', 'preview'].includes(value)) {
    return value as DevSeedScenarioSet;
  }
  throw new Error(`Unknown scenario set: ${value}`);
}

function printHelp(): void {
  console.log(`Usage: node dist-tools/dev/seed.js [options]

Options:
  --reset                    Reset the seed-owned root before generating data.
  --root <path>              Seed root. Defaults to .local/task-monki-dev-seed.
  --store-dir <path>         FileTaskStore directory.
  --repo-path <path>         Generated fixture repository path.
  --worktree-root <path>     Generated worktree root.
  --preview-root <path>      Generated preview runtime root.
  --app-settings-path <path> App settings JSON path.
  --scenario-set <set>       all, board, agent, review, delivery, completion, workflow, preview.
`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
