const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { signAsync } = require('@electron/osx-sign');

const execFileAsync = promisify(execFile);

const dataResourceExtensions = [
  '.asar',
  '.bin',
  '.dat',
  '.icns',
  '.nib',
  '.pak',
  '.png'
];

module.exports = async function adHocMacSign(configuration) {
  const appPath = configuration.app || configuration.appPath || configuration.path;
  if (!appPath) {
    throw new Error('Missing app path before ad-hoc macOS signing.');
  }

  await signAsync({
    ...configuration,
    identity: '-',
    ignore: createIgnore(configuration.ignore)
  });

  await assertNoDetachedCodeSignatureXattrs(appPath);
  await execFileAsync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath
  ]);
};

function createIgnore(existingIgnore) {
  return (filePath) => {
    if (matchesExistingIgnore(existingIgnore, filePath)) {
      return true;
    }
    return shouldIgnoreDataResource(filePath);
  };
}

function matchesExistingIgnore(existingIgnore, filePath) {
  if (!existingIgnore) {
    return false;
  }

  const ignores = Array.isArray(existingIgnore) ? existingIgnore : [existingIgnore];
  return ignores.some((ignore) => {
    if (typeof ignore === 'function') {
      return ignore(filePath);
    }
    return filePath.match(ignore);
  });
}

function shouldIgnoreDataResource(filePath) {
  return (
    filePath.split(path.sep).includes('Resources') &&
    dataResourceExtensions.includes(path.extname(filePath))
  );
}

async function assertNoDetachedCodeSignatureXattrs(appPath) {
  const { stdout } = await execFileAsync('xattr', ['-lr', appPath], {
    maxBuffer: 1024 * 1024 * 16
  });
  const detachedSignatureLines = stdout
    .split('\n')
    .filter((line) => line.includes('com.apple.cs.Code'));

  if (detachedSignatureLines.length > 0) {
    throw new Error(
      [
        'Unexpected detached code-signature xattrs on macOS release resources:',
        ...detachedSignatureLines.slice(0, 20)
      ].join('\n')
    );
  }
}
