import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const require = createRequire(import.meta.url);
const { path7za } = require('7zip-bin');
const MIN_PACKAGE_BYTES = 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 120_000;

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
    nativeValidation: true
  });
  console.log(`Verified ${platformLabel(options.platform ?? process.platform)} release artifacts.`);
}

export async function verifyReleaseArtifacts({
  platform,
  releaseDir,
  version,
  nativeValidation = false
}) {
  if (platform === 'darwin') {
    await verifyMacArtifacts(releaseDir, version, nativeValidation);
    return;
  }
  if (platform === 'win32') {
    await verifyWindowsArtifacts(releaseDir, version);
    return;
  }
  if (platform === 'linux') {
    await verifyLinuxArtifacts(releaseDir, version, nativeValidation);
    return;
  }
  throw new Error(`Unsupported release verification platform: ${platform}`);
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
  await assertGzip(path.join(releaseDir, `${installer}.blockmap`));
  await assertPeMachine(
    path.join(releaseDir, 'win-unpacked', 'Task Monki.exe'),
    0x8664
  );
  await assertUpdateMetadata(
    path.join(releaseDir, 'latest.yml'),
    version,
    [installer]
  );
}

async function verifyLinuxArtifacts(releaseDir, version, nativeValidation) {
  const appImage = `Task-Monki-${version}-linux-x86_64.AppImage`;
  const deb = `Task-Monki-${version}-linux-amd64.deb`;
  const appImagePath = path.join(releaseDir, appImage);
  const debPath = path.join(releaseDir, deb);
  await assertPackageSize(appImagePath);
  await assertElfMachine(appImagePath, 0x3e);
  const appImageStat = await fs.stat(appImagePath);
  if (process.platform !== 'win32' && (appImageStat.mode & 0o111) === 0) {
    throw new Error(`${appImage} is not executable.`);
  }
  await assertPackageSize(debPath);
  await assertDebianArchive(debPath);
  await assertUpdateMetadata(
    path.join(releaseDir, 'latest-linux.yml'),
    version,
    [appImage, deb]
  );
  if (nativeValidation && process.platform === 'linux') {
    await verifyNativeLinuxArtifacts(appImagePath, debPath);
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
  await execFileAsync(path7za, ['t', '-bd', filePath], {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
}

async function verifyNativeLinuxArtifacts(appImagePath, debPath) {
  await execFileAsync('dpkg-deb', ['--info', debPath], {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024
  });
  await execFileAsync('dpkg-deb', ['--contents', debPath], {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });

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
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function assertDebianArchive(filePath) {
  await assertMagic(filePath, Buffer.from('!<arch>\n'));
  const members = await readArMemberNames(filePath);
  if (!members.includes('debian-binary')) {
    throw new Error(`${path.basename(filePath)} has no debian-binary member.`);
  }
  if (!members.some((name) => name.startsWith('control.tar'))) {
    throw new Error(`${path.basename(filePath)} has no control archive.`);
  }
  if (!members.some((name) => name.startsWith('data.tar'))) {
    throw new Error(`${path.basename(filePath)} has no data archive.`);
  }
}

async function readArMemberNames(filePath) {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');
  const members = [];
  let offset = 8;
  try {
    while (offset + 60 <= stat.size) {
      const header = Buffer.alloc(60);
      const { bytesRead } = await handle.read(header, 0, header.length, offset);
      if (bytesRead !== header.length || header.subarray(58, 60).toString() !== '`\n') {
        throw new Error(`${path.basename(filePath)} has a malformed ar header.`);
      }
      const name = header
        .subarray(0, 16)
        .toString('ascii')
        .trim()
        .replace(/\/$/u, '');
      const size = Number(header.subarray(48, 58).toString('ascii').trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`${path.basename(filePath)} has an invalid ar member size.`);
      }
      members.push(name);
      offset += 60 + size + (size % 2);
    }
    if (offset !== stat.size) {
      throw new Error(`${path.basename(filePath)} has trailing ar data.`);
    }
    return members;
  } finally {
    await handle.close();
  }
}

async function assertUpdateMetadata(filePath, version, artifacts) {
  const contents = await fs.readFile(filePath, 'utf8');
  if (!contents.includes(`version: ${version}`)) {
    throw new Error(`${path.basename(filePath)} has the wrong release version.`);
  }
  for (const artifact of artifacts) {
    if (!contents.includes(artifact)) {
      throw new Error(
        `${path.basename(filePath)} does not reference ${artifact}.`
      );
    }
  }
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
