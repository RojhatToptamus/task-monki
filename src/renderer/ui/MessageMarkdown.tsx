import { memo, type ReactNode } from 'react';

type MarkdownBlock =
  | { kind: 'paragraph' | 'quote'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** Parsed again only when its text changes: threads and conversations render it for every message. */
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="tm-message-markdown">
      {parseBlocks(text).map((block, index) => {
        const key = `${block.kind}:${index}`;
        switch (block.kind) {
          case 'heading':
            return block.level <= 2
              ? <h3 key={key}>{renderInline(block.text)}</h3>
              : <h4 key={key}>{renderInline(block.text)}</h4>;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return <Tag key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</Tag>;
          }
          case 'quote':
            return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
          case 'code':
            return <pre key={key}><code>{block.text}</code></pre>;
          case 'paragraph':
            return <p key={key}>{renderInline(block.text)}</p>;
          case 'table':
            // A wide table scrolls inside its own frame rather than widening the message.
            return (
              <div key={key} className="tm-message-markdown__table">
                <table>
                  <thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>{block.header.map((_cell, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});

function parseBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^```/u.test(line.trimStart())) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!.trimStart())) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    // A GitHub table: a row of cells, then its separator row.
    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? '')) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(tableCells(lines[index]!));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      const quoted = [quote[1]!];
      index += 1;
      while (index < lines.length) {
        const next = /^>\s?(.*)$/u.exec(lines[index]!);
        if (!next) break;
        quoted.push(next[1]!);
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quoted.join(' ') });
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/u.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items = [(ordered ?? unordered)![1]!];
      index += 1;
      while (index < lines.length) {
        const next = isOrdered
          ? /^\d+[.)]\s+(.+)$/u.exec(lines[index]!)
          : /^[-*+]\s+(.+)$/u.exec(lines[index]!);
        if (!next) break;
        items.push(next[1]!);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/u.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line);
}

/** A row's cells, an escaped pipe kept as text. */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.replace(/\\\|/gu, '|').trim());
}

function startsBlock(line: string): boolean {
  return /^```/u.test(line.trimStart()) ||
    isTableRow(line) ||
    /^(#{1,4})\s+/u.test(line) ||
    /^>\s?/u.test(line) ||
    /^[-*+]\s+/u.test(line) ||
    /^\d+[.)]\s+/u.test(line);
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^\s)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/gu;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const start = match.index;
    if (start > offset) parts.push(text.slice(offset, start));
    const token = match[0];
    const key = `${start}:${token}`;
    if (token.startsWith('`')) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)!;
      parts.push(isSafeLink(link[2]!)
        ? <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : link[1]);
    } else {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    offset = start + token.length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value);
    // Match the Electron shell's external-link policy exactly. Renderer links
    // must never advertise a destination that the hardened window will deny.
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
