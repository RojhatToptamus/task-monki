import { describe, expect, it } from 'vitest';
import { chooseRepositoryFolder, parseAppleScriptFolderPath } from './folderPicker';

describe('dev folder picker', () => {
  it('parses a selected macOS folder path', () => {
    expect(parseAppleScriptFolderPath('/Users/me/project/\n')).toBe('/Users/me/project/');
    expect(parseAppleScriptFolderPath('\n')).toBeUndefined();
  });

  it('opens the macOS folder picker and returns the selected path', async () => {
    const selectedPath = await chooseRepositoryFolder('darwin', async (file, args, options) => {
      expect(file).toBe('osascript');
      expect(args).toEqual([
        '-e',
        'POSIX path of (choose folder with prompt "Choose a repository folder")'
      ]);
      expect(options.timeout).toBe(120_000);
      return { stdout: '/Users/me/repo\n', stderr: '' };
    });

    expect(selectedPath).toBe('/Users/me/repo');
  });

  it('returns undefined when the picker is canceled', async () => {
    const selectedPath = await chooseRepositoryFolder('darwin', async () => {
      const error = new Error('execution error: User canceled. (-128)');
      throw error;
    });

    expect(selectedPath).toBeUndefined();
  });

  it('does not fall back to manual path entry on unsupported platforms', async () => {
    await expect(
      chooseRepositoryFolder('linux', async () => ({ stdout: '', stderr: '' }))
    ).rejects.toThrow('Folder picker is available in the desktop app on this platform.');
  });
});
