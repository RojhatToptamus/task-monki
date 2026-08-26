import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('The packaged owner-process verifier currently supports macOS only.');
}

const projectRoot = process.cwd();
const appRoot = path.join(
  projectRoot,
  'release',
  process.arch === 'arm64' ? 'mac-arm64' : 'mac',
  'Task Monki.app'
);
const executablePath = path.join(
  appRoot,
  'Contents',
  'MacOS',
  'Task Monki'
);
const launcherPath = path.join(
  appRoot,
  'Contents',
  'Resources',
  'owned-process-launcher.mjs'
);
await Promise.all([
  fs.access(executablePath),
  fs.access(launcherPath)
]);

const require = createRequire(import.meta.url);
const {
  configureOwnedProcessLauncher,
  execFileOwnedPortable
} = require(
  path.join(
    projectRoot,
    'dist-electron',
    'core',
    'process',
    'ownedProcess.js'
  )
);

configureOwnedProcessLauncher({
  launcherPath,
  launcherExecutable: executablePath,
  launcherEnvironment: { ELECTRON_RUN_AS_NODE: '1' }
});
const result = await execFileOwnedPortable(
  '/usr/bin/printf',
  ['packaged-owner-ok'],
  { timeout: 10_000 }
);
if (result.stdout !== 'packaged-owner-ok' || result.stderr !== '') {
  throw new Error(
    `Packaged owner-process output mismatch: ${JSON.stringify(result)}`
  );
}

console.log(
  JSON.stringify(
    {
      status: 'passed',
      app: appRoot,
      executable: executablePath,
      launcher: launcherPath,
      electronRunAsNode: true,
      targetOutput: result.stdout
    },
    null,
    2
  )
);
