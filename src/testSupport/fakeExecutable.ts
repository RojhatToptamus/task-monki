import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeNodeExecutable(
  directory: string,
  name: string,
  script: string
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const scriptName = `${name}.cjs`;
  const scriptPath = path.join(directory, scriptName);
  await fs.writeFile(scriptPath, ensureNodeShebang(script), 'utf8');

  if (process.platform === 'win32') {
    const launcherPath = path.join(directory, `${name}.cmd`);
    await fs.writeFile(
      launcherPath,
      `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`,
      'utf8'
    );
    return launcherPath;
  }

  const executable = path.join(directory, name);
  await fs.writeFile(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
    'utf8'
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

export async function writeOutputExecutable(
  directory: string,
  name: string,
  output: string
): Promise<string> {
  return writeNodeExecutable(
    directory,
    name,
    `process.stdout.write(${JSON.stringify(`${output}\n`)});\n`
  );
}

/**
 * An ssh that serves `git-upload-pack` and `git-receive-pack` from bare
 * repositories under `hostRoot`, for `GIT_SSH_COMMAND`: a fake platform's
 * remote without a network.
 */
export function writeFakeSsh(directory: string, hostRoot: string): Promise<string> {
  return writeNodeExecutable(directory, 'fake-ssh', `
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const command = process.argv[process.argv.length - 1];
const match = /^(git-upload-pack|git-receive-pack) '?\\/?([^']+?)'?$/.exec(command);
if (!match || match[2].split('/').includes('..')) { console.error('fake ssh: unexpected command ' + command); process.exit(128); }
const result = spawnSync('git', [match[1].slice(4), path.join(${JSON.stringify(hostRoot)}, match[2])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
}

function ensureNodeShebang(script: string): string {
  return script.startsWith('#!') ? script : `#!/usr/bin/env node\n${script}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
