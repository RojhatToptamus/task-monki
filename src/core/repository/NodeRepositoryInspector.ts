import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitSucceeds } from '../git/gitCli';
import {
  MAX_REPOSITORY_IDENTITY_ANCHORS,
  MAX_REPOSITORY_REMOTE_FINGERPRINTS,
  RepositoryInspectionError,
  type InspectedRepository,
  type RepositoryPathInspector
} from './RepositoryRegistry';

export class NodeRepositoryInspector implements RepositoryPathInspector {
  async inspect(
    candidatePath: string,
    expectedIdentity?: import('./RepositoryRegistry').RepositoryIdentityEvidence
  ): Promise<InspectedRepository> {
    let candidateRealPath: string;
    try {
      candidateRealPath = await fs.realpath(path.resolve(candidatePath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new RepositoryInspectionError(
        code === 'ENOENT' ? 'MISSING' : 'INACCESSIBLE',
        code === 'ENOENT'
          ? 'The repository path does not exist.'
          : 'The repository path cannot be inspected.'
      );
    }

    let root: string;
    try {
      root = (await git(candidateRealPath, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new RepositoryInspectionError(
        'NOT_A_REPOSITORY',
        'The selected folder is not inside a Git repository.'
      );
    }

    const canonicalRealPath = await fs.realpath(root);
    const stat = await fs.stat(canonicalRealPath);
    const [objectFormat, recentAnchors, remotes] = await Promise.all([
      readGitValue(canonicalRealPath, ['rev-parse', '--show-object-format'], 'sha1'),
      readGitLines(canonicalRealPath, [
        'rev-list',
        `--max-count=${MAX_REPOSITORY_IDENTITY_ANCHORS}`,
        '--all'
      ]),
      readRemoteFingerprints(canonicalRealPath)
    ]);
    const retainedAnchors: string[] = [];
    for (const anchor of expectedIdentity?.anchorCommits ?? []) {
      if (await gitSucceeds(canonicalRealPath, ['cat-file', '-e', `${anchor}^{commit}`])) {
        retainedAnchors.push(anchor);
      }
    }
    const anchors = [...new Set([...retainedAnchors, ...recentAnchors])];

    return {
      canonicalRealPath,
      displayName: path.basename(canonicalRealPath),
      identity: {
        objectFormat,
        anchorCommits: anchors.slice(0, MAX_REPOSITORY_IDENTITY_ANCHORS),
        remoteFingerprints: remotes.slice(0, MAX_REPOSITORY_REMOTE_FINGERPRINTS),
        fileSystem: {
          device: String(stat.dev),
          inode: String(stat.ino)
        }
      }
    };
  }
}

async function readGitValue(cwd: string, argv: string[], fallback: string): Promise<string> {
  try {
    return (await git(cwd, argv)).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function readGitLines(cwd: string, argv: string[]): Promise<string[]> {
  try {
    return (await git(cwd, argv))
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readRemoteFingerprints(cwd: string): Promise<string[]> {
  const names = await readGitLines(cwd, ['remote']);
  const fingerprints = new Set<string>();
  for (const name of names) {
    const urls = await readGitLines(cwd, ['remote', 'get-url', '--all', name]);
    for (const remote of urls) {
      fingerprints.add(sha256(sanitizeRemote(remote)));
      if (fingerprints.size >= MAX_REPOSITORY_REMOTE_FINGERPRINTS) {
        return [...fingerprints];
      }
    }
  }
  return [...fingerprints];
}

function sanitizeRemote(remote: string): string {
  try {
    const parsed = new URL(remote);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return remote
      .replace(/^[^@/\s]+@(?=[^:/\s]+:)/u, '')
      .replace(/\/+$|\.git$/gu, '')
      .trim();
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
