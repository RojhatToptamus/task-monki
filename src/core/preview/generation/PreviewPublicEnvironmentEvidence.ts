import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../git/gitCli';
import { isPathWithin } from '../PreviewPaths';

export const PREVIEW_PUBLIC_ENVIRONMENT_EVIDENCE_VERSION =
  'task-monki-preview-public-environment-evidence/v1' as const;

const TEMPLATE_BASENAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  'example.env',
  'sample.env',
  'template.env'
]);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const EXCLUDED_SOURCE_SEGMENTS = new Set([
  '__fixtures__', '__mocks__', '__tests__', 'fixtures', 'mocks', 'test', 'tests'
]);
const MAX_TRACKED_PATHS = 20_000;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_TEMPLATE_LINES = 2_000;
const MAX_TEMPLATE_LINE_BYTES = 8 * 1024;
const MAX_SOURCE_TOKENS = 100_000;
const MAX_CANDIDATES = 64;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NEXT_PUBLIC_HTTP_KEY = /^NEXT_PUBLIC_[A-Z0-9_]*(?:URL|ORIGIN|ENDPOINT)$/;

export interface PreviewPublicHttpTargetEvidence {
  scheme: 'http' | 'https';
  host: string;
  port: number;
  basePath: string;
}

export interface PreviewEnvironmentTemplateKeyEvidence {
  key: string;
  exposure: 'NEXT_PUBLIC' | 'UNKNOWN';
  valueKind: 'EMPTY' | 'PLACEHOLDER' | 'CREDENTIAL_FREE_HTTP_URL' | 'REDACTED';
  publicHttpTarget?: PreviewPublicHttpTargetEvidence;
}

export interface PreviewEnvironmentTemplateEvidence {
  path: string;
  keys: PreviewEnvironmentTemplateKeyEvidence[];
}

export interface PreviewPublicEnvironmentCandidate {
  id: string;
  key: string;
  kind: 'POSSIBLE_HTTP_ORIGIN';
  sourceEvidencePaths: string[];
  templateEvidence: Array<{
    path: string;
    publicHttpTarget?: PreviewPublicHttpTargetEvidence;
  }>;
  sourceDefault?: PreviewPublicHttpTargetEvidence;
  targetPolicy:
    | { kind: 'LOCAL_REQUIRED' }
    | { kind: 'LITERAL_ALLOWED'; publicHttpTarget: PreviewPublicHttpTargetEvidence };
}

export interface PreviewPublicEnvironmentEvidence {
  schemaVersion: typeof PREVIEW_PUBLIC_ENVIRONMENT_EVIDENCE_VERSION;
  templates: PreviewEnvironmentTemplateEvidence[];
  candidates: PreviewPublicEnvironmentCandidate[];
}

interface EvidenceFile {
  path: string;
  content: string;
}

interface Token {
  type: 'identifier' | 'string' | 'punctuation';
  value: string;
}

export async function inspectPreviewPublicEnvironmentEvidence(
  repositoryRoot: string,
  files: readonly EvidenceFile[]
): Promise<PreviewPublicEnvironmentEvidence> {
  const templates = await inspectTrackedEnvironmentTemplates(repositoryRoot);
  return {
    schemaVersion: PREVIEW_PUBLIC_ENVIRONMENT_EVIDENCE_VERSION,
    templates,
    candidates: collectCandidates(files, templates)
  };
}

async function inspectTrackedEnvironmentTemplates(
  repositoryRoot: string
): Promise<PreviewEnvironmentTemplateEvidence[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(repositoryRoot);
  } catch {
    return [];
  }
  let output: string;
  try {
    output = await git(repositoryRoot, ['ls-files', '--cached', '-z']);
  } catch {
    return [];
  }
  const trackedPaths = output.split('\0').filter(Boolean);
  if (trackedPaths.length > MAX_TRACKED_PATHS) return [];
  const templates: PreviewEnvironmentTemplateEvidence[] = [];
  for (const relativePath of trackedPaths.sort()) {
    if (!safeRelativePath(relativePath) || !TEMPLATE_BASENAMES.has(path.posix.basename(relativePath))) {
      continue;
    }
    const lexicalPath = path.join(canonicalRoot, ...relativePath.split('/'));
    let canonicalPath: string;
    try {
      const entry = await fs.lstat(lexicalPath);
      if (entry.isSymbolicLink()) continue;
      canonicalPath = await fs.realpath(lexicalPath);
    } catch {
      continue;
    }
    if (!isPathWithin(canonicalRoot, canonicalPath)) continue;
    const evidence = await readTemplate(
      canonicalPath,
      relativePath
    ).catch(() => undefined);
    if (evidence) templates.push(evidence);
  }
  return templates;
}

