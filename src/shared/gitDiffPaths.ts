/**
 * Paths as a unified diff from Git writes them, read the same by every parser
 * of Task Monki's diffs. Git quotes a path that holds a double quote, a
 * backslash or a control character, and with `core.quotePath` any byte past
 * ASCII, as a C string of escaped bytes; and it ends a `---` or `+++` path that
 * holds a space with a tab, so a patch tool reads it whole.
 */

const ESCAPED_BYTES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as Git wrote it, unquoted; a value that is not a quoted path is returned as it is. */
export function gitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const part of value.slice(1, -1).split(/(\\(?:[0-7]{3}|.))/su)) {
    if (!part.startsWith('\\')) {
      bytes.push(...encoder.encode(part));
      continue;
    }
    const byte = part.length === 4 ? Number.parseInt(part.slice(1), 8) : ESCAPED_BYTES[part.slice(1)];
    if (byte === undefined) return value;
    bytes.push(byte);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The path after a `---` or `+++` marker, without its `prefix`; nothing for /dev/null. */
export function diffSidePath(value: string, prefix: 'a/' | 'b/'): string | undefined {
  const path = gitPath(value.endsWith('\t') ? value.slice(0, -1) : value);
  if (path === '/dev/null') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * The base and head paths a `diff --git` line names, without `a/` and `b/`.
 * Unquoted, a path may hold " b/" itself: a file that kept its name reads as two
 * equal halves, as Git reads it.
 */
export function diffHeaderPaths(line: string): { oldPath: string; newPath: string } | undefined {
  if (!line.startsWith('diff --git ')) return undefined;
  const rest = line.slice('diff --git '.length);
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ' && rest.startsWith('a/') && rest.startsWith('b/', half + 1) && rest.slice(2, half) === rest.slice(half + 3)) {
    return { oldPath: rest.slice(2, half), newPath: rest.slice(2, half) };
  }
  const quoted = String.raw`"(?:[^"\\]|\\.)*"`;
  const paths = new RegExp(String.raw`^(${quoted}|a/.*?) (${quoted}|b/.*)$`, 'su').exec(rest);
  if (!paths) return undefined;
  const oldPath = gitPath(paths[1]!);
  const newPath = gitPath(paths[2]!);
  if (!oldPath.startsWith('a/') || !newPath.startsWith('b/')) return undefined;
  return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
}
