const WORD_OVERRIDES = new Map<string, string>([
  ['api', 'API'],
  ['ci', 'CI'],
  ['gh', 'GitHub'],
  ['id', 'ID'],
  ['json', 'JSON'],
  ['mcp', 'MCP'],
  ['pr', 'PR'],
  ['sha', 'SHA'],
  ['url', 'URL']
]);

export function humanizeEnum(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '—';
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const override = WORD_OVERRIDES.get(lower);
      if (override) {
        return override;
      }
      return index === 0 ? capitalize(lower) : lower;
    })
    .join(' ');
}

export function formatStatusValue(value: string): string {
  if (value === '—') {
    return value;
  }
  if (looksLikeInternalEnum(value)) {
    return humanizeEnum(value);
  }
  return value;
}

/** "file" or "files", for a count. */
export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** "1 file" or "3 files". */
export function pluralize(count: number, word: string): string {
  return `${count} ${plural(count, word)}`;
}

/** A commit hash shortened the way Git shows it. */
export function shortSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function looksLikeInternalEnum(value: string): boolean {
  return value.includes('_') || /^[A-Z]+$/.test(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A base the pull request fell behind or conflicts with, as the Now panel, the record and the Inbox say it. */
export function baseMovedLine(reason: 'BEHIND' | 'CONFLICTS', base: string | undefined): string {
  if (reason === 'CONFLICTS') return base ? `Conflicts with ${base}` : 'Conflicts';
  return base ? `Behind ${base}` : 'Behind its base';
}

/** Names as a sentence lists them: "alice", "alice and bob", "alice, bob and 2 more". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** Where a comment points in the diff, as the agent and the person read it. */
export function formatCommentLocation(comment: { path: string; side?: 'NEW' | 'OLD'; line?: number; endLine?: number }): string {
  if (!comment.line) return `${comment.path} (whole file)`;
  const lines = comment.endLine && comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
  return comment.side === 'OLD'
    ? `${comment.path} (removed line${comment.endLine && comment.endLine > comment.line ? 's' : ''} ${lines})`
    : `${comment.path}:${lines}`;
}

/**
 * A person's initials for their avatar, from a name or an account: "Rojhat
 * Toptamus" and "RojhatToptamus" read RT, "github-actions[bot]" GA, "octocat" O.
 */
export function personInitials(name: string | undefined): string {
  const words = (name ?? '')
    .replace(/\[bot\]$/iu, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .split(/[\s._-]+/u)
    .filter(Boolean);
  return words.slice(0, 2).map((word) => [...word][0]!.toUpperCase()).join('') || '?';
}
