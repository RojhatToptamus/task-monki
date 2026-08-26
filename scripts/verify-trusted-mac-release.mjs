import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { isJitCode } = require('./trusted-mac-sign.cjs');

const AUTHORITY = 'Developer ID Application: rojhat toptamus (ZD35XP4V7D)';
const TEAM_ID = 'ZD35XP4V7D';
const DMG_IDENTIFIER = 'dev.taskmonki.desktop.dmg';
const ALLOW_JIT = 'com.apple.security.cs.allow-jit';
const MAX_BUFFER = 16 * 1024 * 1024;
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca
]);

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Trusted macOS release verification requires macOS.');
  }
  if (process.arch !== 'arm64') {
    throw new Error(`Trusted macOS release verification requires arm64, not ${process.arch}.`);
  }

  const options = parseOptions(process.argv.slice(2));
  const numericVersion = parseNumericVersion(options.version);
  const expectedName = `Task-Monki-${options.version}-mac-arm64.dmg`;
  const dmgPath = path.resolve(options.dmg);
  if (path.basename(dmgPath) !== expectedName) {
    throw new Error(`Expected ${expectedName}, received ${path.basename(dmgPath)}.`);
  }
  if ((await sha256(dmgPath)) !== options.sha256.toLowerCase()) {
    throw new Error('The DMG SHA-256 does not match the trusted build.');
  }

  await exec('hdiutil', ['verify', dmgPath]);
  await exec('codesign', ['--verify', '--strict', '--verbose=2', dmgPath]);
  await assertSignature(dmgPath, { requireRuntime: false });
  await assertSignatureIdentifier(dmgPath, DMG_IDENTIFIER);
  await exec('xcrun', ['stapler', 'validate', dmgPath]);
  await exec('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=4',
    dmgPath
  ]);

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-release-verify-')
  );
  const mountPoint = path.join(temporaryDirectory, 'mount');
  await fs.mkdir(mountPoint);
  let mounted = false;
  try {
    await exec('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountPoint,
      dmgPath
    ]);
    mounted = true;
    const appPath = await findApplication(mountPoint);
    await verifyApplication(appPath, {
      numericVersion,
      bundleVersion: options.bundleVersion,
      electronVersion: options.electronVersion,
      temporaryDirectory
    });
  } finally {
    try {
      if (mounted) await exec('hdiutil', ['detach', mountPoint]);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  console.log(`Verified trusted macOS release ${expectedName}.`);
}

async function verifyApplication(appPath, expected) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  await assertPlistValue(infoPlist, 'CFBundleIdentifier', 'dev.taskmonki.desktop');
  await assertPlistValue(infoPlist, 'CFBundleShortVersionString', expected.numericVersion);
  await assertPlistValue(infoPlist, 'CFBundleVersion', expected.bundleVersion);
  await assertPlistValue(infoPlist, 'LSMinimumSystemVersion', '14.0');
  const { stdout: profiles } = await exec('find', [
    appPath,
    '-name',
    'embedded.provisionprofile',
    '-print'
  ]);
  if (profiles.trim()) {
    throw new Error('The application contains an unexpected provisioning profile.');
  }

  await exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  await exec('spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    appPath
  ]);

  const codeObjects = await listCodeObjects(appPath);
  if (codeObjects.length === 0) {
    throw new Error('The application contains no signed code objects.');
  }
  let entitlementIndex = 0;
  for (const codeObject of codeObjects) {
    await exec('codesign', ['--verify', '--strict', '--verbose=2', codeObject.path]);
    await assertSignature(codeObject.path, { requireRuntime: true });
    const entitlements = await readEntitlements(
      codeObject.path,
      expected.temporaryDirectory,
      entitlementIndex++
    );
    const expectedKeys = isJitCode(codeObject.path) ? [ALLOW_JIT] : [];
    const actualKeys = Object.keys(entitlements).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      const relativePath = path.relative(appPath, codeObject.path) || path.basename(appPath);
      throw new Error(
        `${relativePath} has unexpected entitlements: ${actualKeys.join(', ') || 'none'}.`
      );
    }
    if (expectedKeys.length === 1 && entitlements[ALLOW_JIT] !== true) {
      throw new Error(`${codeObject.path} does not enable its required JIT entitlement.`);
    }
    if (codeObject.machO) {
      const { stdout } = await exec('lipo', ['-archs', codeObject.path]);
      const architectures = stdout.trim().split(/\s+/u).filter(Boolean);
      if (architectures.length !== 1 || architectures[0] !== 'arm64') {
        throw new Error(`${codeObject.path} is not arm64-only: ${architectures.join(', ')}.`);
      }
    }
  }

  await verifyRuntime(
    appPath,
    expected.electronVersion,
    expected.temporaryDirectory
  );
}

