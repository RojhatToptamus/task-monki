/**
 * Reads unified diffs Task Monki captured: the diff evidence of a Git snapshot,
 * whose committed, staged and unstaged sections are merged per file, so a path
 * that changed in several sections appears once with all of its hunks; or the
 * change a review read, one diff from the base to the reviewed tree.
 */

export interface ReviewedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The hunk's lines, as many as its header counts. */
  lines: string[];
}

export interface ReviewedDiffFile {
  path: string;
  /** What the diff did to the file; a path merged from several sections keeps its first section's. */
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  /** A renamed file's path at the base. */
  oldPath?: string;
  additions: number;
  deletions: number;
  hunks: ReviewedDiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
/** Past this many characters the change index lists no more files; its checks still read them all. */
const CHANGE_INDEX_TEXT_LIMIT = 60_000;
const CHANGE_INDEX_RANGE_LIMIT = 40;

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

/**
 * The change a review reads, as its prompt lists it: one line per file with its
 * status, its added and removed line counts, and its hunks as line ranges at the
 * head, or at the base for a deleted file. A long change is cut at a file.
 */
export function changeIndexText(files: readonly ReviewedDiffFile[]): string {
  const lines: string[] = [];
  let length = 0;
  for (const [index, file] of files.entries()) {
    const line = changeIndexLine(file);
    length += line.length + 1;
    if (length > CHANGE_INDEX_TEXT_LIMIT) {
      lines.push(`… and ${files.length - index} more files, not listed here.`);
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** A path as the index lists it: quoted when it holds a space, so it never reads as the line's next field. */
function indexPath(path: string): string {
  return /\s/u.test(path) ? JSON.stringify(path) : path;
}

function changeIndexLine(file: ReviewedDiffFile): string {
  const side = file.status === 'deleted' ? 'base' : 'head';
  const ranges = file.hunks.flatMap((hunk) => {
    const [start, count] = side === 'base' ? [hunk.oldStart, hunk.oldCount] : [hunk.newStart, hunk.newCount];
    return count === 0 ? [] : [count === 1 ? `${start}` : `${start}-${start + count - 1}`];
  });
  const listed = ranges.slice(0, CHANGE_INDEX_RANGE_LIMIT);
  return [
    indexPath(file.path),
    file.status === 'added' ? 'new' : file.status,
    ...(file.oldPath ? [`from ${indexPath(file.oldPath)}`] : []),
    `+${file.additions} -${file.deletions}`,
    ...(listed.length > 0 ? [`${side} ${listed.join(', ')}`] : []),
    ...(ranges.length > listed.length ? [`and ${ranges.length - listed.length} more hunks`] : [])
  ].join(' ');
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
  const identity = chunkIdentity(chunk);
  if (!identity) return;
  const file = files.get(identity.path) ?? { ...identity, additions: 0, deletions: 0, hunks: [] };
  files.set(file.path, file);
  let hunk: ReviewedDiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of chunk) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: []
      };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // "\ No newline at end of file" belongs to the line before it.
    if (line.startsWith('\\')) {
      hunk.lines.push(line);
      continue;
    }
    // Text past the hunk's counts, such as the diff's last line break, is not the file's.
    if (oldLeft <= 0 && newLeft <= 0) continue;
    hunk.lines.push(line);
    if (line.startsWith('+')) {
      file.additions += 1;
      newLeft -= 1;
    } else if (line.startsWith('-')) {
      file.deletions += 1;
      oldLeft -= 1;
    } else {
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
}

/** A file's path at the head (at the base when it was deleted), and what the diff did to it. */
function chunkIdentity(chunk: readonly string[]): Pick<ReviewedDiffFile, 'path' | 'status' | 'oldPath'> | undefined {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let status: ReviewedDiffFile['status'] = 'modified';
  let renamedFrom: string | undefined;
  for (const line of chunk) {
    if (HUNK_HEADER.test(line)) break;
    if (line.startsWith('+++ ')) newPath = headerPath(line.slice(4), 'b/');
    else if (line.startsWith('--- ')) oldPath = headerPath(line.slice(4), 'a/');
    else if (line.startsWith('rename to ')) newPath ??= unquote(line.slice('rename to '.length));
    else if (line.startsWith('rename from ')) {
      status = 'renamed';
      renamedFrom = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('new file mode ')) status = 'added';
    else if (line.startsWith('deleted file mode ')) status = 'deleted';
  }
  const header = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/u.exec(chunk[0] ?? '');
  const path = newPath ?? oldPath ?? header?.[2];
  if (!path) return undefined;
  return { path, status, ...(renamedFrom ? { oldPath: renamedFrom } : {}) };
}

function headerPath(value: string, prefix: string): string | undefined {
  const path = unquote(value.trim());
  if (path === '/dev/null') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
