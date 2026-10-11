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
