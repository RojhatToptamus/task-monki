import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AGENT_BROWSER_VERSION = '0.34.0';
const AGENT_BROWSER_COMMIT = '548b159b30eef119ccf6846c8bc807d0eaa3f6f8';
const AGENT_BROWSER_ARCHIVE_SHA256 =
  'a4744fb189e598467abcfb3acdde07118d9e5cb43dc3b31727f869af4eb9d598';
const CHROME_VERSION = '152.0.7977.54';
const ARCHIVES = {
  arm64: {
    agentBinary: 'agent-browser-darwin-arm64',
    agentSha256: 'd680a7a96ab86e9ab9d2b571b12919b761e93682ad1de714bbd5ac849c8d7c9c',
    chromeArchive: 'chrome-mac-arm64.zip',
    chromeDirectory: 'chrome-mac-arm64',
    chromeSha256: '0c8741d580076b3a8add518ddbb674183992d005cdee37a4875948c9f2748d2a',
    chromeBinarySha256:
      'e100ea3a3fc9d4dc4433e1f250a2394c894c88355f7d5210b5e57250f08adc15'
  },
  x64: {
    agentBinary: 'agent-browser-darwin-x64',
    agentSha256: 'dad3c9f9e67791a44a768a98847510c61a7b568a0499c602632b8aee411101e7',
    chromeArchive: 'chrome-mac-x64.zip',
    chromeDirectory: 'chrome-mac-x64',
    chromeSha256: '4a025d87c48da55bae94a907c0da052512a7fdaeda6bb6bbd78085836a7dafbd',
    chromeBinarySha256:
      '0d51c2caa32fda8216c2cba3b6e41baa6ef6afe89396d029314c3e888a2bd78e'
  }
};

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The Design browser runtime is currently packaged only for macOS.');
  }
  const requested = parseArchitectures(process.argv.slice(2));
  for (const architecture of requested) {
    await prepareArchitecture(architecture);
  }
}

async function prepareArchitecture(architecture) {
  const pin = ARCHIVES[architecture];
  const downloads = path.resolve('.local', 'design-browser-downloads');
  const target = path.resolve('.local', 'design-browser-runtime', architecture);
  await fs.mkdir(downloads, { recursive: true, mode: 0o700 });

  const agentArchive = path.join(
    downloads,
    `agent-browser-${AGENT_BROWSER_VERSION}.tgz`
  );
  await downloadVerified(
    `https://registry.npmjs.org/agent-browser/-/agent-browser-${AGENT_BROWSER_VERSION}.tgz`,
    agentArchive,
    AGENT_BROWSER_ARCHIVE_SHA256
  );
  const chromeArchive = path.join(
    downloads,
    `chrome-${CHROME_VERSION}-${architecture}.zip`
  );
  await downloadVerified(
    `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-${architecture}/${pin.chromeArchive}`,
    chromeArchive,
    pin.chromeSha256
  );

  const staging = await fs.mkdtemp(
    path.join(downloads, `prepare-${architecture}-`)
  );
  try {
    const agentRoot = path.join(staging, 'agent');
    const chromeRoot = path.join(staging, 'chrome');
    await fs.mkdir(agentRoot);
    await fs.mkdir(chromeRoot);
    await execFileAsync('tar', ['-xzf', agentArchive, '-C', agentRoot]);
    await execFileAsync('unzip', ['-q', chromeArchive, '-d', chromeRoot]);

    const sourceAgent = path.join(
      agentRoot,
      'package',
      'bin',
      pin.agentBinary
    );
    const sourceChrome = path.join(
      chromeRoot,
      pin.chromeDirectory,
      'Google Chrome for Testing.app'
    );
    const sourceChromeBinary = path.join(
      sourceChrome,
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
    await assertSha256(sourceAgent, pin.agentSha256);
    await assertSha256(sourceChromeBinary, pin.chromeBinarySha256);

    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.join(target, 'chrome'), { recursive: true, mode: 0o700 });
    await fs.copyFile(sourceAgent, path.join(target, 'agent-browser'));
    await fs.chmod(path.join(target, 'agent-browser'), 0o755);
    await fs.cp(sourceChrome, path.join(target, 'chrome', path.basename(sourceChrome)), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
    await fs.copyFile(
      path.join(agentRoot, 'package', 'LICENSE'),
      path.join(target, 'AGENT_BROWSER_LICENSE')
    );
    await fs.copyFile(
      path.resolve('THIRD_PARTY_LICENSES', 'Chrome-for-Testing-NOTICES.txt'),
      path.join(target, 'CHROME_FOR_TESTING_NOTICES')
    );
    await fs.writeFile(
      path.join(target, 'runtime-manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          architecture,
          agentBrowser: {
            version: AGENT_BROWSER_VERSION,
            commit: AGENT_BROWSER_COMMIT,
            archiveSha256: AGENT_BROWSER_ARCHIVE_SHA256,
            binarySha256: pin.agentSha256
          },
          chrome: {
            version: CHROME_VERSION,
            archiveSha256: pin.chromeSha256,
            binarySha256: pin.chromeBinarySha256
          }
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  console.log(`Prepared Design browser runtime for macOS ${architecture}.`);
}

async function downloadVerified(url, destination, expectedSha256) {
  if (await fileMatches(destination, expectedSha256)) return;
  const partial = `${destination}.partial`;
  await fs.rm(partial, { force: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download pinned Design browser resource: ${response.status}`);
  }
  const file = await fs.open(partial, 'wx', 0o600);
  try {
    for await (const chunk of response.body) await file.write(chunk);
  } finally {
    await file.close();
  }
  await assertSha256(partial, expectedSha256);
  await fs.rm(destination, { force: true });
  await fs.rename(partial, destination);
}

async function fileMatches(filePath, expectedSha256) {
  try {
    return (await sha256(filePath)) === expectedSha256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertSha256(filePath, expectedSha256) {
  const actual = await sha256(filePath);
  if (actual !== expectedSha256) {
    throw new Error(`Pinned Design browser checksum failed: ${path.basename(filePath)}`);
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function parseArchitectures(args) {
  if (args.length === 0) return [process.arch];
  const architectures = args.map((argument) => {
    if (!argument.startsWith('--arch=')) {
      throw new Error(`Unknown Design browser packaging option: ${argument}`);
    }
    return argument.slice('--arch='.length);
  });
  for (const architecture of architectures) {
    if (!(architecture in ARCHIVES)) {
      throw new Error(`Unsupported Design browser architecture: ${architecture}`);
    }
  }
  return [...new Set(architectures)];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
