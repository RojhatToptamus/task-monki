import { useLayoutEffect, useRef } from 'react';
import type { ApplicationLogLine } from '../../model/applicationPreviewLogs';

export function ApplicationLogStream({
  name,
  lines,
  lanes,
  query,
  matchesOnly,
  currentMatch,
  follow,
  onFollow,
  truncated,
  expired,
  empty,
  failureTarget,
  active
}: {
  name: string;
  lines: ApplicationLogLine[];
  lanes: boolean;
  query: string;
  matchesOnly: boolean;
  currentMatch?: { line: number; occurrence: number };
  follow: boolean;
  onFollow(value: boolean): void;
  truncated: boolean;
  expired: boolean;
  empty: string;
  failureTarget?: string;
  active: boolean;
}) {
  const stream = useRef<HTMLDivElement>(null);
  const lastSeen = useRef(lines.at(-1)?.id ?? 0);
  const jump = useRef<string | undefined>(undefined);
  const navigationScroll = useRef<number | undefined>(undefined);
  const following = useRef(follow);
  following.current = follow;
  const latest = lines.at(-1)?.id ?? 0;
  const newLines = follow
    ? 0
    : lines.filter((line) => line.id > lastSeen.current).length;
  const matchKey = currentMatch
    ? `${currentMatch.line}:${currentMatch.occurrence}`
    : undefined;
  useLayoutEffect(() => {
    if (!active || !stream.current) return;
    if (follow) {
      stream.current.scrollTop = stream.current.scrollHeight;
      lastSeen.current = latest;
    }
  }, [latest, follow, active, lines]);
  useLayoutEffect(() => {
    if (!active || !stream.current || !currentMatch) return;
    const match = stream.current.querySelector<HTMLElement>('[data-current-match="true"]');
    if (match) reveal(match);
  }, [matchKey, active]);
  useLayoutEffect(() => {
    if (!active || !failureTarget || jump.current === failureTarget) return;
    // Wait for captured output before jumping; an empty stream is already at
    // its marker, and its first read may still be in flight.
    if (!lines.some(line => !line.marker)) return;
    const marker = stream.current?.querySelector<HTMLElement>(
      '[data-failure="true"]'
    );
    if (marker) {
      reveal(marker);
      jump.current = failureTarget;
    }
  }, [failureTarget, lines, active]);
  function reveal(element: HTMLElement) {
    const node = stream.current!;
    const before = node.scrollTop;
    element.scrollIntoView({ block: 'center' });
    // A navigation scroll is not the user's request to resume at the end.
    if (node.scrollTop !== before) navigationScroll.current = node.scrollTop;
  }
  function changeFollow(value: boolean) {
    if (!value && following.current) lastSeen.current = latest;
    onFollow(value);
  }
  function highlight(line: ApplicationLogLine) {
    const needle = query.toLowerCase();
    const text = line.text.replaceAll('[REDACTED]', '[redacted]');
    if (!needle) return text;
    const parts: React.ReactNode[] = [];
    let from = 0;
    let occurrence = 0;
    let index: number;
    while ((index = text.toLowerCase().indexOf(needle, from)) !== -1) {
      parts.push(text.slice(from, index));
      const current =
        currentMatch?.line === line.id &&
        currentMatch.occurrence === occurrence;
      parts.push(
        <mark
          key={`${line.id}:${occurrence}`}
          data-current-match={current || undefined}
        >
          {text.slice(index, index + needle.length)}
        </mark>
      );
      occurrence++;
      from = index + needle.length;
    }
    parts.push(text.slice(from));
    return parts;
  }
  return (
    <div className="tm-preview-stream-wrap">
      <div
        ref={stream}
        className={`tm-preview-stream ${lanes ? 'tm-preview-stream--lanes' : ''}`}
        role="region"
        aria-label={`${name} logs`}
        tabIndex={0}
        onCopy={(event) => {
          const selection = window.getSelection();
          if (!selection?.rangeCount || selection.isCollapsed) return;
          const range = selection.getRangeAt(0);
          const copied: string[] = [];
          for (const row of event.currentTarget.querySelectorAll<HTMLElement>(
            '[data-log-source]'
          )) {
            const content = row.querySelector('.tm-preview-log-message') ?? row;
            if (!range.intersectsNode(content)) continue;
            const part = document.createRange();
            part.selectNodeContents(content);
            if (content.contains(range.startContainer))
              part.setStart(range.startContainer, range.startOffset);
            if (content.contains(range.endContainer))
              part.setEnd(range.endContainer, range.endOffset);
            copied.push(`[${row.dataset.logSource}] ${part.toString()}`);
          }
          if (copied.length) {
            event.preventDefault();
            event.clipboardData.setData('text/plain', copied.join('\n'));
          }
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          const navigatedTo = navigationScroll.current;
          navigationScroll.current = undefined;
          if (navigatedTo !== undefined && Math.abs(node.scrollTop - navigatedTo) < 1) return;
          const atEnd =
            node.scrollHeight - node.scrollTop - node.clientHeight <= 30;
          if (atEnd !== following.current) changeFollow(atEnd);
        }}
        onKeyDown={(event) => {
          if (event.key === 'End') {
            event.preventDefault();
            onFollow(true);
            event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
          }
          if (event.key === 'Home') {
            event.preventDefault();
            changeFollow(false);
            event.currentTarget.scrollTop = 0;
          }
        }}
      >
        {truncated ? (
          <p className="tm-preview-log-marker">
            Earlier output evicted · 64 KB limit
          </p>
        ) : null}
        {expired ? (
          <p className="tm-preview-log-marker">
            Logs for this run expired when the runtime restarted.
          </p>
        ) : null}
        {!expired && !lines.length ? <p>{empty}</p> : null}
        {lines
          .filter(
            (line) =>
              !matchesOnly ||
              line.marker ||
              line.text.toLowerCase().includes(query.toLowerCase())
          )
          .map((line) => (
            <div
              key={`${line.marker ?? 'line'}:${line.id}:${line.source}`}
              className={
                line.marker ? 'tm-preview-log-marker' : 'tm-preview-log-line'
              }
              data-failure={line.marker === 'failed' || undefined}
              data-log-source={line.source}
            >
              {line.marker ? (
                <span data-state={line.marker}>{line.text}</span>
              ) : (
                <>
                  {lanes ? (
                    <span className="tm-preview-log-lane" title={line.source}>
                      {line.source}
                    </span>
                  ) : null}
                  <span className="tm-preview-log-message">
                    {highlight(line)}
                  </span>
                </>
              )}
            </div>
          ))}
      </div>
      {!follow ? (
        <button
          className="tm-preview-follow outline-button"
          onClick={() => onFollow(true)}
        >
          {newLines ? `${newLines} new lines · ` : ''}Resume follow
        </button>
      ) : null}
    </div>
  );
}
