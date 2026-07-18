import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzePreviewFrameworkCapabilities,
  inspectPreviewFrameworkRepositoryFacts,
  type PreviewFrameworkCapabilities
} from './PreviewFrameworkCapabilities';
import {
  inspectPreviewPublicEnvironmentEvidence,
  type PreviewPublicEnvironmentEvidence
} from './PreviewPublicEnvironmentEvidence';

const EVIDENCE_FILE_NAME = 'repository-evidence.json';
const MAX_DISCOVERED_ENTRIES = 20_000;
const MAX_INCLUDED_FILES = 600;
const MAX_FILE_BYTES = 384 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.aws',
  '.direnv',
  '.gnupg',
  '.local',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.turbo',
  '.venv',
  '.ssh',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor'
]);

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.graphql', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.md', '.mjs', '.cjs', '.php',
  '.prisma', '.properties', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte',
  '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml'
]);

const TEXT_BASENAMES = new Set([
  'AGENTS.md',
  'CODEOWNERS',
  'Dockerfile',
  'Gemfile',
  'Makefile',
  'Procfile',
  'README',
  'Rakefile',
  'go.mod',
  'go.sum',
  'requirements.txt'
]);

const DERIVED_ONLY_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock'
]);

export interface PreparedPreviewRecipeEvidenceBundle {
  directoryPath: string;
  fileName: typeof EVIDENCE_FILE_NAME;
  includedPaths: ReadonlySet<string>;
  safeOmissions: string[];
  frameworkCapabilities: PreviewFrameworkCapabilities;
  publicEnvironment: PreviewPublicEnvironmentEvidence;
  dispose(): Promise<void>;
}

interface EvidenceFile {
  path: string;
  content: string;
}

interface OmissionCounts {
  excludedDirectory: number;
  secretBearing: number;
  unsupported: number;
  oversized: number;
  binary: number;
  capacity: number;
  symlinkOrSpecial: number;
}

