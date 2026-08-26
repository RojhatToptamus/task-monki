import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { extractFile } from '@electron/asar';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const require = createRequire(import.meta.url);
const { path7za } = require('7zip-bin');
const YAML = require('yaml');
const MIN_PACKAGE_BYTES = 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 120_000;
const REQUIRED_PACKAGED_LEGAL_FILES = [
  'legal/LICENSE',
  'legal/THIRD_PARTY_NOTICES.md',
  'legal/third-party/OpenAI-Codex-Apache-2.0.txt',
  'legal/third-party/Claude-Design-System-MIT.txt',
  'legal/electron/LICENSE',
  'legal/electron/LICENSES.chromium.html'
];

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const packageJson = JSON.parse(
    await fs.readFile(path.resolve('package.json'), 'utf8')
  );
  const version = options.version ?? packageJson.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Release artifact verification requires a package version.');
  }

  const releaseDir = path.resolve(options.releaseDir ?? 'release');
  await verifyReleaseArtifacts({
    platform: options.platform ?? process.platform,
    releaseDir,
    version,
    nativeValidation: !options.artifactsOnly,
    packageContents: !options.artifactsOnly
  });
  console.log(`Verified ${platformLabel(options.platform ?? process.platform)} release artifacts.`);
}

export async function verifyReleaseArtifacts({
  platform,
  releaseDir,
  version,
  nativeValidation = false,
  packageContents = true
}) {
  if (platform === 'darwin') {
    await verifyMacArtifacts(releaseDir, version, nativeValidation);
  } else if (platform === 'win32') {
    await verifyWindowsArtifacts(releaseDir, version);
  } else if (platform === 'linux') {
    await verifyLinuxArtifacts(releaseDir, version, nativeValidation);
  } else {
    throw new Error(`Unsupported release verification platform: ${platform}`);
  }
  if (packageContents) {
    await verifyPackagedLegalFiles({ platform, releaseDir });
  }
}

export async function verifyPackagedLegalFiles({ platform, releaseDir }) {
  const resourceDirectories = packagedResourceDirectories(platform, releaseDir);
  for (const resourceDirectory of resourceDirectories) {
    for (const relativePath of REQUIRED_PACKAGED_LEGAL_FILES) {
      const filePath = path.join(resourceDirectory, relativePath);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error(
            `Required packaged legal file is missing: ${displayPath(releaseDir, filePath)}.`
          );
        }
        throw error;
      }
      if (!stat.isFile() || stat.size === 0) {
        throw new Error(
          `Required packaged legal file is empty or invalid: ${displayPath(releaseDir, filePath)}.`
        );
      }
    }
  }
}

function packagedResourceDirectories(platform, releaseDir) {
  if (platform === 'darwin') {
    return ['mac', 'mac-arm64'].map((directory) =>
      path.join(
        releaseDir,
        directory,
        'Task Monki.app',
        'Contents',
        'Resources'
      )
    );
  }
  if (platform === 'win32') {
    return [path.join(releaseDir, 'win-unpacked', 'resources')];
  }
  if (platform === 'linux') {
    return [path.join(releaseDir, 'linux-unpacked', 'resources')];
  }
  throw new Error(`Unsupported release verification platform: ${platform}`);
}

function displayPath(releaseDir, filePath) {
  return path.relative(releaseDir, filePath).split(path.sep).join('/');
}

async function verifyMacArtifacts(releaseDir, version, nativeValidation) {
  const artifacts = [
    `Task-Monki-${version}-mac-x64.dmg`,
    `Task-Monki-${version}-mac-arm64.dmg`,
    `Task-Monki-${version}-mac-x64.zip`,
    `Task-Monki-${version}-mac-arm64.zip`
  ];
  for (const name of artifacts) {
    const filePath = path.join(releaseDir, name);
    await assertPackageSize(filePath);
    if (name.endsWith('.dmg')) {
      await assertDmg(filePath);
      if (nativeValidation && process.platform === 'darwin') {
        await execFileAsync('hdiutil', ['verify', filePath], {
          timeout: ARCHIVE_TIMEOUT_MS
        });
      }
    }
    if (name.endsWith('.zip')) {
      await assertZip(filePath);
      await assertSevenZipArchive(filePath);
    }
    await assertGzip(path.join(releaseDir, `${name}.blockmap`));
  }
  await assertUpdateMetadata(
    path.join(releaseDir, 'latest-mac.yml'),
    version,
    artifacts
  );
  for (const [appPath, expectedArch] of [
    [path.join(releaseDir, 'mac', 'Task Monki.app'), 'x86_64'],
    [path.join(releaseDir, 'mac-arm64', 'Task Monki.app'), 'arm64']
  ]) {
    await execFileAsync('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      appPath
    ]);
    const executable = path.join(appPath, 'Contents', 'MacOS', 'Task Monki');
    const { stdout } = await execFileAsync('lipo', ['-archs', executable]);
    const architectures = stdout.trim().split(/\s+/u);
    if (architectures.length !== 1 || architectures[0] !== expectedArch) {
      throw new Error(
        `${path.basename(appPath)} has unexpected architectures: ${stdout.trim()}`
      );
    }
  }
}

