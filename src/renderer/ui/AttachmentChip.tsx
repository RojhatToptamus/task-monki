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
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ImageFileIcon() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <path
        d="m6.5 17 4-4 2.5 2 2-2 2.5 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TextFileIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3.8h6l4 4V20H7zM13 4v4h4M9.5 12h5M9.5 15h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
