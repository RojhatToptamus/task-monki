import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('The Phase 1 packaged launcher verifier currently supports macOS only.');
}

const projectRoot = process.cwd();
const releaseRoot = path.join(projectRoot, 'release');
const executablePath = await findPackagedExecutable(releaseRoot);
const appRoot = executablePath.slice(0, executablePath.indexOf(`${path.sep}Contents${path.sep}`));
const launcherPath = path.join(appRoot, 'Contents', 'Resources', 'native-preview-launcher.mjs');
await fs.access(launcherPath);

const hostModule = await import(
  pathToFileURL(
    path.join(projectRoot, 'dist-electron', 'core', 'preview', 'runtime', 'NativeLauncherHost.js')
  ).href
);
const { NativeLauncherHost, readNativeLauncherReceipt } = hostModule;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-packaged-launcher-'));
const receiptPath = path.join(root, 'runtime', 'ownership.json');
const stdoutPath = path.join(root, 'stdout.log');
const stderrPath = path.join(root, 'stderr.log');
await fs.writeFile(stdoutPath, '', { mode: 0o600 });
await fs.writeFile(stderrPath, '', { mode: 0o600 });

try {
  let preparedPersisted = false;
  const host = new NativeLauncherHost(launcherPath, executablePath, {
    ELECTRON_RUN_AS_NODE: '1'
  });
  const owned = await host.launch({
    receiptPath,
    executable: '/usr/bin/printf',
    argv: ['packaged-launcher-ok'],
    cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
    stdoutPath,
    stderrPath,
    async persistPrepared(identity) {
      const receipt = await readNativeLauncherReceipt(identity.receiptPath);
      if (receipt.state !== 'PREPARED') {
        throw new Error(`Expected PREPARED receipt, received ${receipt.state}.`);
      }
      preparedPersisted = true;
    }
  });
  const receipt = await owned.completion;
  const stdout = await fs.readFile(stdoutPath, 'utf8');
  if (!preparedPersisted || receipt.state !== 'EXITED' || receipt.exitCode !== 0) {
    throw new Error(`Packaged launcher did not exit cleanly: ${JSON.stringify(receipt)}`);
  }
  if (stdout !== 'packaged-launcher-ok') {
    throw new Error(`Packaged launcher output mismatch: ${JSON.stringify(stdout)}`);
  }
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        app: appRoot,
        executable: executablePath,
        launcher: launcherPath,
        electronRunAsNode: true,
        systemNodeRequiredByLauncher: false,
        receiptState: receipt.state,
        targetExitCode: receipt.exitCode
      },
      null,
      2
    )
  );
} catch (error) {
  const [receipt, stdout, stderr] = await Promise.all([
    readNativeLauncherReceipt(receiptPath).catch(() => undefined),
    fs.readFile(stdoutPath, 'utf8').catch(() => ''),
    fs.readFile(stderrPath, 'utf8').catch(() => '')
  ]);
  console.error(
    JSON.stringify({ receipt, stdout, stderr, error: error instanceof Error ? error.message : String(error) })
  );
  throw error;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function findPackagedExecutable(root) {
  const entries = await fs.readdir(root, { recursive: true });
  const suffix = path.join('Task Monki.app', 'Contents', 'MacOS', 'Task Monki');
  const matches = entries
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => path.join(root, entry))
    .sort();
  if (matches.length === 0) {
    throw new Error('No packaged Task Monki .app executable was found under release/. Run npm run dist:dir first.');
  }
  return matches[0];
}
