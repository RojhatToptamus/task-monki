import type { MouseEvent } from 'react';
import type { DiffLine } from '../model/diffEvidence';

/** Shared line presentation for Evidence and configuration review. */
export function DiffLines({ lines, path, onOpenPathMenu }: {
  lines: DiffLine[];
  path?: string;
  onOpenPathMenu?(relativePath: string, event: MouseEvent, line?: number): void;
}) {
  return <div className="tm-difflines">
    {lines.filter(line => line.kind !== 'meta').map((line, index) => line.kind === 'hunk'
      ? <DiffHunkRow key={index} line={line} />
      : <DiffLineRow key={index} line={line} path={path} onOpenPathMenu={onOpenPathMenu} />)}
  </div>;
}

function DiffHunkRow({ line }: { line: DiffLine }) {
  return (
    <div className="tm-diffhunk">
      <code>{line.content}</code>
    </div>
  );
}

function DiffLineRow({
  line,
  path,
  onOpenPathMenu
}: {
  line: DiffLine;
  path?: string;
  onOpenPathMenu?(relativePath: string, event: MouseEvent, line?: number): void;
}) {
  const code = diffLineCode(line);
  const targetLine = line.newLine ?? line.oldLine;
  return (
    <div
      className={`tm-diffline tm-diffline--${line.kind}`}
      onContextMenu={(event) => path && onOpenPathMenu?.(path, event, targetLine)}
    >
      <span className="tm-diffline__num">{line.oldLine ?? ''}</span>
      <span className="tm-diffline__num">{line.newLine ?? ''}</span>
      <code>{code || ' '}</code>
    </div>
  );
}

function diffLineCode(line: DiffLine): string {
  if (line.kind === 'addition' && line.content.startsWith('+')) {
    return line.content.slice(1);
  }
  if (line.kind === 'deletion' && line.content.startsWith('-')) {
    return line.content.slice(1);
  }
  if (line.kind === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1);
  }
  return line.content;
}
