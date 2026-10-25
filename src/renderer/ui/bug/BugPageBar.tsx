import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Tooltip } from '../Tooltip';

/**
 * The page's own bar, as wide as the page above it: Reload, where the page is, and the size it
 * is recorded at. Before the first step the address takes a path, so a recording can start on
 * the page where the bug is; after it the steps decide where the page goes.
 */
export function BugPageBar({
  address,
  editable,
  live,
  viewport,
  busy,
  onReload,
  onOpen
}: {
  address: string;
  editable: boolean;
  /** The page is shown and takes input. */
  live: boolean;
  viewport: { width: number; height: number };
  busy: boolean;
  onReload(): void;
  onOpen(path: string): void;
}) {
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? address;
  return (
    <div className="tm-bugbar">
      {/* Away from the page: the native page draws over anything below the bar. */}
      <Tooltip label="Reload page" side="top">
        <button type="button" className="tm-iconbtn tm-bugbar__reload" aria-label="Reload page" disabled={!live || busy} onClick={onReload}>
          <RotateCw size={13} aria-hidden="true" />
        </button>
      </Tooltip>
      {editable && live ? (
        <input
          className="tm-bugbar__address"
          aria-label="Start page"
          value={shown}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(undefined)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(undefined);
              event.currentTarget.blur();
            }
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const path = (draft ?? address).trim() || '/';
            setDraft(undefined);
            event.currentTarget.blur();
            if (path !== address) onOpen(path.startsWith('/') ? path : `/${path}`);
          }}
        />
      ) : (
        <span className="tm-bugbar__address" data-disabled={live ? undefined : ''} title={address}>{address}</span>
      )}
      <span className="tm-bugbar__size" aria-label={`Recorded at ${viewport.width} by ${viewport.height} pixels`}>
        {viewport.width} × {viewport.height}
      </span>
    </div>
  );
}