async function readTemplate(
  absolutePath: string,
  relativePath: string
): Promise<PreviewEnvironmentTemplateEvidence | undefined> {
  const handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_TEMPLATE_BYTES) return undefined;
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_TEMPLATE_BYTES) return undefined;
    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || offset !== before.size
    ) return undefined;
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      return undefined;
    }
    if (content.includes('\0')) return undefined;
    const lines = content.split(/\r?\n/);
    if (lines.length > MAX_TEMPLATE_LINES) return undefined;
    const byKey = new Map<string, PreviewEnvironmentTemplateKeyEvidence | undefined>();
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_TEMPLATE_LINE_BYTES) return undefined;
      const parsed = parseTemplateLine(line);
      if (!parsed) continue;
      if (byKey.has(parsed.key)) {
        byKey.set(parsed.key, undefined);
        continue;
      }
      byKey.set(parsed.key, templateKeyEvidence(parsed.key, parsed.value));
    }
    return {
      path: relativePath,
      keys: [...byKey.values()]
        .filter((value): value is PreviewEnvironmentTemplateKeyEvidence => Boolean(value))
        .sort((left, right) => left.key.localeCompare(right.key))
    };
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

function parseTemplateLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(trimmed);
  if (!match || !ENVIRONMENT_KEY.test(match[1])) return undefined;
  return { key: match[1], value: literalTemplateValue(match[2]) };
}

function literalTemplateValue(value: string): string {
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
    const inner = value.slice(1, -1);
    return /[\\\r\n]/.test(inner) ? '' : inner;
  }
  return /[\s`$()\\]/.test(value) ? '' : value;
}

function templateKeyEvidence(key: string, value: string): PreviewEnvironmentTemplateKeyEvidence {
  const exposure = key.startsWith('NEXT_PUBLIC_') ? 'NEXT_PUBLIC' : 'UNKNOWN';
  const publicHttpTarget = exposure === 'NEXT_PUBLIC' ? safePublicHttpTarget(value) : undefined;
  if (publicHttpTarget) {
    return {
      key,
      exposure,
      valueKind: 'CREDENTIAL_FREE_HTTP_URL',
      publicHttpTarget
    };
  }
  return {
    key,
    exposure,
    valueKind: !value
      ? 'EMPTY'
      : looksLikePlaceholder(value)
        ? 'PLACEHOLDER'
        : 'REDACTED'
  };
}

function looksLikePlaceholder(value: string): boolean {
  return /^(?:<[^>]+>|\$\{[^}]+\}|(?:your|replace|change)[-_].+|changeme|todo)$/i.test(value);
}

function collectCandidates(
  files: readonly EvidenceFile[],
  templates: readonly PreviewEnvironmentTemplateEvidence[]
): PreviewPublicEnvironmentCandidate[] {
  const found = new Map<string, {
    paths: Set<string>;
    sourceDefault?: PreviewPublicHttpTargetEvidence;
    sourceDefaultConflict: boolean;
  }>();
  for (const file of files) {
    if (!isProductionSourcePath(file.path)) continue;
    const accesses = directNextPublicEnvironmentAccesses(file.content);
    for (const access of accesses) {
      if (!NEXT_PUBLIC_HTTP_KEY.test(access.key)) continue;
      const current = found.get(access.key) ?? {
        paths: new Set<string>(),
        sourceDefaultConflict: false
      };
      current.paths.add(file.path);
      if (access.sourceDefault && !current.sourceDefaultConflict) {
        if (current.sourceDefault && !samePublicHttpTarget(current.sourceDefault, access.sourceDefault)) {
          current.sourceDefault = undefined;
          current.sourceDefaultConflict = true;
        } else {
          current.sourceDefault = access.sourceDefault;
        }
      }
      found.set(access.key, current);
      if (found.size >= MAX_CANDIDATES) break;
    }
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const templateEvidence = templates.flatMap((template) => {
        const metadata = template.keys.find((candidate) => candidate.key === key);
        return metadata
          ? [{ path: template.path, publicHttpTarget: metadata.publicHttpTarget }]
          : [];
      });
      const targets = [
        ...templateEvidence.flatMap((item) => item.publicHttpTarget ? [item.publicHttpTarget] : []),
        ...(value.sourceDefault ? [value.sourceDefault] : [])
      ];
      const uniqueTargets = new Map(targets.map((target) => [publicHttpTargetKey(target), target]));
      const hasUnresolvedTemplateTarget = templateEvidence.some(
        (item) => !item.publicHttpTarget
      );
      const literalTarget = !value.sourceDefaultConflict && !hasUnresolvedTemplateTarget &&
        uniqueTargets.size === 1
        ? [...uniqueTargets.values()][0]
        : undefined;
      return {
        id: `next-public:${key}`,
        key,
        kind: 'POSSIBLE_HTTP_ORIGIN' as const,
        sourceEvidencePaths: [...value.paths].sort(),
        templateEvidence,
        sourceDefault: value.sourceDefault,
        targetPolicy: literalTarget
          ? { kind: 'LITERAL_ALLOWED' as const, publicHttpTarget: literalTarget }
          : { kind: 'LOCAL_REQUIRED' as const }
      };
    });
}

function directNextPublicEnvironmentAccesses(
  content: string
): Array<{ key: string; sourceDefault?: PreviewPublicHttpTargetEvidence }> {
  const tokens = lexJavaScript(content);
  const accesses: Array<{ key: string; sourceDefault?: PreviewPublicHttpTargetEvidence }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!matches(tokens, index, ['process', '.', 'env'])) continue;
    let key: string | undefined;
    let end = index + 3;
    if (matches(tokens, end, ['.', undefined]) && tokens[end + 1]?.type === 'identifier') {
      key = tokens[end + 1].value;
      end += 2;
    } else if (
      tokens[end]?.value === '[' && tokens[end + 1]?.type === 'string' && tokens[end + 2]?.value === ']'
    ) {
      key = tokens[end + 1].value;
      end += 3;
    }
    if (!key || !key.startsWith('NEXT_PUBLIC_')) continue;
    const operator = tokens[end]?.value;
    const sourceDefault = (operator === '||' || operator === '??') && tokens[end + 1]?.type === 'string'
      ? safePublicHttpTarget(tokens[end + 1].value)
      : undefined;
    accesses.push({ key, sourceDefault });
  }
  return accesses;
}

function matches(tokens: readonly Token[], start: number, values: Array<string | undefined>): boolean {
  return values.every((value, offset) => value === undefined || tokens[start + offset]?.value === value);
}

function lexJavaScript(content: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < content.length && tokens.length < MAX_SOURCE_TOKENS) {
    const character = content[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '/' && content[index + 1] === '/') {
      index += 2;
      while (index < content.length && content[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && content[index + 1] === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) index += 1;
      index = Math.min(content.length, index + 2);
      continue;
    }
    if (character === '/' && mayStartRegularExpression(tokens.at(-1))) {
      index = skipRegularExpression(content, index);
      continue;
    }
    if (character === '`') {
      index = skipQuoted(content, index, '`').next;
      continue;
    }
    if (character === "'" || character === '"') {
      const quoted = skipQuoted(content, index, character);
      if (quoted.value !== undefined) tokens.push({ type: 'string', value: quoted.value });
      index = quoted.next;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < content.length && /[A-Za-z0-9_$]/.test(content[index])) index += 1;
      tokens.push({ type: 'identifier', value: content.slice(start, index) });
      continue;
    }
    const operator = content.slice(index, index + 2);
    if (operator === '||' || operator === '??' || operator === '?.') {
      tokens.push({ type: 'punctuation', value: operator });
      index += 2;
      continue;
    }
    tokens.push({ type: 'punctuation', value: character });
    index += 1;
  }
  return tokens;
}

