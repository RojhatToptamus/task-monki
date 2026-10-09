import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  AttemptSummary,
  PreviewDescription,
  PreviewStatus
} from 'previewhost';
import { Search } from 'lucide-react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import {
  appendLogBuffer,
  splitApplicationLogs,
  logSourceOrder,
  type ApplicationLogBuffer,
  type ApplicationLogLine
} from '../../model/applicationPreviewLogs';
import {
  focusedPanelWidth,
  persistFocusedPanelWidth
} from '../../model/workspaceLayout';
import { PanelResizeHandle } from '../PanelResizeHandle';
import { nextTabIndex } from '../AccessibleTabs';
import { applicationAttempts, previewRunRows } from '../../model/applicationPreviewRuns';
import { ApplicationLogStream } from './ApplicationLogStream';
import { message } from './previewPresentation';
import { failureWord, markerText } from '../../model/applicationPreviewLogs';

const TERMINAL_MARKERS = new Set([
  'failed',
  'succeeded',
  'stopped',
  'canceled',
  'cleanup-incomplete'
]);

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
    return run ? `${run.time} · ${run.outcome}` : attemptId;
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
  /** Names a run by time and outcome; ids never appear. */
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
  const [linkFollow, setLinkFollow] = useState(false);
  const [paused, setPaused] = useState<string[]>(
    selection?.failure
      ? ['all', ...(selection.source ? [selection.source] : [])]
      : []
  );
  const [query, setQuery] = useState('');
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [narrow, setNarrow] = useState(false);
  const [paneWidth, setPaneWidth] = useState(() =>
    focusedPanelWidth('preview-logs', 360, 160, 800)
  );
  const [secondWidth, setSecondWidth] = useState(() =>
    focusedPanelWidth('preview-logs-secondary', 280, 160, 800)
  );
  const [markers, setMarkers] = useState<ApplicationLogLine[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const checklist = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  const readNow = useRef<() => void>(() => undefined);
  const stateRef = useRef<Record<string, string>>({});
  const bufferRef = useRef(buffer);
  const runningRef = useRef<string | undefined>(undefined);
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
  const side = sideBySide && chosen.length >= 2 && chosen.length <= 4;
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
  useLayoutEffect(() => {
    if (
      !panel.current ||
      !strip.current ||
      typeof ResizeObserver === 'undefined'
    )
      return;
    const measure = () =>
      setNarrow(strip.current!.scrollWidth > panel.current!.clientWidth - 8);
    const observer = new ResizeObserver(measure);
    observer.observe(panel.current);
    observer.observe(strip.current);
    measure();
    return () => observer.disconnect();
  }, [sources.join('\0'), active]);
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
    const running = sourcesRef.current.find(
      (source) => attempt.services?.[source]?.state === 'starting'
    );
    if (running && running !== runningRef.current) {
      const former = runningRef.current;
      setSelected((value) =>
        value.length === 1 && value[0] === former ? [running] : value
      );
    }
    runningRef.current = running;
  }, [attempt, status?.name]);
  const lines = useMemo(() => {
    const rows = splitApplicationLogs(
      buffer.text,
      framedSources,
      buffer.source,
      buffer.offset
    );
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
        rows.splice(lastSource + 1, 0, marker);
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
  const matches = useMemo(() => {
    if (!query) return [];
    const result: Array<{ line: number; occurrence: number; source: string }> =
      [];
    const orderedLines = side
      ? chosen.flatMap((source) =>
          visible.filter((line) => line.source === source)
        )
      : visible;
    for (const line of orderedLines) {
      if (line.marker) continue;
      let from = 0;
      let occurrence = 0;
      let at: number;
      while (
        (at = line.text.toLowerCase().indexOf(query.toLowerCase(), from)) >= 0
      ) {
        result.push({
          line: line.id,
          occurrence: occurrence++,
          source: line.source
        });
        from = at + query.length;
      }
    }
    return result;
  }, [query, lines, chosen.join('\0'), side]);
  function follow(source: string, value: boolean) {
    const targets = linkFollow && side ? chosen : [source];
    setPaused((current) =>
      value
        ? current.filter((item) => !targets.includes(item))
        : [...new Set([...current, ...targets])]
    );
  }
  function navigateMatch(direction: number) {
    if (!matches.length) return;
    const index = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index);
    follow(side ? matches[index]!.source : 'all', false);
  }
  function toggle(source?: string, multi = false) {
    setMatchIndex(-1);
    setSelected((value) =>
      !source
        ? []
        : !multi
          ? [source]
          : value.includes(source)
            ? value.filter((item) => item !== source)
            : [...value, source]
    );
  }
  const pausedPanes = paused.filter((source) => side ? chosen.includes(source) : source === 'all');
  const singleFailed =
    chosen.length === 1 && sourceState(chosen[0]!) === 'failed';
  const laneWidth = Math.min(
    16,
    Math.max(4, ...chosen.map((source) => displayName(source).length))
  );
  const counts = new Map(
    sources.map((source) => [
      source,
      lines.filter((line) => !line.marker && line.source === source).length
    ])
  );
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
        }
      }}
    >
      <div className="tm-preview-logs__toolbar">
        <label className="field">
          <span className="tm-visually-hidden">Log run</span>
          <select
            value={attempt.id}
            onChange={(event) => onSelect({ attemptId: event.target.value })}
          >
            {attempts.map((item) => (
              <option key={item.id} value={item.id}>
                {runLabel(item.id)}
              </option>
            ))}
          </select>
        </label>
        {narrow && sources.length > 1 ? (
          <details
            ref={checklist}
            className="tm-preview-log-checklist"
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' ||
                (event.key === 'Enter' &&
                  event.target instanceof HTMLInputElement)
              ) {
                event.preventDefault();
                checklist.current!.open = false;
                checklist.current?.querySelector('summary')?.focus();
              }
            }}
          >
            <summary>
              {selected.length === 1
                ? displayName(selected[0]!)
                : selected.length
                  ? `${selected.length} sources`
                  : 'All sources'}
            </summary>
            <div role="group" aria-label="Log sources">
              <label>
                <input
                  type="checkbox"
                  checked={!selected.length}
                  onChange={() => toggle()}
                />
                All sources
                <span>{lines.filter((line) => !line.marker).length}</span>
              </label>
              {sources.map((source) => (
                <label key={source}>
                  <input
                    type="checkbox"
                    checked={!selected.length || selected.includes(source)}
                    onChange={() => toggle(source, true)}
                  />
                  {displayName(source)}
                  <span>
                    {stateWord(source)} · {counts.get(source)}
                  </span>
                </label>
              ))}
              <button
                className="ghost-button"
                disabled={!sources.some((source) => sourceState(source) === 'failed')}
                onClick={() =>
                  setSelected(
                    sources.filter((source) => sourceState(source) === 'failed')
                  )
                }
              >
                Only sources with a failure
              </button>
            </div>
          </details>
        ) : null}
        <div className="tm-preview-logs__right">
          <label className="field field--search tm-preview-log-search">
            <Search size={14} aria-hidden="true" />
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
                  panel.current
                    ?.querySelector<HTMLElement>('.tm-preview-stream')
                    ?.focus();
                }
              }}
            />
          </label>
          {query ? (
            <>
              <span className="tm-preview-log-count" aria-live="polite">
                {matches.length
                  ? `${matchIndex < 0 ? 0 : (matchIndex % matches.length) + 1} of ${matches.length}`
                  : 'No matches'}
              </span>
              <button
                className="ghost-button"
                aria-label="Previous log match"
                onClick={() => navigateMatch(-1)}
                disabled={!matches.length}
              >
                ↑
              </button>
              <button
                className="ghost-button"
                aria-label="Next log match"
                onClick={() => navigateMatch(1)}
                disabled={!matches.length}
              >
                ↓
              </button>
              <button
                className="ghost-button"
                aria-pressed={matchesOnly}
                onClick={() => setMatchesOnly((value) => !value)}
              >
                Matches only
              </button>
            </>
          ) : null}
          {sources.length > 1 ? (
            <button
              className="ghost-button"
              aria-pressed={side}
              disabled={chosen.length < 2 || chosen.length > 4}
              title={
                chosen.length < 2
                  ? 'Select two to four sources to show them side by side.'
                  : chosen.length > 4
                    ? 'Select at most four sources to show them side by side.'
                    : undefined
              }
              onClick={() => setSideBySide((value) => !value)}
            >
              Side by side
            </button>
          ) : null}
          {side ? (
            <button
              className="ghost-button"
              aria-pressed={linkFollow}
              title="Pause and resume every pane together"
              onClick={() => setLinkFollow((value) => !value)}
            >
              Link follow
            </button>
          ) : (
            <button
              className="ghost-button"
              aria-pressed={!paused.includes('all')}
              onClick={() => follow('all', paused.includes('all'))}
            >
              {paused.includes('all') ? 'Resume follow' : 'Pause follow'}
            </button>
          )}
        </div>
      </div>
      {sources.length > 1 ? (
        <div
          ref={strip}
          className={`tm-preview-log-steps ${narrow ? 'tm-preview-log-steps--measuring' : ''}`}
          role="group"
          aria-label="Log sources"
          aria-hidden={narrow || undefined}
        >
          {[undefined, ...sources].map((source, index) => (
            <Fragment key={source ?? 'all'}>
            {index > 1 ? (
              <span className="tm-preview-log-steps__sep" aria-hidden="true">
                ›
              </span>
            ) : null}
            <button
              className="ghost-button"
              tabIndex={
                narrow
                  ? -1
                  : !selected.length
                    ? index === 0
                      ? 0
                      : -1
                    : selected[0] === source
                      ? 0
                      : -1
              }
              aria-pressed={
                source ? selected.includes(source) : !selected.length
              }
              onClick={(event) =>
                toggle(source, event.metaKey || event.ctrlKey)
              }
              onKeyDown={(event) => {
                const buttons = Array.from(
                  strip.current!.querySelectorAll<HTMLButtonElement>('button')
                );
                const next = nextTabIndex(index, buttons.length, event.key);
                if (next !== undefined) {
                  event.preventDefault();
                  buttons.forEach((button, i) => {
                    button.tabIndex = i === next ? 0 : -1;
                  });
                  buttons[next]?.focus();
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  toggle(source, true);
                }
              }}
            >
              {source ? (
                <>
                  {displayName(source)}
                  <span data-state={sourceState(source)}>
                    {stateWord(source)}
                  </span>
                </>
              ) : (
                'All'
              )}
            </button>
            </Fragment>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}{' '}
          <button
            className="ghost-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Reconnect logs
          </button>
        </p>
      ) : null}
      <div
        className={`tm-preview-log-panes ${side ? `tm-preview-log-panes--${chosen.length}` : ''}`}
        style={{
          ['--lane' as string]: `${laneWidth}ch`,
          ...(side
            ? {
                gridTemplateColumns:
                  chosen.length === 3
                    ? `minmax(160px, min(${paneWidth}px, 40%)) 5px minmax(160px, min(${secondWidth}px, 40%)) 5px minmax(160px, 1fr)`
                    : `minmax(160px, min(${paneWidth}px, 70%)) 5px minmax(160px, 1fr)`
              }
            : {})
        }}
      >
        {(side ? chosen : ['all']).map((source, index) => {
          const paneLines = side
            ? visible.filter((line) => line.source === source)
            : visible;
          const empty =
            chosen.length === 1 && sourceState(chosen[0]!) === 'failed'
              ? `No output captured from ${displayName(chosen[0]!)}. The command never ran or produced no output.`
              : chosen.length === 1 &&
                  ['waiting', 'skipped'].includes(sourceState(chosen[0]!))
                ? `${displayName(chosen[0]!)} has not started.`
                : 'No output yet.';
          return (
            <div className="tm-preview-log-pane-pair" key={source}>
              {side && (chosen.length === 4 ? index % 2 === 1 : index > 0) ? (
                <PanelResizeHandle
                  label={`Resize ${displayName(source)} log pane`}
                  value={index === 2 ? secondWidth : paneWidth}
                  min={160}
                  max={800}
                  defaultValue={index === 2 ? 280 : 360}
                  onChange={(width) => {
                    if (index === 2) setSecondWidth(width);
                    else setPaneWidth(width);
                    persistFocusedPanelWidth(
                      index === 2 ? 'preview-logs-secondary' : 'preview-logs',
                      width
                    );
                  }}
                />
              ) : null}
              <section
                className="tm-preview-log-pane"
                aria-label={
                  side ? `${displayName(source)} log pane` : 'Combined log pane'
                }
              >
                {side ? (
                  <header>
                    {displayName(source)}
                    <span data-state={sourceState(source)}>
                      {stateWord(source)}
                    </span>
                    {paused.includes(source) ? (
                      <span className="tm-preview-log-pane__paused">paused</span>
                    ) : null}
                  </header>
                ) : null}
                <ApplicationLogStream
                  name={side ? displayName(source) : 'Application'}
                  lines={paneLines.map((line) => ({
                    ...line,
                    source: displayName(line.source)
                  }))}
                  lanes={!side && chosen.length > 1}
                  query={query}
                  matchesOnly={matchesOnly}
                  currentMatch={
                    matchIndex >= 0
                      ? matches[matchIndex % matches.length]
                      : undefined
                  }
                  follow={!paused.includes(source)}
                  onFollow={(value) => follow(source, value)}
                  truncated={buffer.truncated}
                  expired={expired}
                  empty={empty}
                  failureTarget={
                    selection?.failure
                      ? `${selection.attemptId}:${selection.source}`
                      : undefined
                  }
                  active={active}
                />
              </section>
            </div>
          );
        })}
      </div>
      <footer className="tm-preview-log-footer">
        <span>
          {expired
            ? 'Expired'
            : pausedPanes.length
              ? `Follow paused${
                  side
                    ? ` · ${pausedPanes
                        .map(displayName)
                        .join(', ')}`
                    : ''
                }`
              : 'Following'}
        </span>
        <button
          className="ghost-button"
          onClick={() =>
            void navigator.clipboard.writeText(
              visible
                .filter(
                  (line) =>
                    !matchesOnly ||
                    line.marker ||
                    line.text.toLowerCase().includes(query.toLowerCase())
                )
                .map((line) =>
                  line.marker
                    ? `[${displayName(line.source)}] ${markerText(line)}`
                    : `[${displayName(line.source)}] ${line.text}`
                )
                .join('\n')
            )
          }
        >
          Copy visible
        </button>
        {singleFailed && onTaskAgent ? (
          <button
            className="ghost-button"
            onClick={() =>
              onTaskAgent(
                `Investigate Preview run ${runLabel(attempt.id)}, service ${displayName(chosen[0]!)}. Review before making changes.\n${visible
                  .filter((line) => line.source === chosen[0])
                  .slice(-40)
                  .map((line) => line.text)
                  .join('\n')}`
              )
            }
          >
            Send last 40 lines to task agent
          </button>
        ) : null}
      </footer>
    </div>
  );
}
