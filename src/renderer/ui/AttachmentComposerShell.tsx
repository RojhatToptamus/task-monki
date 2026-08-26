import type { ReactNode } from 'react';
import { Paperclip } from 'lucide-react';
import { ATTACHMENT_FILE_INPUT_ACCEPT } from '../../shared/attachments';
import type { TaskAttachmentController } from './useTaskAttachments';
import { AttachmentChip } from './AttachmentChip';

export function AttachmentComposerShell({
  attachments,
  children,
  attachmentLabel,
  addButtonTitle,
  addButtonLabel = 'Add files',
  onAddButtonClick,
  hint,
  className = '',
  removeDisabled = false,
  bindDropTarget = true
}: {
  attachments: TaskAttachmentController;
  children: ReactNode;
  attachmentLabel: string;
  addButtonTitle: string;
  addButtonLabel?: string;
  onAddButtonClick?(): void;
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
          onClick={() => {
            if (onAddButtonClick) onAddButtonClick();
            else attachments.inputRef.current?.click();
          }}
        >
          <PaperclipIcon />
          <span>{addButtonLabel}</span>
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
  return <Paperclip aria-hidden="true" absoluteStrokeWidth size={14} strokeWidth={1.5} />;
}
