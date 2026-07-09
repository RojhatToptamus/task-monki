import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import { execFilePortable, prepareProcessCommand, spawnPortable } from './portableChildProcess';

describe('prepareProcessCommand', () => {
  it('keeps normal Unix commands unchanged', () => {
    expect(prepareProcessCommand('/usr/bin/node', ['--version'], 'darwin')).toEqual({
      executable: '/usr/bin/node',
      argv: ['--version']
    });
  });

  it('keeps Windows executable files unchanged', () => {
    expect(prepareProcessCommand('C:\\Tools\\git.exe', ['--version'], 'win32')).toEqual({
      executable: 'C:\\Tools\\git.exe',
      argv: ['--version']
    });
  });

  it('runs Windows batch launchers through cmd.exe', () => {
    expect(
      prepareProcessCommand(
        'C:\\Users\\Runner Admin\\AppData\\Local\\Temp\\fake-codex.cmd',
        ['app-server', '--listen', 'stdio://'],
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      argv: [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\Runner^ Admin\\AppData\\Local\\Temp\\fake-codex.cmd ^"app-server^" ^"--listen^" ^"stdio://^""'
      ],
      windowsVerbatimArguments: true
    });
  });

  it('escapes Windows shell metacharacters in batch launcher arguments', () => {
    expect(
      prepareProcessCommand(
        'C:\\Program Files\\tool.cmd',
        ['hello world', 'a&b', '%PATH%', 'quote"arg'],
        'win32'
      )
    ).toMatchObject({
      argv: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program^ Files\\tool.cmd ^"hello^ world^" ^"a^&b^" ^"^%PATH^%^" ^"quote\\^"arg^""'
      ],
      windowsVerbatimArguments: true
    });
  });

  it.runIf(process.platform === 'win32')(
    'executes generated Windows cmd launchers through execFilePortable',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki cmd exec '));
      const executable = await writeEchoExecutable(directory);

      const { stdout } = await execFilePortable(executable, ['--version', 'space arg'], {
        cwd: directory,
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });

      expect(stdout.trim()).toBe('--version|space arg');
    }
  );

  it.runIf(process.platform === 'win32')(
    'executes generated Windows cmd launchers through spawnPortable',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki cmd spawn '));
      const executable = await writeEchoExecutable(directory);
      const child = spawnPortable(executable, ['app-server', '--stdio'], {
        cwd: directory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout = await readChildOutput(child);

      expect(stdout.trim()).toBe('app-server|--stdio');
    }
  );
});

async function writeEchoExecutable(directory: string): Promise<string> {
  return writeNodeExecutable(
    directory,
    'fake-codex',
    "process.stdout.write(process.argv.slice(2).join('|') + '\\n');\n"
  );
}

async function readChildOutput(child: ReturnType<typeof spawnPortable>): Promise<string> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`Child exited with code ${code ?? 'null'}: ${stderr}`));
    });
  });
}