export async function preparePreviewRecipeEvidenceBundle(
  worktreePath: string
): Promise<PreparedPreviewRecipeEvidenceBundle> {
  const root = await fs.realpath(path.resolve(worktreePath));
  const directoryPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-preview-recipe-')
  );
  const files: EvidenceFile[] = [];
  const includedPaths = new Set<string>();
  const omissions: OmissionCounts = {
    excludedDirectory: 0,
    secretBearing: 0,
    unsupported: 0,
    oversized: 0,
    binary: 0,
    capacity: 0,
    symlinkOrSpecial: 0
  };
  let discoveredEntries = 0;
  let totalBytes = 0;

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    if (discoveredEntries >= MAX_DISCOVERED_ENTRIES) {
      omissions.capacity += 1;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      discoveredEntries += 1;
      if (discoveredEntries > MAX_DISCOVERED_ENTRIES) {
        omissions.capacity += 1;
        return;
      }
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          omissions.excludedDirectory += 1;
          continue;
        }
        await walk(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) {
        omissions.symlinkOrSpecial += 1;
        continue;
      }
      if (DERIVED_ONLY_BASENAMES.has(entry.name)) continue;
      if (isSecretBearingPath(relativePath)) {
        omissions.secretBearing += 1;
        continue;
      }
      if (!isSupportedTextPath(relativePath)) {
        omissions.unsupported += 1;
        continue;
      }
      if (files.length >= MAX_INCLUDED_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        omissions.capacity += 1;
        continue;
      }
      const absolutePath = path.join(root, ...relativePath.split('/'));
      const result = await readSafeTextFile(absolutePath);
      if (result.status === 'OVERSIZED') {
        omissions.oversized += 1;
        continue;
      }
      if (result.status === 'BINARY') {
        omissions.binary += 1;
        continue;
      }
      if (result.status === 'SECRET_BEARING') {
        omissions.secretBearing += 1;
        continue;
      }
      const byteCount = Buffer.byteLength(result.content, 'utf8');
      if (totalBytes + byteCount > MAX_TOTAL_BYTES) {
        omissions.capacity += 1;
        continue;
      }
      files.push({ path: relativePath, content: result.content });
      includedPaths.add(relativePath);
      totalBytes += byteCount;
    }
  };

  try {
    await walk(root, '');
    const safeOmissions = describeOmissions(omissions);
    const repositoryFacts = await inspectPreviewFrameworkRepositoryFacts(root);
    const frameworkCapabilities = analyzePreviewFrameworkCapabilities(files, repositoryFacts);
    const publicEnvironment = await inspectPreviewPublicEnvironmentEvidence(root, files);
    for (const analysis of frameworkCapabilities.analyses) {
      if (analysis.dependencyPreparation) {
        includedPaths.add(analysis.dependencyPreparation.lockfilePath);
      }
    }
    for (const template of publicEnvironment.templates) includedPaths.add(template.path);
    await fs.writeFile(
      path.join(directoryPath, EVIDENCE_FILE_NAME),
      JSON.stringify(
        {
          schemaVersion: 'task-monki-preview-repository-evidence/v2',
          source: 'sanitized task worktree snapshot',
          files,
          frameworkCapabilities,
          publicEnvironment,
          omissions: safeOmissions
        },
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    return {
      directoryPath,
      fileName: EVIDENCE_FILE_NAME,
      includedPaths,
      safeOmissions,
      frameworkCapabilities,
      publicEnvironment,
      dispose: () => fs.rm(directoryPath, { recursive: true, force: true })
    };
  } catch (error) {
    await fs.rm(directoryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function isSupportedTextPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return TEXT_BASENAMES.has(basename) || TEXT_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

function isSecretBearingPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (
    basename === '.npmrc' ||
    basename === '.pypirc' ||
    basename === '.netrc' ||
    basename === '.envrc' ||
    basename === '.git-credentials' ||
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.env') ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(basename) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/.test(basename)
  ) {
    return true;
  }
  const stem = basename.replace(/\.[^.]+$/, '');
  return /^(credentials?|secrets?|passwords?|tokens?|private[-_.]?keys?)$/.test(stem);
}

async function readSafeTextFile(
  filePath: string
): Promise<
  | { status: 'TEXT'; content: string }
  | { status: 'OVERSIZED' }
  | { status: 'BINARY' }
  | { status: 'SECRET_BEARING' }
> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { status: 'OVERSIZED' };
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) return { status: 'OVERSIZED' };
    const body = bytes.subarray(0, offset);
    if (body.includes(0)) return { status: 'BINARY' };
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { status: 'BINARY' };
    }
    if (containsLikelySecret(content)) return { status: 'SECRET_BEARING' };
    return { status: 'TEXT', content };
  } finally {
    await handle.close();
  }
}

function containsLikelySecret(content: string): boolean {
  return (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(content) ||
    /\bgh[opusr]_[A-Za-z0-9]{30,}\b/.test(content) ||
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(content) ||
    /\b(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|credentials?)\s*[:=]\s*["'][^"'`\r\n]{8,}["']/i.test(content) ||
    /\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s/]+@/i.test(content)
  );
}

function describeOmissions(counts: OmissionCounts): string[] {
  const descriptions: Array<[number, string]> = [
    [counts.secretBearing, 'likely secret-bearing files or contents'],
    [counts.binary, 'binary or non-UTF-8 files'],
    [counts.oversized, 'oversized text files'],
    [counts.unsupported, 'unsupported file types'],
    [counts.symlinkOrSpecial, 'symlinks or special files'],
    [counts.excludedDirectory, 'generated, dependency, cache, or VCS directories'],
    [counts.capacity, 'files beyond the bounded inspection capacity']
  ];
  return descriptions
    .filter(([count]) => count > 0)
    .map(([count, description]) => `Task Monki excluded ${count} ${description}.`);
}
