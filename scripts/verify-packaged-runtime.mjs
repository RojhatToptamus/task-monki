import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listPackage } from '@electron/asar';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;
const REQUIRED_APPLICATION_ENTRIES = [
  ['dist-electron/electron/main.js', 'Electron main entry point'],
  ['dist-electron/electron/preload.js', 'Electron preload entry point'],
  ['dist-electron/core/app/TaskManagerService.js', 'core application entry point'],
  ['dist-electron/shared/contracts.js', 'shared contracts'],
  ['dist-renderer/index.html', 'renderer entry point'],
  ['package.json', 'package manifest']
];
const REQUIRED_DESIGN_RESOURCE_FILES = [
  'design-skills/accessibility-review/SKILL.md',
  'design-skills/aesthetic-direction/SKILL.md',
  'design-skills/browser-verification/SKILL.md',
  'design-skills/design-system-inspection/SKILL.md',
  'design-skills/discovery-questions/SKILL.md',
  'design-skills/final-polish/SKILL.md',
  'design-skills/generic-design-review/SKILL.md',
  'design-skills/hierarchy-rhythm-review/SKILL.md',
  'design-skills/interaction-states-review/SKILL.md',
  'design-skills/prototype/SKILL.md',
  'design-skills/variations/SKILL.md',
  'design-skills/wireframe/SKILL.md',
  'legal/THIRD_PARTY_NOTICES.md',
  'legal/third-party/Claude-Design-System-MIT.txt'
];
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
  const archive = resolvePackagedArchive({ platform, arch, releaseDir });
  assertPackagedApplicationEntries(listPackage(archive));
  await assertPackagedDesignResources(path.dirname(archive));
  if (platform === 'darwin') {
    await assertPackagedDesignBrowserRuntime(path.dirname(archive), arch);
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

export function resolvePackagedArchive({ platform, arch, releaseDir }) {
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    const directory = arch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(
      releaseDir,
      directory,
      'Task Monki.app',
      'Contents',
      'Resources',
      'app.asar'
    );
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  }
  if (platform === 'linux' && arch === 'x64') {
    return path.join(releaseDir, 'linux-unpacked', 'resources', 'app.asar');
  }
  throw new Error(`Unsupported packaged archive platform: ${platform}/${arch}`);
}

export function assertPackagedApplicationEntries(entries) {
  const normalized = entries.map((entry) =>
    entry.replaceAll('\\', '/').replace(/^\/+/, '')
  );
  for (const [entry, description] of REQUIRED_APPLICATION_ENTRIES) {
    if (!normalized.includes(entry)) {
      throw new Error(`Packaged application is missing its ${description}: ${entry}`);
    }
  }
  const forbidden = normalized.find(
    (entry) =>
      entry === 'dist-tools' ||
      entry.startsWith('dist-tools/') ||
      entry === 'dist-electron/dev' ||
      entry.startsWith('dist-electron/dev/') ||
      entry === 'src/dev' ||
      entry.startsWith('src/dev/')
  );
  if (forbidden) {
    throw new Error(`Packaged application contains development-only content: ${forbidden}`);
  }
}

export async function assertPackagedDesignResources(resourceDirectory) {
  for (const relativePath of REQUIRED_DESIGN_RESOURCE_FILES) {
    const filePath = path.join(resourceDirectory, relativePath);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        throw new Error(`Packaged Design resource is invalid: ${relativePath}`, {
          cause: error
        });
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
      throw new Error(`Packaged Design resource is invalid: ${relativePath}`);
    }
  }
}

export async function assertPackagedDesignBrowserRuntime(resourceDirectory, arch) {
  const root = path.join(resourceDirectory, 'design-browser-runtime');
  const executable = path.join(root, 'agent-browser');
  const chromeApp = path.join(root, 'chrome', 'Google Chrome for Testing.app');
  const chromeExecutable = path.join(
    chromeApp,
    'Contents',
    'MacOS',
    'Google Chrome for Testing'
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'runtime-manifest.json'), 'utf8')
  );
  const expectedAgentSha = {
    arm64: 'd680a7a96ab86e9ab9d2b571b12919b761e93682ad1de714bbd5ac849c8d7c9c',
    x64: 'dad3c9f9e67791a44a768a98847510c61a7b568a0499c602632b8aee411101e7'
  }[arch];
  if (
    manifest.schemaVersion !== 1 ||
    manifest.architecture !== arch ||
    manifest.agentBrowser?.version !== '0.34.0' ||
    manifest.agentBrowser?.commit !==
      '548b159b30eef119ccf6846c8bc807d0eaa3f6f8' ||
    manifest.agentBrowser?.archiveSha256 !==
      'a4744fb189e598467abcfb3acdde07118d9e5cb43dc3b31727f869af4eb9d598' ||
    manifest.agentBrowser?.binarySha256 !== expectedAgentSha ||
    manifest.chrome?.version !== '152.0.7977.54'
  ) {
    throw new Error('Packaged Design browser runtime manifest does not match its pin.');
  }
  for (const filePath of [
    executable,
    chromeExecutable,
    path.join(root, 'AGENT_BROWSER_LICENSE'),
    path.join(root, 'CHROME_FOR_TESTING_NOTICES')
  ]) {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
      throw new Error(`Packaged Design browser resource is invalid: ${filePath}`);
    }
  }
  for (const filePath of [executable, chromeExecutable]) {
    const stat = await fs.stat(filePath);
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`Packaged Design browser executable bit is missing: ${filePath}`);
    }
  }
  if ((await sha256(executable)) !== expectedAgentSha) {
    throw new Error('Packaged agent-browser binary does not match its pinned checksum.');
  }
  const [{ stdout: version }, { stdout: agentArchitectures }, { stdout: chromeArchitectures }] =
    await Promise.all([
      execFileAsync(executable, ['--version'], { timeout: PROBE_TIMEOUT_MS }),
      execFileAsync('lipo', ['-archs', executable]),
      execFileAsync('lipo', ['-archs', chromeExecutable])
    ]);
  if (version.trim() !== 'agent-browser 0.34.0') {
    throw new Error('Packaged agent-browser returned an unexpected version.');
  }
  if (!agentArchitectures.trim().split(/\s+/u).includes(arch)) {
    throw new Error('Packaged agent-browser architecture does not match the app.');
  }
  if (!chromeArchitectures.trim().split(/\s+/u).includes(arch)) {
    throw new Error('Packaged Chrome architecture does not match the app.');
  }
  await execFileAsync('codesign', ['--verify', '--strict', executable]);
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', chromeApp]);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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
