import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react';
import type {
  AttemptSummary,
  PreviewDescription,
  PreviewStatus
} from 'previewhost';
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Ellipsis,
  Pause,
  Play,
  Search
} from 'lucide-react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import {
  appendLogBuffer,
  failureWord,
  logSourceOrder,
  logLineKey,
  logLineText,
  markerText,
  splitApplicationLogs,
  type ApplicationLogBuffer,
  type ApplicationLogLine
} from '../../model/applicationPreviewLogs';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { applicationAttempts, previewRunRows, runTime } from '../../model/applicationPreviewRuns';
import { CopyGlyph, useCopied } from '../CopyIconButton';
import { ApplicationLogStream } from './ApplicationLogStream';
import { PanelResizeHandle } from '../PanelResizeHandle';
import { message } from './previewPresentation';

const TERMINAL_MARKERS = new Set([
  'failed',
  'succeeded',
  'stopped',
  'canceled',
  'cleanup-incomplete'
]);
/** One word for a run in the run menu; the Activity runs list carries the cause. */
function runWord(attempt: AttemptSummary, status?: PreviewStatus) {
  if (attempt.id === status?.active?.id) return 'serving';
  if (attempt.state === 'ready') return 'ready';
  return attempt.state === 'cleanup-incomplete' ? 'stopped' : attempt.state;
}
/**
 * Toolbar widths below which secondary controls move into the trailing menu:
 * the source menu, the narrowest search field and every inline control, plus
 * the run menu when there is more than one run.
 */
const TOOLBAR_FULL = 420;
const TOOLBAR_FULL_SEARCHING = 660;
const TOOLBAR_RUN_MENU = 120;
const SIDE_BY_SIDE_REASON = 'Choose two to four sources';
/** Smallest pane a seam can be dragged to. */
const MIN_COLUMN = 160;
const MIN_ROW = 120;
/** Surface widths below which side-by-side panes stack instead of splitting. */
const STACK_BELOW: Record<number, number> = { 2: 560, 3: 900, 4: 640 };

export interface LogSelection {
  attemptId: string;
  source?: string;
  failure?: boolean;
}
export function ApplicationLogs(props: {
  taskId: string;
  status?: PreviewStatus;
  selection?: LogSelection;
  active?: boolean;
  onSelect(value: LogSelection): void;
  onTaskAgent?(text: string): void;
}) {
  const attempts = applicationAttempts(props.status);
  const runs = previewRunRows(props.status, false);
  const runLabel = (attemptId: string) => {
    const run = runs.find((item) => item.attempt.id === attemptId);
    return run ? [run.outcome, run.cause].filter(Boolean).join(' · ') : attemptId;
  };
  const id =
    props.selection?.attemptId ??
    props.status?.candidate?.id ??
    props.status?.active?.id ??
    props.status?.latest?.id;
  const attempt = attempts.find((item) => item.id === id);
  if (!id || !attempt)
    return <p className="tm-application-preview__empty">No runs yet.</p>;
  return <RunLogs key={id} {...props} attempt={attempt} attempts={attempts} runLabel={runLabel} />;
}

