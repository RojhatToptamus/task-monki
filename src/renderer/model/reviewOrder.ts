import { isBlockingFinding } from '../../shared/contracts';
import type { DiffFile } from './diffEvidence';
import type { ReviewFindingView } from './reviewWorkspace';

/**
 * The order the Review tab reads files in. Files shown last get the least
 * attention (a defect in the last file had 64% lower odds of being found), so
 * the default puts what matters first: files with an open Blocker or Major, then
 * code, each test right after the code it covers, then styles and markup,
 * configuration, documentation, and generated files last, folded.
 */
export type ReviewFileRole = 'code' | 'test' | 'ui' | 'config' | 'docs' | 'generated';

export interface OrderedReviewFile {
  file: DiffFile;
  role: ReviewFileRole;
  /** For a test: the changed file it covers. */
  subject?: DiffFile;
}

export type ReviewFileOrder = 'importance' | 'path';

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'uv.lock'
]);
const CONFIG_NAMES = new Set([
  'package.json', 'dockerfile', 'makefile', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.editorconfig'
]);

export function reviewFileRole(path: string): ReviewFileRole {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const name = segments.at(-1) ?? lower;
  if (LOCKFILES.has(name) || /\.min\.(?:js|css)$/u.test(name) || name.endsWith('.snap') ||
    segments.includes('__snapshots__') || segments[0] === 'dist' || /\.generated\.[a-z]+$/u.test(name)) {
    return 'generated';
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name) || /_test\.(?:go|py)$/u.test(name) || /^test_.+\.py$/u.test(name) ||
    segments.slice(0, -1).some((segment) => segment === '__tests__' || segment === 'test' || segment === 'tests' || segment === 'spec')) {
    return 'test';
  }
  if (/\.(?:md|mdx|rst|txt|adoc)$/u.test(name) || segments[0] === 'docs') return 'docs';
  if (CONFIG_NAMES.has(name) || name.startsWith('.env') || name.startsWith('tsconfig') || segments[0] === '.github' ||
    /\.(?:ya?ml|toml|ini)$/u.test(name) || /\.config\.[cm]?[jt]s$/u.test(name)) {
    return 'config';
  }
  if (/\.(?:css|scss|sass|less|html?|svg)$/u.test(name)) return 'ui';
  return 'code';
}

/** What a file is, as its mark shows it. */
export type ReviewFileKind = 'code' | 'text' | 'data' | 'image' | 'script' | 'lock' | 'config';

export function reviewFileKind(path: string): ReviewFileKind {
  const name = (path.split('/').at(-1) ?? path).toLowerCase();
  if (LOCKFILES.has(name)) return 'lock';
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/u.test(name)) return 'image';
  if (/\.(?:md|mdx|rst|txt|adoc)$/u.test(name)) return 'text';
  if (reviewFileRole(path) === 'config') return 'config';
  if (/\.(?:json|jsonc|json5|csv|tsv|xml)$/u.test(name)) return 'data';
  if (/\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/u.test(name)) return 'script';
  return 'code';
}

/** The name a test and the file it covers share: `foo` for foo.ts and foo.test.ts. */
function stem(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  return name.replace(/^test_/u, '').replace(/(?:\.(?:test|spec)|_test)?\.[^.]+$/u, '').toLowerCase();
}

const TIER: Record<ReviewFileRole, number> = { code: 1, test: 2, ui: 3, config: 4, docs: 5, generated: 6 };

export function orderReviewFiles(
  files: readonly DiffFile[],
  findingsByFile: ReadonlyMap<string, readonly ReviewFindingView[]>,
  order: ReviewFileOrder = 'importance'
): OrderedReviewFile[] {
  const entries = files.map((file) => ({ file, role: reviewFileRole(file.path) }));
  if (order === 'path') {
    return [...entries].sort((a, b) => a.file.path.localeCompare(b.file.path));
  }
  const subjects = entries.filter((entry) => entry.role === 'code' || entry.role === 'ui');
  const tests = entries.filter((entry) => entry.role === 'test');
  const codeOnly = subjects.filter((entry) => entry.role === 'code');
  const subjectOf = new Map<DiffFile, DiffFile>();
  for (const test of tests) {
    const match = subjects.find((entry) => stem(entry.file.path) === stem(test.file.path))
      ?? (codeOnly.length === 1 && tests.length === 1 ? codeOnly[0] : undefined);
    if (match) subjectOf.set(test.file, match.file);
  }

  const open = (file: DiffFile) => (findingsByFile.get(file.id) ?? []).filter((finding) => finding.state === 'OPEN');
  const blocking = (file: DiffFile) => open(file).some(isBlockingFinding);
  // A file and the tests that cover it read as one unit, placed by its most pressing member.
  const units = entries.filter((entry) => !subjectOf.has(entry.file)).map((entry) => {
    const members = [entry, ...tests.filter((test) => subjectOf.get(test.file) === entry.file)];
    return {
      members,
      tier: members.some((member) => blocking(member.file)) ? 0 : TIER[entry.role],
      findings: members.reduce((sum, member) => sum + open(member.file).length, 0),
      deletions: members.reduce((sum, member) => sum + member.file.deletions, 0),
      size: members.reduce((sum, member) => sum + member.file.additions + member.file.deletions, 0)
    };
  });
  units.sort((a, b) => a.tier - b.tier || b.findings - a.findings || b.deletions - a.deletions ||
    b.size - a.size || a.members[0]!.file.path.localeCompare(b.members[0]!.file.path));
  return units.flatMap((unit) => unit.members.map((member) => ({
    file: member.file,
    role: member.role,
    ...(subjectOf.has(member.file) ? { subject: subjectOf.get(member.file) } : {})
  })));
}
