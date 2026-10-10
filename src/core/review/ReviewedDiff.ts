/**
 * Reads the diff evidence Task Monki captured for a reviewed Git snapshot.
 * Committed, staged and unstaged sections are merged per file, so a path that
 * changed in several sections appears once with all of its hunks.
 */

export interface ReviewedDiffHunk {
  header: string;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface ReviewedDiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: ReviewedDiffHunk[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

export function parseReviewedDiff(text: string): ReviewedDiffFile[] {
  const files = new Map<string, ReviewedDiffFile>();
  let chunk: string[] | undefined;
  const flush = () => {
    if (chunk) addChunk(files, chunk);
    chunk = undefined;
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('diff --git ')) {
      flush();
      chunk = [line];
    } else if (line.startsWith('## ') || line.startsWith('# ')) {
      // Diff content is always prefixed, so an unprefixed heading ends the file.
      flush();
    } else if (chunk) {
      chunk.push(line);
    }
  }
  flush();
  return [...files.values()];
}

/** One line per changed file with its added and removed line counts. */
export function formatReviewedDiffStat(files: readonly ReviewedDiffFile[], maxFiles = 200): string {
  if (files.length === 0) return 'No changed files were recorded.';
  const lines = files
    .slice(0, maxFiles)
    .map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`);
  if (files.length > maxFiles) lines.push(`- … and ${files.length - maxFiles} more files`);
  return lines.join('\n');
}

/**
 * The reviewed hunks of one file, closest to `line` first when it is given,
 * bounded to `maxLines` diff lines and printed in file order.
 */
export function reviewedDiffExcerpt(
  file: ReviewedDiffFile,
  line?: number,
  maxLines = 200
): string | undefined {
  if (file.hunks.length === 0) return undefined;
  const distance = (hunk: ReviewedDiffHunk) => {
    if (line === undefined) return 0;
    const end = hunk.newStart + Math.max(hunk.newCount, 1) - 1;
    return line < hunk.newStart ? hunk.newStart - line : line > end ? line - end : 0;
  };
  const ranked = file.hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((left, right) => distance(left.hunk) - distance(right.hunk) || left.index - right.index);
  const selected: Array<{ index: number; header: string; lines: string[] }> = [];
  let budget = maxLines;
  for (const { hunk, index } of ranked) {
    if (budget <= 0) break;
    const lines = hunk.lines.length <= budget ? hunk.lines : windowAround(hunk, line, budget);
    selected.push({ index, header: hunk.header, lines });
    budget -= lines.length;
  }
  const shown = selected.reduce((count, hunk) => count + hunk.lines.length, 0);
  const total = file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
  const body = selected
    .sort((left, right) => left.index - right.index)
    .flatMap((hunk) => [hunk.header, ...hunk.lines]);
  if (total > shown) body.push(`[${total - shown} more diff lines omitted]`);
  return [`--- ${file.path}`, ...body].join('\n');
}

function windowAround(hunk: ReviewedDiffHunk, line: number | undefined, size: number): string[] {
  let target = 0;
  if (line !== undefined) {
    let newLine = hunk.newStart;
    for (let index = 0; index < hunk.lines.length; index += 1) {
      if (newLine >= line) {
        target = index;
        break;
      }
      if (!hunk.lines[index]!.startsWith('-')) newLine += 1;
      target = index;
    }
  }
  const start = Math.max(0, Math.min(target - Math.floor(size / 2), hunk.lines.length - size));
  return hunk.lines.slice(start, start + size);
}

function addChunk(files: Map<string, ReviewedDiffFile>, chunk: readonly string[]): void {
  const path = chunkPath(chunk);
  if (!path) return;
  const file = files.get(path) ?? { path, additions: 0, deletions: 0, hunks: [] };
  files.set(path, file);
  let hunk: ReviewedDiffHunk | undefined;
  for (const line of chunk) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        header: line,
        newStart: Number(header[1]),
        newCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: []
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    hunk.lines.push(line);
    if (line.startsWith('+')) file.additions += 1;
    else if (line.startsWith('-')) file.deletions += 1;
  }
}

function chunkPath(chunk: readonly string[]): string | undefined {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  for (const line of chunk) {
    if (HUNK_HEADER.test(line)) break;
    if (line.startsWith('+++ ')) newPath = headerPath(line.slice(4), 'b/');
    else if (line.startsWith('--- ')) oldPath = headerPath(line.slice(4), 'a/');
    else if (line.startsWith('rename to ')) newPath ??= unquote(line.slice('rename to '.length));
  }
  if (newPath) return newPath;
  if (oldPath) return oldPath;
  const header = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/u.exec(chunk[0] ?? '');
  return header?.[2];
}

function headerPath(value: string, prefix: string): string | undefined {
  const path = unquote(value.trim());
  if (path === '/dev/null') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
