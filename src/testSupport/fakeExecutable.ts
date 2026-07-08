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

function ensureNodeShebang(script: string): string {
  return script.startsWith('#!') ? script : `#!/usr/bin/env node\n${script}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
