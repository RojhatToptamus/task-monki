import { FileText, Image, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentComposerItem } from '../model/taskAttachmentComposer';
import type { AttachmentContent, AttachmentDescriptor } from '../../shared/attachments';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { useDialogFocusBoundary } from './dialogFocus';

export function AttachmentChip({
  item,
  disabled,
  onRemove,
  onPreviewOpenChange
}: {
  item: AttachmentComposerItem;
  disabled: boolean;
  onRemove(): void;
  onPreviewOpenChange?(open: boolean): void;
}) {
  return (
    <li
      className={`task-attachment ${
        item.status === 'error' || item.error ? 'task-attachment--error' : ''
      }`}
    >
      <span className="task-attachment__preview" aria-hidden="true">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
        ) : item.kind === 'image' ? (
          <ImageFileIcon />
        ) : (
          <TextFileIcon />
        )}
      </span>
      <span className="task-attachment__body">
        <AttachmentPreview name={item.file.name} read={async () => ({
          attachmentId: item.clientId, displayName: item.file.name, kind: item.kind!,
          mediaType: item.file.type, byteCount: item.file.size, bytes: await item.file.arrayBuffer()
        })} disabled={item.status === 'error'} onOpenChange={onPreviewOpenChange} />
        <span
          className="task-attachment__meta"
          role={item.error ? 'alert' : undefined}
          aria-live={item.error ? 'assertive' : undefined}
          aria-atomic={item.error ? 'true' : undefined}
        >
          {item.status === 'error' ? item.error : formatAttachmentBytes(item.file.size)}
        </span>
      </span>
      <button
        type="button"
        className="task-attachment__remove"
        aria-label={`Remove ${item.file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </li>
  );
}

export function StoredAttachmentChip({
  attachment,
  label,
  disabled,
  onRemove,
  onRead,
  onPreviewOpenChange
}: {
  attachment: AttachmentDescriptor;
  label?: string;
  disabled?: boolean;
  onRemove?(): void;
  onRead?(): Promise<AttachmentContent>;
  onPreviewOpenChange?(open: boolean): void;
}) {
  return (
    <li className="task-attachment">
      <span className="task-attachment__preview" aria-hidden="true">
        {attachment.kind === 'image' ? <ImageFileIcon /> : <TextFileIcon />}
      </span>
      <span className="task-attachment__body">
        {onRead ? <AttachmentPreview name={attachment.displayName} read={onRead} onOpenChange={onPreviewOpenChange} /> :
          <span className="task-attachment__name" title={attachment.displayName}>{attachment.displayName}</span>}
        <span className="task-attachment__meta">
          {label ? `${label} · ` : ''}{formatAttachmentBytes(attachment.byteCount)}
        </span>
      </span>
      {onRemove ? <button
        type="button"
        className="task-attachment__remove"
        aria-label={`Remove ${attachment.displayName} from this message`}
        disabled={disabled}
        onClick={onRemove}
      >
        <CloseIcon />
      </button> : null}
    </li>
  );
}

function AttachmentPreview({ name, read, disabled, onOpenChange }: {
  name: string;
  read(): Promise<AttachmentContent>;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const [preview, setPreview] = useState<{ loading?: boolean; image?: string; text?: string; error?: string }>();
  const request = useRef(0);
  const close = () => { request.current += 1; setPreview(undefined); };
  const open = async () => {
    const id = ++request.current;
    setPreview({ loading: true });
    try {
      const content = await read();
      if (id !== request.current) return;
      if (content.kind === 'image') {
        const reader = new FileReader();
        reader.onload = () => { if (id === request.current) setPreview({ image: String(reader.result) }); };
        reader.onerror = () => { if (id === request.current) setPreview({ error: 'This image could not be previewed.' }); };
        reader.readAsDataURL(new Blob([content.bytes], { type: content.mediaType }));
      } else {
        const limit = 64 * 1024;
        setPreview({ text: new TextDecoder().decode(content.bytes.slice(0, limit)) + (content.byteCount > limit ? '\n… Preview truncated' : '') });
      }
    } catch (error) {
      if (id === request.current) setPreview({ error: error instanceof Error ? error.message : 'This file could not be previewed.' });
    }
  };
  return <>
    <button type="button" className="task-attachment__name task-attachment__open" title={`Preview ${name}`} disabled={disabled} onClick={() => void open()}>{name}</button>
    {preview ? <AttachmentPreviewDialog name={name} onClose={close} onOpenChange={onOpenChange}>
      {preview.loading ? <p role="status">Loading preview…</p> : null}
      {preview.error ? <p role="alert" className="tm-error">{preview.error}</p> : null}
      {preview.image ? <img className="task-attachment-preview__image" src={preview.image} alt={name} /> : null}
      {preview.text !== undefined ? <pre className="task-attachment-preview__text">{preview.text}</pre> : null}
    </AttachmentPreviewDialog> : null}
  </>;
}

function AttachmentPreviewDialog({ name, onClose, onOpenChange, children }: {
  name: string;
  onClose(): void;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange]);
  useDialogFocusBoundary({ dialogRef: ref, busy: false, onClose });
  return createPortal(<div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="tm-modal__scrim" onClick={onClose} />
    <section ref={ref} tabIndex={-1} className="tm-modal__panel task-attachment-preview">
      <header className="task-attachment-preview__header"><h3 id={titleId}>{name}</h3><button type="button" className="ghost-button" aria-label="Close preview" onClick={onClose}><CloseIcon /></button></header>
      <div className="task-attachment-preview__content">{children}</div>
    </section>
  </div>, document.body);
}

function CloseIcon() {
  return <X aria-hidden="true" absoluteStrokeWidth size={15} strokeWidth={1.5} />;
}

function ImageFileIcon() {
  return <Image aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}

function TextFileIcon() {
  return <FileText aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}