function mayStartRegularExpression(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (
    previous.type === 'identifier' &&
    ['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'return', 'throw', 'typeof', 'void', 'yield'].includes(previous.value)
  ) return true;
  return previous.type === 'punctuation' &&
    ['(', '[', '{', '=', ':', ',', ';', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>'].includes(previous.value);
}

function skipRegularExpression(content: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < content.length) {
    const character = content[index++];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    if (character === ']') inCharacterClass = false;
    if (character === '/' && !inCharacterClass) {
      while (index < content.length && /[A-Za-z]/.test(content[index])) index += 1;
      return index;
    }
    if (character === '\r' || character === '\n') return index;
  }
  return content.length;
}

function skipQuoted(
  content: string,
  start: number,
  quote: string
): { next: number; value?: string } {
  let index = start + 1;
  let value = '';
  let valid = true;
  while (index < content.length) {
    const character = content[index++];
    if (character === quote) return { next: index, value: valid ? value : undefined };
    if (character === '\\') {
      valid = false;
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') return { next: index };
    value += character;
  }
  return { next: content.length };
}

function safePublicHttpTarget(value: string): PreviewPublicHttpTargetEvidence | undefined {
  if (!value || value.length > 2_048 || /[\s\0\r\n]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname ||
    url.username || url.password || url.search || url.hash
  ) return undefined;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port,
    basePath: url.pathname || '/'
  };
}

function publicHttpTargetKey(target: PreviewPublicHttpTargetEvidence): string {
  return `${target.scheme}://${target.host}:${target.port}${target.basePath}`;
}

function samePublicHttpTarget(
  left: PreviewPublicHttpTargetEvidence,
  right: PreviewPublicHttpTargetEvidence
): boolean {
  return publicHttpTargetKey(left) === publicHttpTargetKey(right);
}

function isProductionSourcePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return (
    SOURCE_EXTENSIONS.has(path.posix.extname(basename)) &&
    !segments.some((segment) => EXCLUDED_SOURCE_SEGMENTS.has(segment)) &&
    !/\.(?:test|spec)\.[^.]+$/.test(basename)
  );
}

function safeRelativePath(relativePath: string): boolean {
  return Boolean(relativePath) && !path.posix.isAbsolute(relativePath) &&
    !relativePath.includes('\\') && !relativePath.split('/').includes('..') &&
    !/[\0\r\n]/.test(relativePath);
}
