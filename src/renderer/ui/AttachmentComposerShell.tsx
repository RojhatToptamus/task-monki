import type { ReactNode } from 'react';
import { ATTACHMENT_FILE_INPUT_ACCEPT } from '../../shared/attachments';
import type { TaskAttachmentController } from './useTaskAttachments';
import { AttachmentChip } from './AttachmentChip';

export function AttachmentComposerShell({
  attachments,
  children,
  attachmentLabel,
  addButtonTitle,
  hint,
  className = '',
  removeDisabled = false,
  bindDropTarget = true
}: {
  attachments: TaskAttachmentController;
  children: ReactNode;
  attachmentLabel: string;
  addButtonTitle: string;
  hint: ReactNode;
  className?: string;
  removeDisabled?: boolean;
  bindDropTarget?: boolean;
}) {
  return (
    <div
      className={`field__prompt-shell ${className} ${
        attachments.isDragging ? 'field__prompt-shell--dragging' : ''
      }`.trim()}
      onDragEnter={bindDropTarget ? attachments.dragEnter : undefined}
      onDragOver={bindDropTarget ? attachments.dragOver : undefined}
      onDragLeave={bindDropTarget ? attachments.dragLeave : undefined}
      onDrop={bindDropTarget ? attachments.drop : undefined}
    >
      {children}
      {attachments.items.length > 0 ? (
        <ul className="task-attachments" aria-label={attachmentLabel}>
          {attachments.items.map((item) => (
            <AttachmentChip
              key={item.clientId}
              item={item}
              disabled={removeDisabled || attachments.interactionBlocked}
              onRemove={() => void attachments.remove(item.clientId)}
            />
          ))}
        </ul>
      ) : null}
      <div className="field__prompt-toolbar">
        <input
          ref={attachments.inputRef}
          className="task-attachment-input"
          type="file"
          multiple
          accept={ATTACHMENT_FILE_INPUT_ACCEPT}
          disabled={attachments.interactionBlocked}
          tabIndex={-1}
          aria-hidden="true"
          onChange={attachments.selectFiles}
        />
        <button
          type="button"
          className="task-attachment-add"
          disabled={attachments.interactionBlocked}
          title={addButtonTitle}
          onClick={() => attachments.inputRef.current?.click()}
        >
          <PaperclipIcon />
          <span>Add files</span>
        </button>
        <span className="task-attachment-hint">{hint}</span>
      </div>
      {attachments.isDragging ? (
        <div className="task-attachment-drop" aria-hidden="true">
          <PaperclipIcon />
          <span>Drop to attach</span>
        </div>
      ) : null}
    </div>
  );
}

export function PaperclipIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="m9.5 12.5 5.7-5.7a3.2 3.2 0 0 1 4.5 4.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.1-8.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
