import { useEffect, useRef, type ReactNode } from 'react';
import type { DiscourseContextPreview } from '../../shared/discourse';
import {
  DiscourseCloseIcon,
  DiscourseRepositoryIcon,
  DiscourseTaskIcon
} from './DiscourseIcons';
import { useDialogFocusBoundary } from './dialogFocus';

export function InspectorDrawer({
  children,
  modal,
  returnFocus,
  onClose
}: {
  children: ReactNode;
  modal: boolean;
  returnFocus?: HTMLElement | null;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeAndReturnFocus = () => {
    onClose();
    queueMicrotask(() => returnFocus?.focus({ preventScroll: true }));
  };
  useDialogFocusBoundary({
    dialogRef,
    busy: false,
    onClose: closeAndReturnFocus,
    returnFocus,
    active: modal
  });
  const inspector = (
    <aside
      ref={dialogRef}
      className={`tm-discourse-inspector ${modal ? 'tm-discourse-inspector--overlay' : ''}`}
      role={modal ? 'dialog' : 'complementary'}
      aria-modal={modal || undefined}
      aria-labelledby="discourse-inspector-title"
      tabIndex={modal ? -1 : undefined}
    >
      <div className="tm-discourse-inspector__head">
        <h2 id="discourse-inspector-title">Conversation details</h2>
        <button
          type="button"
          className="tm-iconbtn"
          aria-label="Close conversation details"
          title="Close conversation details"
          onClick={closeAndReturnFocus}
        >
          <DiscourseCloseIcon />
        </button>
      </div>
      {children}
    </aside>
  );
  return modal ? (
    <div className="tm-discourse-drawer">
      <button
        type="button"
        className="tm-discourse-drawer-scrim"
        aria-label="Close conversation details"
        onClick={closeAndReturnFocus}
      />
      {inspector}
    </div>
  ) : inspector;
}

export function ContextPreview({
  preview,
  returnFocus,
  onClose
}: {
  preview: DiscourseContextPreview;
  returnFocus?: HTMLElement | null;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusOnCloseRef = useRef(true);
  useDialogFocusBoundary({
    dialogRef,
    busy: false,
    trapFocus: false,
    returnFocus,
    onClose,
    shouldReturnFocus: () => returnFocusOnCloseRef.current
  });
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        returnFocusOnCloseRef.current = false;
        onClose();
      }
    };
    window.addEventListener('pointerdown', closeOutside);
    return () => window.removeEventListener('pointerdown', closeOutside);
  }, [onClose]);
  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="tm-discourse-context-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="discourse-preview-title"
    >
      <div className="tm-discourse-preview">
        <header>
          <div>
            <h2 id="discourse-preview-title">What agents will see</h2>
            <p>Available until {formatMessageTime(preview.expiresAt)}</p>
          </div>
          <button
            type="button"
            className="tm-iconbtn"
            aria-label="Close context preview"
            title="Close context preview"
            onClick={() => {
              returnFocusOnCloseRef.current = true;
              onClose();
            }}
          >
            <DiscourseCloseIcon />
          </button>
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
      </div>
    </aside>
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
