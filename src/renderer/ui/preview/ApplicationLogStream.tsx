import { useLayoutEffect, useReducer, useRef } from 'react';
import { ArrowDown } from 'lucide-react';
import {
  logLineKey,
  markerWord,
  type ApplicationLogLine
} from '../../model/applicationPreviewLogs';

export function ApplicationLogStream({
  name,
  lines,
  lanes,
  query,
  currentMatch,
  follow,
  onFollow,
  truncated,
  failureTarget,
  active
}: {
  name: string;
  lines: ApplicationLogLine[];
  lanes: boolean;
  query: string;
  /** The current search match: the row's `logLineKey` and its occurrence. */
  currentMatch?: { key: string; occurrence: number };
  follow: boolean;
  onFollow(value: boolean): void;
  truncated: boolean;
  failureTarget?: string;
  active: boolean;
}) {
  const stream = useRef<HTMLDivElement>(null);
  // Markers keep the offset at which they were observed, so the last row is not
  // necessarily the newest output.
  const latest = lines.reduce((max, line) => Math.max(max, line.id), 0);
  const lastSeen = useRef(latest);
  const [, seen] = useReducer((value: number) => value + 1, 0);
  const jump = useRef<string | undefined>(undefined);
  const navigationScroll = useRef<number | undefined>(undefined);
  const following = useRef(follow);
  following.current = follow;
  const newLines = follow
    ? 0
    : lines.filter((line) => line.id > lastSeen.current).length;
  const matchKey = currentMatch
    ? `${currentMatch.key}#${currentMatch.occurrence}`
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
    // Scroll only the stream: scrollIntoView would also move the page around it.
    const node = stream.current!;
    const before = node.scrollTop;
    const nodeTop = node.getBoundingClientRect().top;
    const elementTop = element.getBoundingClientRect().top - nodeTop + node.scrollTop;
    node.scrollTop = Math.max(
      0,
      elementTop - node.clientHeight / 2 + element.offsetHeight / 2
    );
    // A navigation scroll is not the user's request to resume at the end.
    if (node.scrollTop !== before) navigationScroll.current = node.scrollTop;
    // Output already present when the view moved to it is not new.
    if (lastSeen.current !== latest) {
      lastSeen.current = latest;
      seen();
    }
  }
  function changeFollow(value: boolean) {
    if (!value && following.current) lastSeen.current = latest;
    onFollow(value);
  }
  /**
   * Marks every occurrence of the query across a row's visible parts. A row is
   * searched as one string, so a match may cross from a marker's name into its
   * state word; occurrences are numbered the same way the parent counts them.
   */
  function highlight(line: ApplicationLogLine, parts: string[]): React.ReactNode[][] {
    const needle = query.toLowerCase();
    const ranges: Array<[number, number]> = [];
    if (needle) {
      const lower = parts.join('').toLowerCase();
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length))
        ranges.push([at, at + needle.length]);
    }
    const key = logLineKey(line);
    let offset = 0;
    return parts.map((part) => {
      const start = offset;
      offset += part.length;
      const nodes: React.ReactNode[] = [];
      let cursor = 0;
      ranges.forEach(([from, to], occurrence) => {
        const begin = Math.max(from, start) - start;
        const end = Math.min(to, offset) - start;
        if (begin >= end) return;
        nodes.push(part.slice(cursor, begin));
        nodes.push(
          <mark
            key={`${occurrence}:${begin}`}
            data-current-match={
              (currentMatch?.key === key && currentMatch.occurrence === occurrence) || undefined
            }
          >
            {part.slice(begin, end)}
          </mark>
        );
        cursor = end;
      });
      nodes.push(part.slice(cursor));
      return nodes;
    });
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
            <span>Earlier output evicted · 64 KB limit</span>
          </p>
        ) : null}
        {lines.map((line) => (
          <div
            key={logLineKey(line)}
            className={
              line.marker ? 'tm-preview-log-marker' : 'tm-preview-log-line'
            }
            data-failure={line.marker === 'failed' || undefined}
            data-log-source={line.source}
          >
            {line.marker ? (
              <Marker line={line} parts={highlight(line, [line.text, ' ', markerWord(line.marker), line.detail ?? ''])} />
            ) : (
              <>
                {lanes ? (
                  <span className="tm-preview-log-lane" title={line.source}>
                    {line.source}
                  </span>
                ) : null}
                <span className="tm-preview-log-message">
                  {highlight(line, [line.text.replaceAll('[REDACTED]', '[redacted]')])[0]}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {!follow && newLines > 0 ? (
        <button
          type="button"
          className="tm-preview-follow ghost-button"
          onClick={() => onFollow(true)}
        >
          <ArrowDown size={13} aria-hidden="true" />
          {newLines} new {newLines === 1 ? 'line' : 'lines'}
        </button>
      ) : null}
    </div>
  );
}

/** A status marker: the source name, its state word and the observed detail. */
function Marker({ line, parts }: { line: ApplicationLogLine; parts: React.ReactNode[][] }) {
  const [name, space, word, detail] = parts;
  return (
    <span>
      {name}
      {space}
      <b data-state={line.marker}>{word}</b>
      {line.detail ? <i>{detail}</i> : null}
    </span>
  );
}
