import { FileText, Image, X } from 'lucide-react';
import type { AttachmentComposerItem } from '../model/taskAttachmentComposer';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';

export function AttachmentChip({
  item,
  disabled,
  onRemove
}: {
  item: AttachmentComposerItem;
  disabled: boolean;
  onRemove(): void;
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
        <span className="task-attachment__name" title={item.file.name}>
          {item.file.name}
        </span>
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
  onRemove
}: {
  attachment: TaskAttachmentRecord;
  label: string;
  disabled: boolean;
  onRemove(): void;
}) {
  return (
    <li className="task-attachment">
      <span className="task-attachment__preview" aria-hidden="true">
        {attachment.kind === 'image' ? <ImageFileIcon /> : <TextFileIcon />}
      </span>
      <span className="task-attachment__body">
        <span className="task-attachment__name" title={attachment.displayName}>
          {attachment.displayName}
        </span>
        <span className="task-attachment__meta">
          {label} · {formatAttachmentBytes(attachment.byteCount)}
        </span>
      </span>
      <button
        type="button"
        className="task-attachment__remove"
        aria-label={`Remove ${attachment.displayName} from this message`}
        disabled={disabled}
        onClick={onRemove}
      >
        <CloseIcon />
      </button>
    </li>
  );
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