function RunLogs({
  taskId,
  attempt,
  attempts,
  runLabel,
  status,
  selection,
  onSelect,
  active = true,
  onTaskAgent
}: {
  taskId: string;
  attempt: AttemptSummary;
  attempts: AttemptSummary[];
  /** Describes a run by outcome and cause; ids never appear. */
  runLabel(attemptId: string): string;
  status?: PreviewStatus;
  selection?: LogSelection;
  onSelect(value: LogSelection): void;
  active?: boolean;
  onTaskAgent?(text: string): void;
}) {
  const [buffer, setBuffer] = useState<ApplicationLogBuffer>({
    text: '',
    offset: 0,
    truncated: false
  });
  const [description, setDescription] = useState<PreviewDescription>();
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string[]>(
    selection?.source ? [selection.source] : []
  );
  const [sideBySide, setSideBySide] = useState(false);
  const [paused, setPaused] = useState<string[]>(
    selection?.failure
      ? ['all', ...(selection.source ? [selection.source] : [])]
      : []
  );
  const [query, setQuery] = useState('');
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [copied, copy] = useCopied();
  const [markers, setMarkers] = useState<ApplicationLogLine[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const toolbarWidth = useSize(toolbar)?.width;
  const surfaceSize = useSize(surface);
  const height = useRemainingHeight(surface, active);
  const activeRef = useRef(active);
  const readNow = useRef<() => void>(() => undefined);
  const stateRef = useRef<Record<string, string>>({});
  const bufferRef = useRef(buffer);
  activeRef.current = active;
  bufferRef.current = buffer;
  const fallbackSources = Object.entries(attempt.services ?? {})
    .filter(([, node]) =>
      ['command', 'worker', 'job', 'compose'].includes(node.type)
    )
    .map(([id]) => id)
    .sort();
  const ordered = logSourceOrder(description?.spec);
  const sources = ordered.length
    ? ordered
    : fallbackSources.length
      ? fallbackSources
      : [status?.name ?? 'Application'];
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  // Static and attached services can emit lifecycle lines too. Recognize their
  // framing without attributing those lines to the preceding process source.
  const framedSources = [...new Set([
    ...sources,
    ...Object.keys(attempt.services ?? {}),
    ...Object.keys(description?.spec.type === 'environment' ? description.spec.services : {})
  ])];
  const framedSourcesRef = useRef(framedSources);
  framedSourcesRef.current = framedSources;
  const displayName = (source: string) =>
    source === status?.name ? 'Application' : source;
  const chosen = sources.filter(
    (source) => !selected.length || selected.includes(source)
  );
  const sideBySideAvailable = chosen.length >= 2 && chosen.length <= 4;
  const side = sideBySide && sideBySideAvailable;
  const atPaneLimit = side && chosen.length >= 4;
  const stacked =
    side && !!surfaceSize && surfaceSize.width < STACK_BELOW[chosen.length]!;
  // Pane sizes belong to one set of chosen sources; choosing others starts equal.
  const splitKey = side ? chosen.join('\0') : '';
  const columnCount = chosen.length === 4 ? 2 : chosen.length;
  const [split, setSplit] = useState<{ key: string; columns?: number[]; row?: number }>();
  const columns =
    (split?.key === splitKey && split.columns) ||
    Array.from({ length: columnCount }, () => 1 / columnCount);
  const row = (split?.key === splitKey && split.row) || 0.5;
  const sourceState = (source: string) =>
    attempt.services?.[source]?.state ?? attempt.state;
  const stateWord = (source: string) => {
    const state = sourceState(source);
    if (state === 'failed') {
      const code = /exit(?:ed)?(?: with code)? \(?(\d+)\)?/i.exec(
        attempt.services?.[source]?.error?.message ?? ''
      )?.[1];
      return code ? `failed · exit ${code}` : 'failed';
    }
    return state === 'skipped'
      ? 'not started'
      : state === 'succeeded'
        ? 'done'
        : state;
  };
  useEffect(() => {
    let disposed = false;
    void api
      .inspectApplicationPreviewConfiguration({
        taskId,
        attemptId: attempt.id,
        changes: []
      })
      .then(
        (value) => {
          if (!disposed) setDescription(value.description);
        },
        () => undefined
      );
    return () => {
      disposed = true;
    };
  }, [taskId, attempt.id]);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let failed = false;
    let cursor: number | undefined;
    let current: ApplicationLogBuffer = {
      text: '',
      offset: 0,
      truncated: false
    };
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (
        disposed ||
        reading ||
        failed ||
        !activeRef.current ||
        document.visibilityState !== 'visible'
      )
        return;
      clearTimeout(timer);
      reading = true;
      try {
        const result = await api.readApplicationPreviewLogs({
          taskId,
          attemptId: attempt.id,
          after: cursor,
          maxBytes: 65_536
        });
        if (!disposed) {
          cursor = result.cursor;
          current = appendLogBuffer(current, result.text, framedSourcesRef.current);
          current.truncated ||= result.truncated;
          setBuffer(current);
          setError(undefined);
        }
      } catch (cause) {
        failed = true;
        if (!disposed) {
          const reason = message(cause);
          if (
            /ATTEMPT_EXPIRED|expired|no longer available|not available.*restart/i.test(
              reason
            )
          )
            setExpired(true);
          else setError(reason);
        }
      } finally {
        reading = false;
        if (!disposed && !failed && activeRef.current)
          timer = setTimeout(() => void read(), 750);
      }
    }
    const visible = () => {
      clearTimeout(timer);
      void read();
    };
    readNow.current = visible;
    setExpired(false);
    setError(undefined);
    void read();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      readNow.current = () => undefined;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [taskId, attempt.id, retry]);
  useEffect(() => {
    if (active) readNow.current();
  }, [active]);
  useEffect(() => {
    setSelected(selection?.source ? [selection.source] : []);
    setPaused(
      selection?.failure
        ? ['all', ...(selection.source ? [selection.source] : [])]
        : []
    );
  }, [selection]);
  useEffect(() => {
    const updates: ApplicationLogLine[] = [];
    const previous = stateRef.current;
    const initial = !Object.keys(previous).length;
    for (const source of sourcesRef.current) {
      const state = attempt.services?.[source]?.state ?? attempt.state;
      if (previous[source] === state) continue;
      // A finished step stays finished; a later "stopped" only reflects the environment going away.
      // "Stopped" is only worth a line when a live process was seen stopping.
      if (
        (previous[source] && TERMINAL_MARKERS.has(previous[source])) ||
        (state === 'stopped' && !['starting', 'ready'].includes(previous[source] ?? ''))
      ) {
        previous[source] = state;
        continue;
      }
      if (
        [
          'failed',
          'succeeded',
          'ready',
          'stopped',
          'canceled',
          'cleanup-incomplete'
        ].includes(state)
      ) {
        const exit =
          attempt.services?.[source]?.error?.message ??
          (source === status?.name ? attempt.error?.message : undefined);
        updates.push({
          id: bufferRef.current.offset + bufferRef.current.text.length,
          source,
          marker: state,
          text: displayName(source),
          detail: `${exit ? ` · ${failureWord(exit)}` : ''}${initial ? '' : ` · observed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}`
        });
      }
      previous[source] = state;
    }
    if (updates.length)
      setMarkers((value) => [...value, ...updates].slice(-128));
  }, [attempt, status?.name]);
  const lines = useMemo(() => {
    const rows = splitApplicationLogs(
      buffer.text,
      framedSources,
      buffer.source,
      buffer.offset
    );
    // Markers whose output was evicted stay at the top, in observed order.
    let orphans = 0;
    for (const marker of markers) {
      if (TERMINAL_MARKERS.has(marker.marker ?? '')) {
        // Status can arrive before the final log read. Keep terminal markers
        // after their source's output as that tail arrives.
        let lastSource = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.source === marker.source) {
            lastSource = i;
            break;
          }
        }
        rows.splice(lastSource === -1 ? orphans++ : lastSource + 1, 0, marker);
      } else {
        // A service that keeps running keeps its marker where it was observed.
        const at = rows.findIndex((row) => !row.marker && row.id >= marker.id);
        rows.splice(at === -1 ? rows.length : at, 0, marker);
      }
    }
    return rows;
  }, [buffer, framedSources.join('\0'), markers]);
  const visible = lines.filter(
    (line) => chosen.includes(line.source) || (!line.source && !selected.length)
  );
  // Rows as the streams render them: the display name is part of a row's
  // identity and of a marker's text.
  const shown = (line: ApplicationLogLine): ApplicationLogLine => ({
    ...line,
    source: displayName(line.source)
  });
  // One match list in reading order: the combined stream, or pane by pane.
  // Markers are searched as displayed, the same text Copy writes.
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    if (!needle) return [];
    const result: Array<{ key: string; occurrence: number; source: string }> = [];
    const orderedLines = side
      ? chosen.flatMap((source) =>
          visible.filter((line) => line.source === source)
        )
      : visible;
    for (const line of orderedLines) {
      const text = logLineText(line).toLowerCase();
      const key = logLineKey(shown(line));
      let occurrence = 0;
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length))
        result.push({ key, occurrence: occurrence++, source: line.source });
    }
    return result;
  }, [query, lines, chosen.join('\0'), side, selected.length]);
  function follow(source: string, value: boolean) {
    followAll([source], value);
  }
  function followAll(keys: string[], value: boolean) {
    setPaused((current) =>
      value
        ? current.filter((item) => !keys.includes(item))
        : [...new Set([...current, ...keys])]
    );
  }
  function navigateMatch(direction: number) {
    if (!matches.length) return;
    const index = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index);
    follow(side ? matches[index]!.source : 'all', false);
  }
  function choose(next: string[]) {
    setMatchIndex(-1);
    setSelected(next.length === sources.length ? [] : next);
    // Panes follow the chosen sources; outside two to four there is nothing to split.
    if (next.length < 2 || next.length > 4) setSideBySide(false);
  }
  function toggleSource(source: string) {
    const next = chosen.includes(source)
      ? chosen.filter((item) => item !== source)
      : sources.filter((item) => item === source || chosen.includes(item));
    if (next.length) choose(next);
  }
  const keep = (line: ApplicationLogLine) =>
    !matchesOnly || logLineText(line).toLowerCase().includes(query.toLowerCase());
  const singleFailed =
    chosen.length === 1 && sourceState(chosen[0]!) === 'failed';
  // Size the lane column for the sources that have output in view, not for
  // every chosen source.
  const laneSources = new Set<string>();
  for (const line of visible) if (!line.marker) laneSources.add(line.source);
  const laneWidth = Math.min(
    16,
    Math.max(4, ...[...laneSources].map((source) => displayName(source).length))
  );
  const hasOutput = visible.some((line) => !line.marker);
  const surfaceEmpty = expired
    ? 'Logs for this run expired when the runtime restarted.'
    : hasOutput
      ? undefined
      : singleFailed
        ? `No output from ${displayName(chosen[0]!)}.`
        : chosen.length === 1 &&
            ['waiting', 'skipped'].includes(sourceState(chosen[0]!))
          ? `${displayName(chosen[0]!)} has not started.`
          : 'No output yet.';
  const followKeys = side ? chosen : ['all'];
  const allPaused = followKeys.every((key) => paused.includes(key));
  const followLabel = side
    ? allPaused ? 'Resume all logs' : 'Pause all logs'
    : allPaused ? 'Resume logs' : 'Pause logs';
  const full =
    toolbarWidth === undefined ||
    toolbarWidth >=
      (query ? TOOLBAR_FULL_SEARCHING : TOOLBAR_FULL) +
        (attempts.length > 1 ? TOOLBAR_RUN_MENU : 0);
  function toggleSideBySide() {
    if (sideBySideAvailable) setSideBySide(!side);
  }
  function copyVisible() {
    copy(
      visible
        .filter(keep)
        .map((line) => `[${displayName(line.source)}] ${line.marker ? markerText(line) : line.text}`)
        .join('\n')
    );
  }
  const more: ActionMenuItem[] = [
    ...(!full && sources.length > 1
      ? [{
          label: 'Side by side',
          pressed: side,
          disabled: !sideBySideAvailable,
          disabledReason: SIDE_BY_SIDE_REASON,
          onSelect: toggleSideBySide
        }]
      : []),
    ...(!full && query
      ? [{ label: 'Matches only', pressed: matchesOnly, onSelect: () => setMatchesOnly((value) => !value) }]
      : []),
    ...(!full ? [{ label: 'Copy visible logs', onSelect: copyVisible }] : []),
    ...(singleFailed && onTaskAgent
      ? [{
          label: 'Send last 40 lines to task agent',
          separated: true,
          onSelect: () =>
            onTaskAgent(
              `Investigate Preview run ${runTime(attempt.startedAt)} (${runLabel(attempt.id)}), service ${displayName(chosen[0]!)}. Review before making changes.\n${visible
                .filter((line) => line.source === chosen[0] && !line.marker)
                .slice(-40)
                .map((line) => line.text)
                .join('\n')}`
            )
        }]
      : [])
  ];
  return (
    <div
      ref={panel}
      className="tm-preview-logs"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'f'
        ) {
          event.preventDefault();
          search.current?.focus();
          search.current?.select();
        }
      }}
    >
      <div ref={toolbar} className="tm-preview-logs__toolbar">
        {attempts.length > 1 ? (
          <ActionMenu
            className="tm-preview-log-menu"
            label="Log run"
            selection="single"
            align="start"
            side="bottom"
            trigger={<><span>{attempt.id === status?.active?.id ? 'Current run' : runTime(attempt.startedAt)}</span><ChevronDown size={14} aria-hidden="true" /></>}
            items={attempts.map((item) => ({
              id: item.id,
              label: runTime(item.startedAt),
              meta: runWord(item, status),
              metaTone: item.state === 'failed' ? ('blocked' as const) : undefined,
              pressed: item.id === attempt.id,
              onSelect: () => onSelect({ attemptId: item.id })
            }))}
          />
        ) : null}
        {sources.length > 1 ? (
          <ActionMenu
            className="tm-preview-log-menu"
            label="Log sources"
            align="start"
            side="bottom"
            closeOnSelect={false}
            note={atPaneLimit ? 'Side by side shows up to four sources.' : undefined}
            trigger={<><span>{chosen.length === sources.length ? 'All sources' : chosen.length === 1 ? displayName(chosen[0]!) : `${chosen.length} sources`}</span><ChevronDown size={14} aria-hidden="true" /></>}
            items={[
              {
                label: 'All sources',
                pressed: !selected.length,
                onSelect: () => choose(sources)
              },
              ...sources.map((source, index) => ({
                id: `source:${source}`,
                label: displayName(source),
                meta: stateWord(source),
                metaTone: sourceState(source) === 'failed' ? ('blocked' as const) : undefined,
                separated: index === 0,
                pressed: chosen.includes(source),
                disabled: chosen.includes(source) ? chosen.length === 1 : atPaneLimit,
                disabledReason: chosen.includes(source) ? 'Keep at least one source selected.' : undefined,
                onSelect: () => toggleSource(source)
              }))
            ]}
          />
        ) : null}
        <label className="field field--search tm-preview-log-search">
          <Search aria-hidden="true" />
          <input
            ref={search}
            type="search"
            aria-label="Search logs"
            placeholder="Search logs"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchesOnly(false);
              setMatchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                navigateMatch(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
                setMatchesOnly(false);
                setMatchIndex(-1);
                panel.current
                  ?.querySelector<HTMLElement>('.tm-preview-stream')
                  ?.focus();
              }
            }}
          />
        </label>
        <div className="tm-preview-logs__tools">
          {query ? (
            <span className="tm-preview-logs__matches">
              <span className="tm-preview-log-count" aria-live="polite">
                {matches.length
                  ? `${matchIndex < 0 ? 0 : (matchIndex % matches.length) + 1} of ${matches.length}`
                  : 'No matches'}
              </span>
              <button
                type="button"
                className="ghost-button tm-preview-log-icon"
                aria-label="Previous log match"
                title="Previous match (Shift+Enter)"
                onClick={() => navigateMatch(-1)}
                disabled={!matches.length}
              >
                <ChevronUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ghost-button tm-preview-log-icon"
                aria-label="Next log match"
                title="Next match (Enter)"
                onClick={() => navigateMatch(1)}
                disabled={!matches.length}
              >
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              {full ? (
                <button
                  type="button"
                  className="ghost-button"
                  aria-pressed={matchesOnly}
                  onClick={() => setMatchesOnly((value) => !value)}
                >
                  Matches only
                </button>
              ) : null}
            </span>
          ) : null}
          {full && sources.length > 1 ? (
            <button
              type="button"
              className="ghost-button tm-preview-log-icon"
              aria-pressed={side}
              aria-disabled={!sideBySideAvailable || undefined}
              aria-label="Side by side"
              title={sideBySideAvailable ? 'Side by side' : SIDE_BY_SIDE_REASON}
              onClick={toggleSideBySide}
            >
              <Columns2 size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-button tm-preview-log-icon"
            aria-label={followLabel}
            title={followLabel}
            onClick={() => followAll(followKeys, allPaused)}
          >
            {allPaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          </button>
          {full ? (
            <button
              type="button"
              className="ghost-button tm-preview-log-icon"
              aria-label="Copy visible logs"
              title={copied ? 'Copied' : 'Copy visible logs'}
              onClick={copyVisible}
            >
              <CopyGlyph copied={copied} />
            </button>
          ) : null}
          {more.length ? (
            <ActionMenu
              className="tm-preview-log-more"
              label="More log actions"
              side="bottom"
              trigger={<Ellipsis size={16} aria-hidden="true" />}
              items={more}
            />
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="form-error tm-preview-logs__error">
          {error}{' '}
          <button
            type="button"
            className="ghost-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Reconnect logs
          </button>
        </p>
      ) : null}
      <div
        ref={surface}
        className={`tm-preview-log-surface${side ? ` tm-preview-log-surface--${chosen.length}` : ''}${stacked ? ' tm-preview-log-surface--stacked' : ''}`}
        style={{
          ['--lane' as string]: `${laneWidth}ch`,
          ...(height ? { height } : {}),
          ...(side && !stacked
            ? {
                gridTemplateColumns: columns.map((size) => `minmax(0, ${size}fr)`).join(' '),
                ...(chosen.length === 4
                  ? { gridTemplateRows: `minmax(0, ${row}fr) minmax(0, ${1 - row}fr)` }
                  : {})
              }
            : {})
        }}
      >
        {expired
          ? null
          : (side ? chosen : ['all']).map((source) => (
              <section
                key={source}
                className="tm-preview-log-pane"
                aria-label={
                  side ? `${displayName(source)} log pane` : 'Combined log pane'
                }
              >
                {side ? (
                  <header className="tm-preview-log-pane__head">
                    <span className="tm-preview-log-pane__name">{displayName(source)}</span>
                    <span className="tm-preview-log-pane__state" data-state={sourceState(source)}>
                      {stateWord(source)}
                    </span>
                    <button
                      type="button"
                      className="ghost-button tm-preview-log-icon tm-preview-log-icon--compact"
                      aria-label={`${paused.includes(source) ? 'Resume' : 'Pause'} ${displayName(source)} logs`}
                      title={paused.includes(source) ? 'Resume logs' : 'Pause logs'}
                      onClick={() => follow(source, paused.includes(source))}
                    >
                      {paused.includes(source) ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                    </button>
                  </header>
                ) : null}
                <ApplicationLogStream
                  name={side ? displayName(source) : 'Application'}
                  lines={(side
                    ? visible.filter((line) => line.source === source)
                    : visible
                  )
                    .filter(keep)
                    .map(shown)}
                  lanes={!side && chosen.length > 1}
                  query={query}
                  currentMatch={
                    matchIndex >= 0
                      ? matches[matchIndex % matches.length]
                      : undefined
                  }
                  follow={!paused.includes(source)}
                  onFollow={(value) => follow(source, value)}
                  truncated={buffer.truncated}
                  failureTarget={
                    selection?.failure
                      ? `${selection.attemptId}:${selection.source}`
                      : undefined
                  }
                  active={active}
                />
              </section>
            ))}
        {side && !stacked && !expired && surfaceSize
          ? columns.slice(0, -1).map((_, seam) => {
              const width = surfaceSize.width;
              const before = columns.slice(0, seam).reduce((sum, size) => sum + size, 0);
              const pair = columns[seam]! + columns[seam + 1]!;
              const at = (before + columns[seam]!) * width;
              const min = Math.min(at, before * width + MIN_COLUMN);
              const max = Math.max(at, (before + pair) * width - MIN_COLUMN);
              return (
                <PanelResizeHandle
                  key={`column:${seam}`}
                  className="tm-preview-log-resize"
                  style={{ left: at }}
                  label={
                    chosen.length === 4
                      ? 'Resize log columns'
                      : `Resize ${displayName(chosen[seam]!)} and ${displayName(chosen[seam + 1]!)} panes`
                  }
                  value={at}
                  min={min}
                  max={max}
                  defaultValue={(before + pair / 2) * width}
                  onChange={(value) => {
                    const next = [...columns];
                    next[seam] = value / width - before;
                    next[seam + 1] = before + pair - value / width;
                    setSplit({ key: splitKey, columns: next, row });
                  }}
                  onReset={() => setSplit({ key: splitKey, row })}
                />
              );
            })
          : null}
        {side && !stacked && !expired && surfaceSize && chosen.length === 4 ? (
          <PanelResizeHandle
            className="tm-preview-log-resize tm-preview-log-resize--rows"
            orientation="horizontal"
            style={{ top: row * surfaceSize.height }}
            label="Resize log rows"
            value={row * surfaceSize.height}
            min={Math.min(row * surfaceSize.height, MIN_ROW)}
            max={Math.max(row * surfaceSize.height, surfaceSize.height - MIN_ROW)}
            defaultValue={surfaceSize.height / 2}
            onChange={(value) =>
              setSplit({ key: splitKey, columns, row: value / surfaceSize.height })
            }
            onReset={() => setSplit({ key: splitKey, columns })}
          />
        ) : null}
        {surfaceEmpty ? (
          <p className="tm-preview-log-surface__empty">{surfaceEmpty}</p>
        ) : null}
      </div>
    </div>
  );
}

/** The element's content size, observed; undefined until measured. */
function useSize(element: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry!.contentRect.width);
      const height = Math.round(entry!.contentRect.height);
      // A hidden tab measures zero; keep the last real layout.
      if (width > 0)
        setSize((current) =>
          current?.width === width && current.height === height ? current : { width, height }
        );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * Height that lets the log surface end at the bottom of its scroll owner, so the
 * streams scroll instead of the page. Undefined leaves the stylesheet's clamp.
 */
function useRemainingHeight(element: RefObject<HTMLElement | null>, active: boolean) {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = element.current;
    if (!active || !node || typeof ResizeObserver === 'undefined') return;
    let owner = node.parentElement;
    while (owner && !/(auto|scroll)/.test(getComputedStyle(owner).overflowY))
      owner = owner.parentElement;
    if (!owner) return;
    const scroller = owner;
    const measure = () => {
      if (!node.getClientRects().length) return;
      const top =
        node.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        scroller.clientTop +
        scroller.scrollTop;
      // Space the layout keeps below the surface: following content, gaps and
      // padding of every container up to the scroll owner. Free space from a
      // stretched container is not counted, so this cannot feed back on itself.
      let below = 0;
      for (let child: Element = node; child !== scroller && child.parentElement; child = child.parentElement) {
        const parent = child.parentElement;
        const bottom = child.getBoundingClientRect().bottom;
        let end = bottom + (parseFloat(getComputedStyle(child).marginBottom) || 0);
        for (let next = child.nextElementSibling; next; next = next.nextElementSibling) {
          const style = getComputedStyle(next);
          if (!next.getClientRects().length || style.position === 'absolute' || style.position === 'fixed') continue;
          end = Math.max(end, next.getBoundingClientRect().bottom + (parseFloat(style.marginBottom) || 0));
        }
        const style = getComputedStyle(parent);
        below +=
          end - bottom +
          (parseFloat(style.paddingBottom) || 0) +
          (parent === scroller ? 0 : parseFloat(style.borderBottomWidth) || 0);
      }
      setHeight(Math.max(280, Math.floor(scroller.clientHeight - top - below)));
    };
    measure();
    // Content above the surface moves it without resizing it; every container
    // up to the scroll owner changes size when that happens.
    const observer = new ResizeObserver(measure);
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent);
      if (parent === scroller) break;
    }
    return () => observer.disconnect();
  }, [element, active]);
  return height;
}