async function verifyWindowsArtifacts(releaseDir, version) {
  const installer = `Task-Monki-${version}-win-x64.exe`;
  const installerPath = path.join(releaseDir, installer);
  await assertPackageSize(installerPath);
  await assertMagic(installerPath, Buffer.from('MZ'));
  await assertSevenZipArchive(installerPath);
  await verifyWindowsInstallerContents(installerPath, version);
  await assertGzip(path.join(releaseDir, `${installer}.blockmap`));
  await assertUpdateMetadata(
    path.join(releaseDir, 'latest.yml'),
    version,
    [installer]
  );
}

async function verifyLinuxArtifacts(releaseDir, version, nativeValidation) {
  const appImage = `Task-Monki-${version}-linux-x86_64.AppImage`;
  const appImagePath = path.join(releaseDir, appImage);
  await assertPackageSize(appImagePath);
  await assertElfMachine(appImagePath, 0x3e);
  const appImageStat = await fs.stat(appImagePath);
  if (process.platform !== 'win32' && (appImageStat.mode & 0o111) === 0) {
    throw new Error(`${appImage} is not executable.`);
  }
  await assertUpdateMetadata(
    path.join(releaseDir, 'latest-linux.yml'),
    version,
    [appImage]
  );
  if (nativeValidation && process.platform === 'linux') {
    await verifyNativeLinuxArtifact(appImagePath, version);
  }
}

async function assertPackageSize(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < MIN_PACKAGE_BYTES) {
    throw new Error(
      `${path.basename(filePath)} is unexpectedly small (${stat.size} bytes).`
    );
  }
}

async function assertMagic(filePath, expected) {
  const handle = await fs.open(filePath, 'r');
  try {
    const actual = Buffer.alloc(expected.length);
    const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
    if (bytesRead !== expected.length || !actual.equals(expected)) {
      throw new Error(`${path.basename(filePath)} has an invalid file signature.`);
    }
  } finally {
    await handle.close();
  }
}

async function assertElfMachine(filePath, expectedMachine) {
  const header = await readRange(filePath, 0, 20);
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`${path.basename(filePath)} has an invalid ELF signature.`);
  }
  if (header.readUInt16LE(18) !== expectedMachine) {
    throw new Error(`${path.basename(filePath)} has an unexpected ELF architecture.`);
  }
}

async function assertPeMachine(filePath, expectedMachine) {
  const dosHeader = await readRange(filePath, 0, 64);
  if (dosHeader.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`${path.basename(filePath)} has an invalid PE signature.`);
  }
  const peOffset = dosHeader.readUInt32LE(0x3c);
  const peHeader = await readRange(filePath, peOffset, 6);
  if (peHeader.subarray(0, 4).toString('binary') !== 'PE\0\0') {
    throw new Error(`${path.basename(filePath)} has an invalid PE header.`);
  }
  if (peHeader.readUInt16LE(4) !== expectedMachine) {
    throw new Error(`${path.basename(filePath)} has an unexpected PE architecture.`);
  }
}

async function assertDmg(filePath) {
  const trailer = await readTail(filePath, 512);
  if (trailer.subarray(0, 4).toString('ascii') !== 'koly') {
    throw new Error(`${path.basename(filePath)} has no valid UDIF trailer.`);
  }
}

