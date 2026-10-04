import { useEffect, useRef, type ReactNode } from 'react';
import type { DiscourseContextPreview } from '../../shared/discourse';
import {
  DiscourseCloseIcon,
  DiscourseRepositoryIcon,
  DiscourseTaskIcon
} from './DiscourseIcons';
import { useDialogFocusBoundary } from './dialogFocus';

export function InspectorSidebar({ children, returnFocus, onClose }: {
  children: ReactNode;
  returnFocus?: HTMLElement | null;
  onClose(): void;
}) {
  const closeAndReturnFocus = () => {
    onClose();
    queueMicrotask(() => returnFocus?.focus({ preventScroll: true }));
  };
  return (
    <aside id="discourse-inspector-panel" className="tm-discourse-inspector"
      aria-labelledby="discourse-inspector-title">
      <div className="tm-discourse-inspector__head">
        <h2 id="discourse-inspector-title">Conversation settings</h2>
        <button type="button" className="tm-iconbtn" aria-label="Close conversation settings"
          title="Close conversation settings" onClick={closeAndReturnFocus}>
          <DiscourseCloseIcon />
        </button>
      </div>
      {children}
    </aside>
  );
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
      <header className="tm-discourse-preview__head">
        <h2 id="discourse-preview-title">Message context</h2>
        <button type="button" className="tm-iconbtn" aria-label="Close context preview" title="Close context preview"
          onClick={() => { returnFocusOnCloseRef.current = true; onClose(); }}>
          <DiscourseCloseIcon />
        </button>
      </header>
      <p className="tm-discourse-preview__summary">{preview.references.length
        ? 'Your message, recent conversation, and these sources:'
        : 'Your message and recent conversation only.'}</p>
      {preview.references.length > 0 ? <ul className="tm-discourse-context-list" aria-label="Included sources">
        {preview.references.map((reference) => <ContextReference key={`${reference.entityKind}:${reference.entityId}`}
          kind={reference.entityKind} label={reference.labelSnapshot}
          description={[
            reference.scope === 'PINNED' ? 'Pinned' : 'This message',
            reference.entityKind === 'TASK' ? 'Task description and recorded status' : undefined,
            reference.accessMode === 'FILESYSTEM_READ'
              ? reference.readScope === 'TASK_WORKTREE' ? 'Read-only worktree' : 'Read-only repository'
              : accessModeLabel(reference.accessMode)
          ].filter(Boolean).join(' · ')} />)}
      </ul> : null}
      {preview.exclusions.length > 0 ? <details className="tm-discourse-preview__exclusions">
        <summary>Context limits</summary>
        <ul>{preview.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul>
      </details> : null}
    </aside>
  );
}

export function ContextReference({ kind, label, description, children }: {
  kind: 'TASK' | 'REPOSITORY';
  label: string;
  description: string;
  children?: ReactNode;
}) {
  return <li>
    <span className={`tm-discourse-context-kind tm-discourse-context-kind--${kind.toLowerCase()}`} aria-hidden="true">
      {kind === 'TASK' ? <DiscourseTaskIcon /> : <DiscourseRepositoryIcon />}
    </span>
    <span><strong title={label}>{label}</strong><small>{description}</small></span>
    {children}
  </li>;
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
