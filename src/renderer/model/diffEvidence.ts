export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'addition' | 'deletion';

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
  /**
   * Set on an unchanged line read from the checkout to fill a gap between hunks
   * (`reviewContext.ts`): hidden until the person reveals it. Never part of the
   * captured change, so it never counts toward what the change is.
   */
  expansion?: 'hidden' | 'shown';
}

export interface DiffBlock {
  id: string;
  label: string;
  source: DiffSectionSource;
  lines: DiffLine[];
}

export interface DiffFile {
  id: string;
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  blocks: DiffBlock[];
}

export type DiffEvidenceScope = 'all' | 'committed' | 'uncommitted';
export type DiffSectionSource = 'committed' | 'staged' | 'unstaged' | 'local';
export type GitDiffEvidenceCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'UNINTERPRETABLE';

export interface GitDiffEvidenceInspection {
  files: DiffFile[];
  completeness: GitDiffEvidenceCompleteness;
}

const UNAVAILABLE_DIFF_SECTION = /^##[ \t]+.+ unavailable[ \t]*$/im;
const TRUNCATED_ARTIFACT_MARKER = /\[Task Monki truncated [^\]]+ after \d+ retained bytes\.\]/i;
const TASK_MONKI_DIFF_HEADER = /^# Git diff evidence[ \t]*$/m;
const EMPTY_DIFF_MARKERS: Record<Exclude<DiffSectionSource, 'local'>, string> = {
  committed: 'No committed diff.',
  staged: 'No staged diff.',
  unstaged: 'No unstaged diff.'
};

interface RawDiffSection {
  label: string;
  source: DiffSectionSource;
  lines: string[];
}

