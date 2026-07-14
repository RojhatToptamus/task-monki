import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseArtifacts } from './verify-release-artifacts.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('release artifact verification', () => {
  it('accepts structurally valid Linux artifacts', async () => {
    const releaseDir = await temporaryDirectory();
    const version = '1.2.3-test';
    const appImage = `Task-Monki-${version}-linux-x86_64.AppImage`;
    const deb = `Task-Monki-${version}-linux-amd64.deb`;
    await writeLargeFile(
      path.join(releaseDir, appImage),
      elfHeader(0x3e)
    );
    await fs.chmod(path.join(releaseDir, appImage), 0o755);
    await writeDebianArchive(path.join(releaseDir, deb));
    await fs.writeFile(
      path.join(releaseDir, 'latest-linux.yml'),
      `version: ${version}\nfiles:\n  - ${appImage}\n  - ${deb}\n`
    );

    await expect(
      verifyReleaseArtifacts({ platform: 'linux', releaseDir, version })
    ).resolves.toBeUndefined();
  });

  it('rejects a truncated Debian package even when it has an ar signature', async () => {
    const releaseDir = await temporaryDirectory();
    const version = '1.2.3-test';
    const appImage = `Task-Monki-${version}-linux-x86_64.AppImage`;
    const deb = `Task-Monki-${version}-linux-amd64.deb`;
    await writeLargeFile(
      path.join(releaseDir, appImage),
      elfHeader(0x3e)
    );
    await fs.chmod(path.join(releaseDir, appImage), 0o755);
    await fs.writeFile(path.join(releaseDir, deb), '!<arch>\n');
    await fs.writeFile(
      path.join(releaseDir, 'latest-linux.yml'),
      `version: ${version}\nfiles:\n  - ${appImage}\n  - ${deb}\n`
    );

    await expect(
      verifyReleaseArtifacts({ platform: 'linux', releaseDir, version })
    ).rejects.toThrow('unexpectedly small');
  });
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-release-verifier-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeLargeFile(filePath, magic) {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.truncate(1024 * 1024 + 1);
    await handle.write(magic, 0, magic.length, 0);
  } finally {
    await handle.close();
  }
}

async function writeDebianArchive(filePath) {
  const members = [
    arMember('debian-binary/', Buffer.from('2.0\n')),
    arMember('control.tar.gz/', Buffer.from('control')),
    arMember('data.tar.xz/', Buffer.alloc(1024 * 1024, 0x61))
  ];
  await fs.writeFile(filePath, Buffer.concat([Buffer.from('!<arch>\n'), ...members]));
}

function arMember(name, contents) {
  const header = [
    name.padEnd(16, ' '),
    '0'.padEnd(12, ' '),
    '0'.padEnd(6, ' '),
    '0'.padEnd(6, ' '),
    '100644'.padEnd(8, ' '),
    String(contents.length).padEnd(10, ' '),
    '`\n'
  ].join('');
  return Buffer.concat([
    Buffer.from(header, 'ascii'),
    contents,
    ...(contents.length % 2 === 1 ? [Buffer.from('\n')] : [])
  ]);
}

function elfHeader(machine) {
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header.writeUInt16LE(machine, 18);
  return header;
}
