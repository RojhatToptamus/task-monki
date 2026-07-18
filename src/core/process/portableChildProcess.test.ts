import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import {
  execFilePortable,
  isPortableProcessTreeRunning,
  prepareProcessCommand,
  spawnPortable,
  terminatePortableProcessTree,
  waitForPortableProcessTreeExit
} from './portableChildProcess';

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
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      argv: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '"C:\\Users\\Runner^ Admin\\AppData\\Local\\Temp\\fake-codex.cmd ^"app-server^" ^"--listen^" ^"stdio://^""'
      ],
      windowsVerbatimArguments: true
    });
  });

  it('uses a trusted host command processor when the child environment is minimal', () => {
    expect(
      prepareProcessCommand(
        'C:\\Tools\\git.cmd',
        ['--version'],
        'win32',
        { PATH: 'C:\\Tools' },
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          SystemRoot: 'C:\\Windows'
        }
      )
    ).toMatchObject({
      executable: 'C:\\Windows\\System32\\cmd.exe',
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
        '/v:off',
        '/c',
        '"C:\\Program^ Files\\tool.cmd ^"hello^ world^" ^"a^&b^" ^"^%PATH^%^" ^"quote\\^"arg^""'
      ],
      windowsVerbatimArguments: true
    });
  });

  it('adds a second escaping pass only for batch launchers that forward through %*', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki cmd shim '));
    const executable = path.join(directory, 'forwarding.cmd');
    await fs.writeFile(executable, '@echo off\r\nnode tool.cjs %*\r\n', 'utf8');

    expect(
      prepareProcessCommand(
        executable,
        ['space arg', 'a&b'],
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      ).argv.at(-1)
    ).toContain('^^^"space^^^ arg^^^" ^^^"a^^^&b^^^"');
  });

  it('closes stdin for complete noninteractive exec commands', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki exec eof '));
    const executable = await writeNodeExecutable(
      directory,
      'wait-for-eof',
      [
        "process.stdin.on('data', () => undefined);",
        "process.stdin.on('end', () => process.stdout.write('stdin-closed\\n'));",
        'process.stdin.resume();'
      ].join('\n')
    );

    const { stdout } = await execFilePortable(executable, [], {
      cwd: directory,
      env: process.env,
      timeout: 2_000,
      maxBuffer: 1024 * 1024
    });

    expect(stdout.trim()).toBe('stdin-closed');
  });

  it('delivers exact stdin before closing complete commands', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki exec stdin '));
    const executable = await writeNodeExecutable(
      directory,
      'read-stdin',
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => process.stdout.write(input));"
      ].join('\n')
    );

    const { stdout } = await execFilePortable(
      executable,
      [],
      {
        cwd: directory,
        env: process.env,
        timeout: 2_000,
        maxBuffer: 1024 * 1024
      },
      'private body\n'
    );

    expect(stdout).toBe('private body\n');
  });

  it.runIf(process.platform !== 'win32')(
    'owns and terminates descendants after a detached leader exits',
    async () => {
      const child = spawnPortable(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });",
            "setTimeout(() => process.exit(0), 20);"
          ].join('\n')
        ],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true
        }
      );

      await waitForChildClose(child);
      expect(isPortableProcessTreeRunning(child)).toBe(true);

      await terminatePortableProcessTree(child, 'SIGTERM');
      expect(await waitForPortableProcessTreeExit(child, 2_000)).toBe(true);
    }
  );

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
    'preserves cmd metacharacters with a deliberately minimal child environment',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki cmd minimal '));
      const executable = await writeEchoExecutable(directory);
      const args = [
        'space arg',
        'quote"arg',
        '%PATH%',
        '!bang!',
        'a&b',
        'a|b',
        '(group)'
      ];

      const { stdout } = await execFilePortable(executable, args, {
        cwd: directory,
        env: { PATH: directory },
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });

      expect(stdout.trim()).toBe(args.join('|'));
    }
  );

  it.runIf(process.platform === 'win32')(
    'passes the trusted command processor through the child environment',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki cmd env '));
      const executable = await writeNodeExecutable(
        directory,
        'fake-codex-env',
        "process.stdout.write(process.env.ComSpec ?? process.env.COMSPEC ?? 'missing');\n"
      );

      const { stdout } = await execFilePortable(executable, [], {
        cwd: directory,
        env: {
          PATH: directory,
          ComSpec: 'C:\\Untrusted\\cmd.exe'
        },
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });

      expect(path.win32.basename(stdout.trim()).toLowerCase()).toBe('cmd.exe');
      expect(stdout.trim().toLowerCase()).not.toBe('c:\\untrusted\\cmd.exe');
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

function waitForChildClose(child: ReturnType<typeof spawnPortable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}