async function assertZip(filePath) {
  await assertMagic(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const trailer = await readTail(filePath, 128 * 1024);
  if (trailer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < 0) {
    throw new Error(`${path.basename(filePath)} has no ZIP end record.`);
  }
}

async function assertGzip(filePath) {
  await assertMagic(filePath, Buffer.from([0x1f, 0x8b]));
  const contents = await gunzipAsync(await fs.readFile(filePath));
  if (contents.byteLength === 0) {
    throw new Error(`${path.basename(filePath)} contains an empty gzip stream.`);
  }
}

async function assertSevenZipArchive(filePath) {
  await execPackagedTool(path7za, ['t', '-bd', filePath], {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
}

async function verifyWindowsInstallerContents(installerPath, version) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-windows-verify-')
  );
  try {
    await execPackagedTool(
      path7za,
      [
        'x',
        '-bd',
        '-y',
        `-o${directory}`,
        installerPath,
        'Task Monki.exe',
        'resources/app-update.yml',
        'resources/app.asar'
      ],
      {
        timeout: ARCHIVE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      }
    );
    await assertPeMachine(path.join(directory, 'Task Monki.exe'), 0x8664);
    const updateConfig = YAML.parse(
      await fs.readFile(path.join(directory, 'resources', 'app-update.yml'), 'utf8')
    );
    if (
      updateConfig?.provider !== 'github' ||
      updateConfig.owner !== 'RojhatToptamus' ||
      updateConfig.repo !== 'task-monki'
    ) {
      throw new Error('The Windows installer has the wrong update source.');
    }
    if (Object.hasOwn(updateConfig, 'publisherName')) {
      throw new Error('The unsigned Windows installer must not require a publisher signature.');
    }
    await assertPackagedApplicationVersion(
      path.join(directory, 'resources', 'app.asar'),
      version
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function execPackagedTool(executable, args, options) {
  try {
    return await execFileAsync(executable, args, options);
  } catch (error) {
    if (process.platform === 'win32' || error?.code !== 'EACCES') {
      throw error;
    }
  }

  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-packaged-tool-')
  );
  const runnable = path.join(directory, path.basename(executable));
  try {
    await fs.copyFile(executable, runnable);
    await fs.chmod(runnable, 0o700);
    return await execFileAsync(runnable, args, options);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyNativeLinuxArtifact(appImagePath, version) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-appimage-verify-')
  );
  try {
    await execFileAsync(appImagePath, ['--appimage-extract'], {
      cwd: directory,
      timeout: ARCHIVE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    });
    const appRun = await fs.stat(path.join(directory, 'squashfs-root', 'AppRun'));
    if (!appRun.isFile()) {
      throw new Error(`${path.basename(appImagePath)} has no regular AppRun entry.`);
    }
    await assertPackagedApplicationVersion(
      path.join(directory, 'squashfs-root', 'resources', 'app.asar'),
      version
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function assertPackagedApplicationVersion(archivePath, version) {
  let packageJson;
  try {
    packageJson = JSON.parse(extractFile(archivePath, 'package.json').toString('utf8'));
  } catch (error) {
    throw new Error(`Could not read the packaged application version from ${archivePath}.`, {
      cause: error
    });
  }
  if (packageJson.version !== version) {
    throw new Error(`The packaged application has version ${packageJson.version}; expected ${version}.`);
  }
}

async function assertUpdateMetadata(filePath, version, artifacts) {
  const contents = await fs.readFile(filePath, 'utf8');
  const metadata = YAML.parse(contents);
  if (metadata?.version !== version) {
    throw new Error(`${path.basename(filePath)} has the wrong release version.`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== artifacts.length) {
    throw new Error(`${path.basename(filePath)} has the wrong artifact set.`);
  }
  for (const artifact of artifacts) {
    const entry = metadata.files.find((candidate) => candidate?.url === artifact);
    if (!entry) {
      throw new Error(
        `${path.basename(filePath)} does not reference ${artifact}.`
      );
    }
    const expectedSha512 = await fileDigest(
      path.join(path.dirname(filePath), artifact),
      'sha512',
      'base64'
    );
    if (entry.sha512 !== expectedSha512) {
      throw new Error(`${path.basename(filePath)} has the wrong digest for ${artifact}.`);
    }
  }
  if (metadata.path !== undefined) {
    if (!artifacts.includes(metadata.path)) {
      throw new Error(`${path.basename(filePath)} has an invalid primary artifact.`);
    }
    const primary = metadata.files.find((candidate) => candidate?.url === metadata.path);
    if (metadata.sha512 !== primary.sha512) {
      throw new Error(`${path.basename(filePath)} has the wrong primary artifact digest.`);
    }
  }
}

async function fileDigest(filePath, algorithm, encoding) {
  const digest = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return digest.digest(encoding);
}

async function readTail(filePath, byteCount) {
  const stat = await fs.stat(filePath);
  const length = Math.min(byteCount, stat.size);
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      stat.size - length
    );
    if (bytesRead !== length) {
      throw new Error(`Could not read ${path.basename(filePath)} trailer.`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readRange(filePath, offset, length) {
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) {
      throw new Error(`Could not read ${path.basename(filePath)} header.`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function parseOptions(args) {
  const options = {};
  for (const argument of args) {
    if (argument === '--artifacts-only') {
      options.artifactsOnly = true;
      continue;
    }
    const [name, value] = argument.split('=', 2);
    if (!value) throw new Error(`Invalid release verifier option: ${argument}`);
    if (name === '--platform') options.platform = value;
    else if (name === '--release-dir') options.releaseDir = value;
    else if (name === '--version') options.version = value;
    else throw new Error(`Unknown release verifier option: ${name}`);
  }
  return options;
}

function platformLabel(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
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
