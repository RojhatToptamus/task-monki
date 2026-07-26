import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [launcherPath, pidFile] = process.argv.slice(2);
if (!launcherPath || !pidFile) {
  throw new Error('Owned-process crash fixture requires launcher and pid-file paths.');
}

const launcher = spawn(process.execPath, [launcherPath], {
  cwd: process.cwd(),
  env: {},
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  detached: process.platform !== 'win32'
});
launcher.stdout.pipe(process.stdout);
launcher.stderr.pipe(process.stderr);
launcher.once('spawn', () => {
  launcher.send({
    type: 'configure',
    command: {
      executable: process.execPath,
      argv: [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const pidFile = ${JSON.stringify(pidFile)};`,
          "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], { stdio: 'ignore' });",
          "fs.writeFileSync(pidFile, JSON.stringify({ target: process.pid, descendant: descendant.pid }));",
          'setInterval(() => {}, 30000);'
        ].join('\n')
      ],
      cwd: process.cwd(),
      env: process.env
    }
  });
  process.stdout.write(`${JSON.stringify({ launcher: launcher.pid })}\n`);
});
fs.openSync(pidFile, 'a');
setInterval(() => {}, 30_000);
