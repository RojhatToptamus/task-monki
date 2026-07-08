import { describe, expect, it } from 'vitest';
import { prepareProcessCommand } from './portableChildProcess';

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
        '""C:\\Users\\Runner Admin\\AppData\\Local\\Temp\\fake-codex.cmd" "app-server" "--listen" "stdio://""'
      ]
    });
  });

  it('escapes percent expansion in Windows batch arguments', () => {
    expect(prepareProcessCommand('C:\\bin\\tool.cmd', ['%PATH%'], 'win32')).toMatchObject({
      argv: ['/d', '/s', '/c', '""C:\\bin\\tool.cmd" "%%PATH%%""']
    });
  });
});
