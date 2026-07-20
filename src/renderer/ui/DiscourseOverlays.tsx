import { useRef, type ReactNode } from 'react';
import type { DiscourseContextPreview } from '../../shared/discourse';
import { DiscourseRepositoryIcon, DiscourseTaskIcon } from './DiscourseIcons';
import { useDialogFocusBoundary } from './dialogFocus';

export function InspectorDrawer({
  children,
  onClose
}: {
  children: ReactNode;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusBoundary({ dialogRef, busy: false, onClose });
  return (
    <div className="tm-discourse-drawer">
      <button
        type="button"
        className="tm-discourse-drawer-scrim"
        aria-label="Close context"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        className="tm-discourse-inspector"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discourse-inspector-title"
        tabIndex={-1}
      >
        <div className="tm-discourse-inspector__head">
          <h2 id="discourse-inspector-title">Conversation details</h2>
          <button
            type="button"
            className="tm-iconbtn"
            aria-label="Close conversation details"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function ContextPreview({
  preview,
  onClose
}: {
  preview: DiscourseContextPreview;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusBoundary({ dialogRef, busy: false, onClose });
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="tm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="discourse-preview-title"
    >
      <div className="tm-modal__scrim" onClick={onClose} />
      <div className="tm-modal__panel tm-discourse-preview">
        <header>
          <div>
            <h2 id="discourse-preview-title">What agents will see</h2>
            <p>Provisional context manifest · valid until {formatMessageTime(preview.expiresAt)}</p>
          </div>
          <button type="button" className="tm-iconbtn" aria-label="Close context preview" onClick={onClose}>×</button>
        </header>
        <section>
          <h3>Selected context</h3>
          {preview.references.length === 0 ? (
            <p>No task or repository context. Only the message and bounded conversation history would be included.</p>
          ) : (
            <ul>
              {preview.references.map((reference) => (
                <li key={`${reference.entityKind}:${reference.entityId}`}>
                  <span className={`tm-discourse-context-kind tm-discourse-context-kind--${reference.entityKind.toLowerCase()}`}>
                    {reference.entityKind === 'TASK'
                      ? <DiscourseTaskIcon />
                      : <DiscourseRepositoryIcon />}
                  </span>
                  <span>
                    <strong>{reference.labelSnapshot}</strong>
                    <small>
                      {reference.scope === 'PINNED' ? 'Pinned' : 'This message'} ·{' '}
                      {accessModeLabel(reference.accessMode)}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Safety boundary</h3>
          <dl className="tm-discourse-preview__policy">
            <div><dt>Repository roots</dt><dd>{preview.filesystemRootCount} read-only</dd></div>
            <div><dt>Writes</dt><dd>Disabled</dd></div>
            <div><dt>Network</dt><dd>Disabled</dd></div>
            <div><dt>Tools & apps</dt><dd>Disabled</dd></div>
          </dl>
        </section>
        {preview.exclusions.length > 0 ? (
          <section className="tm-discourse-preview__exclusions">
            <h3>Exclusions</h3>
            <ul>{preview.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul>
          </section>
        ) : null}
        <footer>
          <span className="tm-discourse-preview__hash">Manifest {preview.fingerprint.slice(0, 10)}</span>
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}

export function InspectorSection({
  title,
  count,
  children
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="tm-discourse-inspector__section">
      <h3>{title}{count !== undefined ? <span>{count}</span> : null}</h3>
      {children}
    </section>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusBoundary({ dialogRef, busy: false, onClose: onCancel });
  return (
    <div ref={dialogRef} tabIndex={-1} className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="discourse-confirm-title">
      <div className="tm-modal__scrim" onClick={onCancel} />
      <div className="tm-modal__panel tm-discourse-confirm">
        <h2 id="discourse-confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger-button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function accessModeLabel(value: string): string {
  return value === 'FILESYSTEM_READ'
    ? 'Read-only files'
    : value === 'METADATA_ONLY'
      ? 'Metadata only'
      : 'Unavailable';
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}
