import type { ReactNode } from 'react';
import { StatusGlyph, type StatusGlyphKind } from './StatusBadge';

/** Shared conversation chrome; callers retain ownership of lifecycle and identity. */
export function MessageHeader({ author, time, status, tone = 'idle', children }: {
  author: string;
  time?: string;
  status?: string;
  tone?: StatusGlyphKind;
  children?: ReactNode;
}) {
  return <header className="tm-message-header">
    <span className="tm-message-header__author">{author}</span>
    <div className="tm-message-header__meta">
      {time ? <time dateTime={time} title={new Date(time).toLocaleString()}>{new Intl.DateTimeFormat(undefined, {
        hour: 'numeric', minute: '2-digit'
      }).format(new Date(time))}</time> : null}
      {status ? <span className="tm-message-header__status" data-tone={tone} role="status">
        <StatusGlyph kind={tone} />{status}
      </span> : null}
      {children}
    </div>
  </header>;
}
