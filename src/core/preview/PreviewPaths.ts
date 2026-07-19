import fs from 'node:fs/promises';
import path from 'node:path';

/** Canonicalizes a path that may not exist by resolving its nearest existing ancestor. */
export async function canonicalProspectivePath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const missingSegments: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      const realAncestor = await fs.realpath(candidate);
      return path.join(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function assertPathWithin(root: string, candidate: string, context = 'Path'): void {
  if (!isPathWithin(root, candidate)) {
    throw new Error(`${context} escapes its owned root: ${candidate}`);
  }
}

export async function resolveContainedProspectivePath(
  root: string,
  relativePath: string,
  context = 'Path'
): Promise<string> {
  const canonicalRoot = await canonicalProspectivePath(root);
  const canonicalCandidate = await canonicalProspectivePath(path.join(root, relativePath));
  assertPathWithin(canonicalRoot, canonicalCandidate, context);
  return canonicalCandidate;
}
