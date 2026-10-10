import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  AttemptSummary,
  PreviewDescription,
  PreviewStatus
} from 'previewhost';
import { ChevronDown, Columns2, Copy, Pause, Play, Search } from 'lucide-react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import {
  appendLogBuffer,
  splitApplicationLogs,
  logSourceOrder,
  type ApplicationLogBuffer,
  type ApplicationLogLine
} from '../../model/applicationPreviewLogs';
import { ActionMenu } from '../ActionMenu';
import { applicationAttempts, previewRunRows, runTime } from '../../model/applicationPreviewRuns';
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
  const [paused, setPaused] = useState<string[]>(
    selection?.failure
      ? ['all', ...(selection.source ? [selection.source] : [])]
      : []
  );
  const [query, setQuery] = useState('');
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [markers, setMarkers] = useState<ApplicationLogLine[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
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
    setPaused((current) =>
      value
        ? current.filter((item) => item !== source)
        : [...new Set([...current, source])]
    );
  }
  function navigateMatch(direction: number) {
    if (!matches.length) return;
    const index = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index);
    follow(side ? matches[index]!.source : 'all', false);
  }
  function toggleSource(source: string) {
    setMatchIndex(-1);
    const next = chosen.includes(source)
      ? chosen.filter((item) => item !== source)
      : [...chosen, source];
    if (next.length) setSelected(next.length === sources.length ? [] : next);
  }
  const singleFailed =
    chosen.length === 1 && sourceState(chosen[0]!) === 'failed';
  const laneWidth = Math.min(
    16,
    Math.max(4, ...chosen.map((source) => displayName(source).length))
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
        {attempts.length > 1 ? (
          <ActionMenu
            label="Log run"
            selection="single"
            align="start"
            trigger={<>{attempt.id === status?.active?.id ? 'Current run' : runTime(attempt.startedAt)}<ChevronDown size={14} aria-hidden="true" /></>}
            items={attempts.map((item) => ({
              id: item.id,
              label: runTime(item.startedAt),
              description: runLabel(item.id),
              pressed: item.id === attempt.id,
              onSelect: () => onSelect({ attemptId: item.id })
            }))}
          />
        ) : null}
        {sources.length > 1 ? (
          <ActionMenu
            label="Log sources"
            align="start"
            open={sourceMenuOpen}
            onOpenChange={setSourceMenuOpen}
            closeOnSelect={false}
            trigger={<>{chosen.length === sources.length ? 'All sources' : chosen.length === 1 ? displayName(chosen[0]!) : `${chosen.length} sources`}<ChevronDown size={14} aria-hidden="true" /></>}
            items={[
              { label: 'All sources', pressed: chosen.length === sources.length, onSelect: () => {
                setSelected([]);
                setMatchIndex(-1);
                if (sources.length > 4) setSideBySide(false);
              } },
              ...sources.map((source) => ({
                label: displayName(source),
                description: stateWord(source),
                pressed: chosen.includes(source),
                disabled: chosen.includes(source) ? chosen.length === 1 : sideBySide && chosen.length >= 4,
                disabledReason: chosen.includes(source) ? 'Keep at least one source selected.' : 'Show up to four sources side by side.',
                onSelect: () => toggleSource(source)
              }))
            ]}
          />
        ) : null}
        <div className="tm-preview-logs__right">
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
              aria-pressed={sideBySide}
              aria-label="Side by side"
              title="Side by side"
              onClick={() => {
                setSideBySide(!sideBySide);
                if (!sideBySide) setSourceMenuOpen(true);
              }}
            >
              <Columns2 size={16} aria-hidden="true" />
            </button>
          ) : null}
          {!side ? (
            <button
              className="ghost-button"
              aria-label={paused.includes('all') ? 'Resume logs' : 'Pause logs'}
              title={paused.includes('all') ? 'Resume logs' : 'Pause logs'}
              onClick={() => follow('all', paused.includes('all'))}
            >
              {paused.includes('all') ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
            </button>
          ) : null}
          <button className="ghost-button" aria-label="Copy visible logs" title="Copy visible logs"
            onClick={() => void navigator.clipboard.writeText(
              visible.filter((line) => !matchesOnly || line.marker || line.text.toLowerCase().includes(query.toLowerCase()))
                .map((line) => `[${displayName(line.source)}] ${line.marker ? markerText(line) : line.text}`).join('\n')
            )}>
            <Copy size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {sideBySide && !side ? (
        <p className="tm-preview-help" role="status">Choose two to four sources in Log sources to show separate panes.</p>
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
        style={{ ['--lane' as string]: `${laneWidth}ch` }}
      >
        {(side ? chosen : ['all']).map((source) => {
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
            <section
              key={source}
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
                  <button className="ghost-button" aria-label={`${paused.includes(source) ? 'Resume' : 'Pause'} ${displayName(source)} logs`}
                    title={paused.includes(source) ? 'Resume logs' : 'Pause logs'}
                    onClick={() => follow(source, paused.includes(source))}>
                    {paused.includes(source) ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                  </button>
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
          );
        })}
      </div>
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
    </div>
  );
}
