import { Ellipsis, Pause, Play, RefreshCw, Search } from 'lucide-react';
import { ActionMenu } from '../ActionMenu';
import { useEffect, useRef, useState } from 'react';
import type { AttemptSummary, PreviewStatus } from 'previewhost';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { message } from './previewPresentation';
import { appendApplicationLog } from '../../model/applicationPreviewLogs';

export function ApplicationLogs({
  taskId,
  status,
  selection,
  onSelect,
  active = true
}: {
  taskId: string;
  active?: boolean;
  status?: PreviewStatus;
  selection?: { attemptId: string; source?: string };
  onSelect(value: { attemptId: string; source?: string }): void;
}) {
  const attempts = [
    status?.active,
    status?.candidate,
    status?.latest,
    ...(status?.history ?? [])
  ].filter(
    (value, index, all): value is AttemptSummary =>
      !!value && all.findIndex((item) => item?.id === value.id) === index
  );
  const attemptId =
    selection?.attemptId ??
    status?.active?.id ??
    status?.candidate?.id ??
    status?.latest?.id;
  const source = selection?.source;
  const attempt = attempts.find((value) => value.id === attemptId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [newOutput, setNewOutput] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const clearView = useRef(() => undefined);
  const isActive = useRef(active);
  const readNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    isActive.current = active;
    if (active) readNow.current();
  }, [active]);
  function changeFollow(value: boolean) {
    following.current = value;
    setFollow(value);
    if (value) setNewOutput(false);
  }
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let cursor: number | undefined;
    let buffer = '';
    let failed = false;
    let timer: ReturnType<typeof setTimeout>;
    setText('');
    setError(undefined);
    setTruncated(false);
    setNewOutput(false);
    clearView.current = () => {
      buffer = '';
      setText('');
      setTruncated(false);
      setNewOutput(false);
    };
    async function read() {
      if (
        !attemptId ||
        !isActive.current ||
        failed ||
        reading ||
        disposed ||
        document.visibilityState !== 'visible'
      )
        return;
      clearTimeout(timer);
      reading = true;
      try {
        const result = await api.readApplicationPreviewLogs({
          taskId,
          attemptId,
          source,
          after: cursor,
          maxBytes: 65_536
        });
        if (!disposed) {
          cursor = result.cursor;
          setError(undefined);
          const appended = appendApplicationLog(buffer, result.text);
          buffer = appended.text;
          setTruncated(
            (value) => value || result.truncated || appended.truncated
          );
          setText(buffer);
          if (result.text && !following.current) setNewOutput(true);
        }
      } catch (cause) {
        failed = true;
        if (!disposed) setError(message(cause));
      } finally {
        reading = false;
        if (!disposed && !failed && isActive.current)
          timer = setTimeout(() => void read(), 750);
      }
    }
    const visible = () => {
      clearTimeout(timer);
      void read();
    };
    readNow.current = () => void read();
    void read();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearView.current = () => undefined;
      readNow.current = () => undefined;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [taskId, attemptId, source, refresh]);
  useEffect(() => {
    if (active && follow && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [text, follow, active]);
  if (!attemptId)
    return (
      <p className="tm-application-preview__notice">
        Start an application to view its logs.
      </p>
    );
  return (
    <div className="tm-application-preview__logs">
      <div className="tm-application-preview__toolbar tm-application-preview__log-filters">
        <label className="field field--search tm-application-preview__search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input
            aria-label="Search logs"
            type="search"
            placeholder="Search logs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="tm-visually-hidden">Log attempt</span>
          <select
            value={attemptId}
            onChange={(event) => onSelect({ attemptId: event.target.value })}
          >
            {!attempt ? (
              <option value={attemptId}>Selected attempt unavailable</option>
            ) : null}
            {attempts.map((value) => (
              <option key={value.id} value={value.id}>
                {value.id === status?.active?.id
                  ? 'Serving'
                  : value.id === status?.candidate?.id
                    ? 'Starting'
                    : value.id === status?.latest?.id
                      ? 'Latest'
                      : 'Earlier'}{' '}
                · {value.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="tm-visually-hidden">Log source</span>
          <select
            value={source ?? ''}
            onChange={(event) =>
              onSelect({ attemptId, source: event.target.value || undefined })
            }
          >
            <option value="">All output</option>
            {Object.entries(attempt?.services ?? {})
              .filter(([, value]) =>
                ['command', 'worker', 'job', 'compose'].includes(value.type)
              )
              .map(([id]) => (
                <option key={id}>{id}</option>
              ))}
          </select>
        </label>
        <button
          className="tm-application-preview__icon outline-button"
          aria-label={follow ? 'Pause follow' : 'Follow output'}
          title={follow ? 'Pause follow' : 'Follow output'}
          aria-pressed={follow}
          onClick={() => changeFollow(!follow)}
        >
          {follow ? (
            <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Play size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>
        <button
          className="tm-application-preview__icon outline-button"
          aria-label="Refresh logs"
          title="Refresh logs"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <ActionMenu
          label="Log actions"
          trigger={<Ellipsis size={16} aria-hidden="true" />}
          items={[{ label: 'Clear view', onSelect: () => clearView.current() }]}
        />
      </div>
      {error ? (
        <p role="alert" className="tm-application-preview__error">
          {error} Use Refresh to reconnect.
        </p>
      ) : null}
      {truncated ? (
        <p className="tm-application-preview__notice">
          Older output is no longer available.
        </p>
      ) : null}

      <pre
        ref={output}
        tabIndex={0}
        aria-label="Application logs"
        onScroll={() => {
          const node = output.current;
          if (
            node &&
            node.scrollHeight - node.scrollTop - node.clientHeight > 30
          )
            changeFollow(false);
        }}
      >
        {query
          ? text
              .split('\n')
              .filter((line) =>
                line.toLowerCase().includes(query.toLowerCase())
              )
              .join('\n') || 'No matches in loaded output.'
          : text || 'No output captured.'}
      </pre>
      <div className="tm-application-preview__log-status">
        <span role="status">
          {error
            ? 'Disconnected'
            : follow
              ? 'Live · Following'
              : 'Live · Follow paused'}
        </span>
        {newOutput && !follow ? (
          <button className="ghost-button" onClick={() => changeFollow(true)}>
            Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
