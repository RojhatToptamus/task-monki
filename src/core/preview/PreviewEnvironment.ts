const POSIX_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER'
] as const;
const WINDOWS_KEYS = ['APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'SYSTEMROOT', 'USERPROFILE', 'WINDIR'] as const;

export function buildPreviewEnvironment(input: {
  inherited?: NodeJS.ProcessEnv;
  recipe?: Record<string, string>;
  generated?: Record<string, string>;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const inherited = input.inherited ?? process.env;
  const platform = input.platform ?? process.platform;
  const result: NodeJS.ProcessEnv = {};
  for (const key of platform === 'win32' ? [...POSIX_KEYS, ...WINDOWS_KEYS] : POSIX_KEYS) {
    if (inherited[key] !== undefined) result[key] = inherited[key];
  }
  for (const [key, value] of Object.entries(input.recipe ?? {})) result[key] = value;
  for (const [key, value] of Object.entries(input.generated ?? {})) result[key] = value;
  result.TASK_MONKI_PREVIEW = '1';
  return result;
}
