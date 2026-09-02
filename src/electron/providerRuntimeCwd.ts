import fs from 'node:fs';
import path from 'node:path';

export function resolveProviderRuntimeCwd(input: {
  defaultRepositoryPath: string;
  userDataDir: string;
}): string {
  if (input.defaultRepositoryPath) return input.defaultRepositoryPath;

  const runtimeCwd = path.join(input.userDataDir, 'provider-runtime');
  fs.mkdirSync(runtimeCwd, { recursive: true, mode: 0o700 });
  return runtimeCwd;
}
