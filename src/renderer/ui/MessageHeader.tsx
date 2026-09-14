import type { ReactNode } from 'react';
import { StatusGlyph, type StatusGlyphKind } from './StatusBadge';

/** Shared conversation chrome; callers retain ownership of lifecycle and identity. */
export function MessageHeader({ author, model, time, status, tone = 'idle', children }: {
  author: string;
  model?: string;
  time?: string;
  status?: string;
  tone?: StatusGlyphKind;
  children?: ReactNode;
}) {
  return <header className="tm-message-header">
    <strong>{author}</strong>
    <div className="tm-message-header__meta">
      {model ? <span className="tm-message-header__model" title={model}>{model}</span> : null}
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