interface ParsedFileBlock {
  path: string;
  oldPath?: string;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

interface ParsedDiffSections {
  files: DiffFile[];
  totalChunkCount: number;
  parsedChunkCount: number;
}

export function inspectGitDiffEvidence(text: string): GitDiffEvidenceInspection {
  const sections = extractDiffSections(text);
  const parsed = parseDiffSections(sections);
  const files = parsed.files;
  const hasUnparsedChunk = parsed.totalChunkCount > parsed.parsedChunkCount;
  const isTaskMonkiArtifact = TASK_MONKI_DIFF_HEADER.test(text);
  const hasCompleteTaskMonkiSections = isTaskMonkiArtifact
    ? (['committed', 'staged', 'unstaged'] as const).every((source) => {
        const section = sections.find((candidate) => candidate.source === source);
        if (!section) {
          return false;
        }
        return (
          section.lines.some((line) => line.trim() === EMPTY_DIFF_MARKERS[source]) ||
          section.lines.some((line) => line.startsWith('diff --git '))
        );
      })
    : true;

  let completeness: GitDiffEvidenceCompleteness = 'COMPLETE';
  if (UNAVAILABLE_DIFF_SECTION.test(text) || TRUNCATED_ARTIFACT_MARKER.test(text)) {
    completeness = 'INCOMPLETE';
  } else if (hasUnparsedChunk) {
    completeness = files.length > 0 ? 'INCOMPLETE' : 'UNINTERPRETABLE';
  } else if (isTaskMonkiArtifact && !hasCompleteTaskMonkiSections) {
    completeness = sections.length > 0 ? 'INCOMPLETE' : 'UNINTERPRETABLE';
  } else if (!isTaskMonkiArtifact && parsed.totalChunkCount === 0) {
    completeness = 'UNINTERPRETABLE';
  }
  return { files, completeness };
}

export function parseGitDiffEvidenceForScope(
  text: string,
  scope: DiffEvidenceScope
): DiffFile[] {
  const sections = extractDiffSections(text);
  return parseDiffSections(filterDiffSectionsByScope(sections, scope)).files;
}

function parseDiffSections(
  sections: RawDiffSection[]
): ParsedDiffSections {
  const filesByPath = new Map<string, DiffFile>();
  let totalChunkCount = 0;
  let parsedChunkCount = 0;

  for (const section of sections) {
    const chunks = splitFileChunks(section.lines);
    totalChunkCount += chunks.length;
    for (const chunk of chunks) {
      const parsed = parseFileChunk(chunk);
      if (!parsed) {
        continue;
      }
      parsedChunkCount += 1;
      const existing = filesByPath.get(parsed.path);
      const block: DiffBlock = {
        id: `${section.label}:${parsed.path}:${existing?.blocks.length ?? 0}`,
        label: section.label,
        source: section.source,
        lines: parsed.lines
      };

      if (existing) {
        existing.additions += parsed.additions;
        existing.deletions += parsed.deletions;
        existing.status = mergeStatus(existing.status, parsed.status);
        existing.blocks.push(block);
      } else {
        filesByPath.set(parsed.path, {
          id: parsed.path,
          path: parsed.path,
          oldPath: parsed.oldPath,
          status: parsed.status,
          additions: parsed.additions,
          deletions: parsed.deletions,
          blocks: [block]
        });
      }
    }
  }

  return {
    files: [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    totalChunkCount,
    parsedChunkCount
  };
}

function filterDiffSectionsByScope(
  sections: RawDiffSection[],
  scope: DiffEvidenceScope
): RawDiffSection[] {
  if (scope === 'all') {
    return sections;
  }
  if (scope === 'committed') {
    return sections.filter((section) => section.source === 'committed');
  }
  return sections.filter(
    (section) => section.source === 'staged' || section.source === 'unstaged'
  );
}

function extractDiffSections(text: string): RawDiffSection[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: RawDiffSection[] = [];
  let current: RawDiffSection | undefined;

  for (const line of lines) {
    const heading = /^## (Committed|Staged|Unstaged) diff\s*$/.exec(line);
    if (heading) {
      current = {
        label: `${heading[1]} diff`,
        source: diffSectionSource(heading[1]),
        lines: []
      };
      sections.push(current);
      continue;
    }
    if (/^## /.test(line)) {
      current = undefined;
      continue;
    }
    current?.lines.push(line);
  }

  if (sections.length === 0 && lines.some((line) => line.startsWith('diff --git '))) {
    return [{ label: 'Local diff', source: 'local', lines }];
  }

  return sections;
}

function diffSectionSource(heading: string): DiffSectionSource {
  switch (heading) {
    case 'Committed':
      return 'committed';
    case 'Staged':
      return 'staged';
    case 'Unstaged':
      return 'unstaged';
    default:
      return 'local';
  }
}

function splitFileChunks(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      chunk = [line];
    } else if (chunk.length > 0) {
      chunk.push(line);
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseFileChunk(lines: string[]): ParsedFileBlock | undefined {
  const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
  if (!header) {
    return undefined;
  }

  let oldPath: string | undefined = header[1];
  let newPath: string | undefined = header[2];
  let status: DiffFile['status'] = 'modified';
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let seenHunk = false;
  // Lines a hunk still owns, from its header counts. Text after a hunk is
  // exhausted (such as the trailing newline of the patch) is not file content.
  let oldRemaining = 0;
  let newRemaining = 0;

  const parsedLines: DiffLine[] = [];

  for (const line of lines) {
    // File headers precede the first hunk. Inside a hunk, "--- note" is a
    // removed line whose text starts with "-- ", never a path.
    if (!seenHunk) {
      if (line === 'new file mode') {
        status = 'added';
      } else if (line.startsWith('new file mode ')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode ')) {
        status = 'deleted';
      } else if (line.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) {
        status = 'renamed';
        newPath = line.slice('rename to '.length);
      } else if (line.startsWith('--- ')) {
        oldPath = parseDiffPath(line.slice(4), oldPath);
      } else if (line.startsWith('+++ ')) {
        newPath = parseDiffPath(line.slice(4), newPath);
      }
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      seenHunk = true;
      parsedLines.push({ kind: 'hunk', content: line });
      continue;
    }

    // Git prefixes every hunk line with a space, "+", "-" or "\". Anything else
    // — a truncation marker, the patch's trailing newline — ends the hunk, even
    // when a truncated hunk's counts were never used up.
    if (inHunk && ((oldRemaining <= 0 && newRemaining <= 0) || !/^[ +\-\\]/.test(line))) {
      inHunk = false;
    }

    if (!inHunk || line.startsWith('\\ No newline at end of file')) {
      parsedLines.push({ kind: 'meta', content: line });
      continue;
    }

    if (line.startsWith('+')) {
      parsedLines.push({ kind: 'addition', newLine, content: line });
      additions += 1;
      newLine += 1;
      newRemaining -= 1;
    } else if (line.startsWith('-')) {
      parsedLines.push({ kind: 'deletion', oldLine, content: line });
      deletions += 1;
      oldLine += 1;
      oldRemaining -= 1;
    } else {
      parsedLines.push({ kind: 'context', oldLine, newLine, content: line });
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }

  const path = newPath && newPath !== '/dev/null' ? newPath : oldPath;
  if (!path || path === '/dev/null') {
    return undefined;
  }

  return {
    path,
    oldPath: oldPath && oldPath !== path && oldPath !== '/dev/null' ? oldPath : undefined,
    status,
    additions,
    deletions,
    lines: parsedLines
  };
}

function parseDiffPath(value: string, fallback: string | undefined): string | undefined {
  if (value === '/dev/null') {
    return value;
  }
  if (value.startsWith('a/') || value.startsWith('b/')) {
    return value.slice(2);
  }
  return value || fallback;
}

function mergeStatus(a: DiffFile['status'], b: DiffFile['status']): DiffFile['status'] {
  if (a === b) {
    return a;
  }
  if (a === 'renamed' || b === 'renamed') {
    return 'renamed';
  }
  return 'modified';
}
