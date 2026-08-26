const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const JIT_ENTITLEMENTS = path.resolve(
  __dirname,
  '..',
  'build',
  'entitlements.mac.jit.plist'
);
const NO_ENTITLEMENTS = path.resolve(
  __dirname,
  '..',
  'build',
  'entitlements.mac.none.plist'
);
const JIT_CODE_NAMES = new Set([
  'Task Monki',
  'Task Monki Helper',
  'Task Monki Helper (GPU)',
  'Task Monki Helper (Renderer)',
  'Google Chrome for Testing Helper (GPU)',
  'Google Chrome for Testing Helper (Renderer)'
]);
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

async function trustedMacSign(configuration) {
  const appPath = configuration.app;
  if (!appPath || path.extname(appPath) !== '.app') {
    throw new Error('Trusted macOS signing requires an application bundle.');
  }
  if (configuration.platform !== 'darwin' || configuration.type !== 'distribution') {
    throw new Error('Trusted macOS signing requires direct distribution.');
  }
  if (!configuration.keychain) {
    throw new Error('Trusted macOS signing requires the temporary keychain.');
  }
  if (!/^[A-F0-9]{40}$/iu.test(configuration.identity ?? '')) {
    throw new Error('Trusted macOS signing requires a verified certificate hash.');
  }

  await removeDetachedCodeSignatureXattrs(appPath);

  const { signAsync } = require('@electron/osx-sign');
  await signAsync({
    ...configuration,
    platform: 'darwin',
    type: 'distribution',
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    provisioningProfile: undefined,
    ignore: createIgnore(configuration.ignore),
    optionsForFile: signingOptionsForFile
  });

  await assertNoDetachedCodeSignatureXattrs(appPath);
}

function signingOptionsForFile(filePath) {
  return {
    entitlements: isJitCode(filePath) ? JIT_ENTITLEMENTS : NO_ENTITLEMENTS,
    hardenedRuntime: true
  };
}

function isJitCode(filePath) {
  const extension = path.extname(filePath);
  const name = extension === '.app'
    ? path.basename(filePath, extension)
    : path.basename(filePath);
  return JIT_CODE_NAMES.has(name);
}

function createIgnore(existingIgnore) {
  return (filePath) =>
    matchesExistingIgnore(existingIgnore, filePath) ||
    shouldIgnoreNonMachOFile(filePath);
}

function matchesExistingIgnore(existingIgnore, filePath) {
  if (!existingIgnore) return false;
  const rules = Array.isArray(existingIgnore) ? existingIgnore : [existingIgnore];
  return rules.some((rule) =>
    typeof rule === 'function' ? rule(filePath) : filePath.match(rule)
  );
}

function shouldIgnoreNonMachOFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return false;

  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return bytesRead !== header.length || !MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    fs.closeSync(descriptor);
  }
}

async function assertNoDetachedCodeSignatureXattrs(appPath) {
  const { stdout } = await execFileAsync('xattr', ['-lr', appPath], {
    maxBuffer: 16 * 1024 * 1024
  });
  const entries = stdout
    .split('\n')
    .filter((line) => line.includes('com.apple.cs.Code'));
  if (entries.length > 0) {
    throw new Error(
      ['Unexpected detached code-signature attributes:', ...entries.slice(0, 20)].join('\n')
    );
  }
}

async function removeDetachedCodeSignatureXattrs(appPath) {
  for (const attribute of [
    'com.apple.cs.CodeDirectory',
    'com.apple.cs.CodeRequirements',
    'com.apple.cs.CodeSignature'
  ]) {
    await execFileAsync('xattr', ['-dr', attribute, appPath]);
  }
}

module.exports = trustedMacSign;
module.exports.createIgnore = createIgnore;
module.exports.isJitCode = isJitCode;
module.exports.signingOptionsForFile = signingOptionsForFile;
