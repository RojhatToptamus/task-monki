import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_SOURCE = [
  'process.stdout.write(JSON.stringify({',
  'electron: process.versions.electron,',
  'platform: process.platform,',
  'arch: process.arch',
  '}))'
].join('');

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const releaseDir = path.resolve(options.releaseDir ?? 'release');
  const electronPackage = JSON.parse(
    await fs.readFile(path.resolve('node_modules/electron/package.json'), 'utf8')
  );
  if (typeof electronPackage.version !== 'string') {
    throw new Error('Could not determine the installed Electron version.');
  }

  const result = await verifyPackagedRuntime({
    platform: process.platform,
    arch: process.arch,
    releaseDir,
    expectedElectronVersion: electronPackage.version
  });
  console.log(
    `Verified packaged Electron ${result.electron} runtime on ${result.platform}/${result.arch}.`
  );
}

export async function verifyPackagedRuntime({
  platform,
  arch,
  releaseDir,
  expectedElectronVersion
}) {
  if (typeof expectedElectronVersion !== 'string' || expectedElectronVersion.length === 0) {
    throw new Error('Packaged runtime verification requires an Electron version.');
  }

  const executable = resolvePackagedRuntime({ platform, arch, releaseDir });
  const stat = await fs.stat(executable);
  if (!stat.isFile()) {
    throw new Error(`Packaged runtime is not a file: ${executable}`);
  }

  const { stdout } = await execFileAsync(executable, ['-e', PROBE_SOURCE], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  const result = parseProbeResult(stdout, executable);
  if (result.electron !== expectedElectronVersion) {
    throw new Error(
      `Packaged runtime reports Electron ${result.electron}; expected ${expectedElectronVersion}.`
    );
  }
  if (result.platform !== platform || result.arch !== arch) {
    throw new Error(
      `Packaged runtime reports ${result.platform}/${result.arch}; expected ${platform}/${arch}.`
    );
  }
  return result;
}

export function resolvePackagedRuntime({ platform, arch, releaseDir }) {
  if (platform === 'darwin' && arch === 'x64') {
    return path.join(
      releaseDir,
      'mac',
      'Task Monki.app',
      'Contents',
      'MacOS',
      'Task Monki'
    );
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return path.join(
      releaseDir,
      'mac-arm64',
      'Task Monki.app',
      'Contents',
      'MacOS',
      'Task Monki'
    );
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(releaseDir, 'win-unpacked', 'Task Monki.exe');
  }
  if (platform === 'linux' && arch === 'x64') {
    return path.join(releaseDir, 'linux-unpacked', 'task-monki');
  }
  throw new Error(`Unsupported packaged runtime platform: ${platform}/${arch}`);
}

function parseProbeResult(stdout, executable) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${path.basename(executable)} returned an invalid runtime probe: ${stdout.trim()}`
    );
  }
  if (
    !result ||
    typeof result.electron !== 'string' ||
    typeof result.platform !== 'string' ||
    typeof result.arch !== 'string'
  ) {
    throw new Error(`${path.basename(executable)} returned an incomplete runtime probe.`);
  }
  return result;
}

function parseOptions(args) {
  const options = {};
  for (const argument of args) {
    const [name, value] = argument.split('=', 2);
    if (!value) throw new Error(`Invalid packaged runtime option: ${argument}`);
    if (name === '--release-dir') options.releaseDir = value;
    else throw new Error(`Unknown packaged runtime option: ${name}`);
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