async function verifyRuntime(appPath, expectedElectronVersion, temporaryDirectory) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const electron = path.join(appPath, 'Contents', 'MacOS', 'Task Monki');
  const browserRoot = path.join(resources, 'design-browser-runtime');
  const agentBrowser = path.join(browserRoot, 'agent-browser');
  const chrome = path.join(
    browserRoot,
    'chrome',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing'
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(browserRoot, 'runtime-manifest.json'), 'utf8')
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.architecture !== 'arm64' ||
    typeof manifest.agentBrowser?.version !== 'string' ||
    typeof manifest.chrome?.version !== 'string'
  ) {
    throw new Error('The Design browser runtime manifest is invalid.');
  }

  const [{ stdout: electronOutput }, { stdout: agentOutput }, { stdout: chromeOutput }] =
    await Promise.all([
      exec(electron, ['-e', 'process.stdout.write(process.versions.electron)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }),
      exec(agentBrowser, ['--version']),
      exec(chrome, ['--version'])
    ]);
  if (electronOutput.trim() !== expectedElectronVersion) {
    throw new Error(`The packaged Electron version is ${electronOutput.trim()}.`);
  }
  if (agentOutput.trim() !== `agent-browser ${manifest.agentBrowser.version}`) {
    throw new Error('The packaged agent-browser version is invalid.');
  }
  if (!chromeOutput.includes(manifest.chrome.version)) {
    throw new Error('The packaged Chrome version is invalid.');
  }

  await verifyDesignBrowser(agentBrowser, chrome, temporaryDirectory);
}

async function verifyDesignBrowser(agentBrowser, chrome, temporaryDirectory) {
  const root = path.join(temporaryDirectory, 'design-browser');
  const socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tmrv-'));
  const policyPath = path.join(root, 'action-policy.json');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    policyPath,
    `${JSON.stringify({ default: 'deny', allow: ['launch', 'navigate', 'snapshot', 'close'] })}\n`,
    { mode: 0o600 }
  );
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: os.homedir(),
    TMPDIR: root,
    AGENT_BROWSER_SESSION: 'tmrel',
    AGENT_BROWSER_NAMESPACE: 'tmrel',
    AGENT_BROWSER_SOCKET_DIR: socketRoot,
    AGENT_BROWSER_EXECUTABLE_PATH: chrome,
    AGENT_BROWSER_ACTION_POLICY: policyPath,
    AGENT_BROWSER_CONTENT_BOUNDARIES: '1',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '60000',
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: '0',
    AGENT_BROWSER_PLUGINS: '[]'
  };
  let opened = false;
  try {
    await exec(agentBrowser, ['--json', 'open', 'about:blank'], {
      env: environment,
      timeout: 45_000
    });
    opened = true;
    await exec(agentBrowser, ['--json', 'snapshot', '-i', '-c'], {
      env: environment,
      timeout: 30_000
    });
  } finally {
    try {
      if (opened) {
        await exec(agentBrowser, ['--json', 'close'], {
          env: environment,
          timeout: 10_000
        });
      }
    } finally {
      await fs.rm(socketRoot, { recursive: true, force: true });
    }
  }
}

