import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File, sha256Text } from './ledger';

export const H1B_SOURCE_LOCK_VERSION = 'typescript-local-import-closure@v1' as const;

export interface H1bSourceLock {
  version: typeof H1B_SOURCE_LOCK_VERSION;
  entryFiles: string[];
  sourceFiles: string[];
  sha256: string;
}

/**
 * Hashes the executable local TypeScript import closure, including core Codex
 * boundary code. The previous lab lock covered only the top-level lab folder
 * and therefore did not bind the supervisor/RPC/permission implementation it
 * actually executed.
 */
export async function buildH1bSourceLock(
  projectRoot: string,
  entryFiles = ['src/dev/discourseLab/h1bCli.ts']
): Promise<H1bSourceLock> {
  const root = path.resolve(projectRoot);
  const pending = entryFiles.map((entry) => path.resolve(root, entry));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (seen.has(filePath)) continue;
    assertInside(filePath, root);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`H1b source-lock input must be a real file: ${filePath}`);
    }
    seen.add(filePath);
    const text = await fs.readFile(filePath, 'utf8');
    for (const specifier of localImportSpecifiers(text)) {
      const resolved = await resolveTypeScriptImport(path.dirname(filePath), specifier);
      if (!resolved) {
        throw new Error(`Cannot resolve H1b local import ${specifier} from ${filePath}.`);
      }
      pending.push(resolved);
    }
  }
  const sourceFiles = [...seen]
    .map((filePath) => path.relative(root, filePath).split(path.sep).join('/'))
    .sort();
  const entries = await Promise.all(sourceFiles.map(async (relative) =>
    `${relative}:${await sha256File(path.join(root, relative))}`
  ));
  return {
    version: H1B_SOURCE_LOCK_VERSION,
    entryFiles: [...entryFiles].sort(),
    sourceFiles,
    sha256: sha256Text(entries.join('\n'))
  };
}

function localImportSpecifiers(source: string): string[] {
  const matches = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) matches.add(match[1]!);
  }
  return [...matches];
}

async function resolveTypeScriptImport(
  parentDirectory: string,
  specifier: string
): Promise<string | undefined> {
  const base = path.resolve(parentDirectory, specifier);
  const candidates = path.extname(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  return undefined;
}

function assertInside(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`H1b source-lock input escapes the project root: ${candidate}`);
  }
}