async function listCodeObjects(root) {
  const results = new Map();
  async function visit(entryPath) {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (/\.(?:app|appex|framework|xpc)$/u.test(entryPath)) {
        results.set(entryPath, { path: entryPath, machO: false });
      }
      for (const entry of await fs.readdir(entryPath)) {
        await visit(path.join(entryPath, entry));
      }
      return;
    }
    if (stat.isFile() && await isMachO(entryPath)) {
      results.set(entryPath, { path: entryPath, machO: true });
    }
  }
  await visit(root);
  return [...results.values()].sort((a, b) => b.path.length - a.path.length);
}

async function isMachO(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

async function assertSignature(target, { requireRuntime }) {
  const { stderr } = await exec('codesign', ['--display', '--verbose=4', target]);
  if (!stderr.split('\n').includes(`Authority=${AUTHORITY}`)) {
    throw new Error(`${target} has the wrong signing authority.`);
  }
  if (!stderr.split('\n').includes(`TeamIdentifier=${TEAM_ID}`)) {
    throw new Error(`${target} has the wrong signing team.`);
  }
  const timestamp = stderr.split('\n').find((line) => line.startsWith('Timestamp='));
  if (!timestamp || timestamp === 'Timestamp=none') {
    throw new Error(`${target} has no secure timestamp.`);
  }
  if (requireRuntime && !/^CodeDirectory .+ flags=.*\bruntime\b/mu.test(stderr)) {
    throw new Error(`${target} does not enable Hardened Runtime.`);
  }
}

async function assertSignatureIdentifier(target, expected) {
  const { stderr } = await exec('codesign', ['--display', '--verbose=2', target]);
  if (!stderr.split('\n').includes(`Identifier=${expected}`)) {
    throw new Error(`${target} has the wrong signing identifier.`);
  }
}

async function readEntitlements(target, temporaryDirectory, index) {
  const { stdout } = await exec('codesign', [
    '--display',
    '--entitlements',
    '-',
    '--xml',
    target
  ]);
  if (!stdout.includes('<plist')) return {};
  const plistPath = path.join(temporaryDirectory, `entitlements-${index}.plist`);
  await fs.writeFile(plistPath, stdout, { mode: 0o600 });
  const { stdout: json } = await exec('plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    plistPath
  ]);
  return JSON.parse(json);
}

async function findApplication(mountPoint) {
  const entries = await fs.readdir(mountPoint, { withFileTypes: true });
  const applications = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app')
  );
  if (applications.length !== 1 || applications[0].name !== 'Task Monki.app') {
    throw new Error('The DMG must contain one Task Monki.app at its root.');
  }
  return path.join(mountPoint, applications[0].name);
}

async function assertPlistValue(plistPath, key, expected) {
  const { stdout } = await exec('plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    plistPath
  ]);
  if (stdout.trim() !== expected) {
    throw new Error(`${key} is ${stdout.trim()}, expected ${expected}.`);
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function parseNumericVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc)\.\d+)?$/u.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function parseOptions(argumentsList) {
  const options = {};
  for (const argument of argumentsList) {
    const separator = argument.indexOf('=');
    if (separator < 1) throw new Error(`Invalid verifier option: ${argument}`);
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!value) throw new Error(`Missing value for ${name}.`);
    if (name === '--dmg') options.dmg = value;
    else if (name === '--version') options.version = value;
    else if (name === '--bundle-version') options.bundleVersion = value;
    else if (name === '--electron-version') options.electronVersion = value;
    else if (name === '--sha256') options.sha256 = value;
    else throw new Error(`Unknown verifier option: ${name}`);
  }
  for (const name of ['dmg', 'version', 'bundleVersion', 'electronVersion', 'sha256']) {
    if (!options[name]) throw new Error(`Missing verifier option: ${name}`);
  }
  if (!/^\d+$/u.test(options.bundleVersion)) {
    throw new Error('The bundle version must contain digits only.');
  }
  if (!/^\d+\.\d+\.\d+$/u.test(options.electronVersion)) {
    throw new Error('The Electron version is invalid.');
  }
  if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) {
    throw new Error('The SHA-256 value is invalid.');
  }
  return options;
}

async function exec(command, argumentsList, options = {}) {
  return execFileAsync(command, argumentsList, {
    maxBuffer: MAX_BUFFER,
    ...options
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
