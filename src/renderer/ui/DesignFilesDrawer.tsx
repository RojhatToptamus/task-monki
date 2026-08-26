import { useRef, useState } from 'react';
import type { AgentModel, TaskAttachmentRecord } from '../../shared/contracts';
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  type AttachmentDraftSnapshot,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import type { DesignProjectDetail } from '../model/designs';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { AttachmentChip } from './AttachmentChip';
import { PaperclipIcon } from './AttachmentComposerShell';
import { DisclosureChevron } from './DisclosureChevron';
import { useDialogFocusBoundary } from './dialogFocus';
import { UiCheckIcon, UiCloseIcon, UiFileIcon } from './UiIcons';
import { useTaskAttachments } from './useTaskAttachments';

export function DesignFilesDrawer({
  project,
  models,
  selectedReferenceIds,
  onSelectionChange,
  onClose,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onAddReferences,
  onRemoveReference,
  onImportReferenceAsset
}: {
  project: DesignProjectDetail;
  models: AgentModel[];
  selectedReferenceIds: string[];
  onSelectionChange(referenceIds: string[]): void;
  onClose(): void;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onAddReferences(attachmentDraftId: string): Promise<void>;
  onRemoveReference(referenceId: string): Promise<void>;
  onImportReferenceAsset(referenceId: string): Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const chooseFilesRef = useRef<HTMLButtonElement>(null);
  const selectedModel = models.find(
    (model) =>
      model.runtimeId === project.task.runtimeId &&
      model.model === project.task.agentSettings?.model
  );
  const [submitting, setSubmitting] = useState(false);
  const [referenceActionId, setReferenceActionId] = useState<string>();
  const [error, setError] = useState<string>();
  const attachments = useTaskAttachments({
    enabled: true,
    blocked: submitting,
    model: selectedModel,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: (draftId) => onDiscardAttachmentDraft({ draftId }),
    onReadClipboardImage
  });
  const activeReferences = project.references.filter(
    (reference) => reference.state === 'ACTIVE'
  );
  const inactiveReferences = project.references.filter(
    (reference) => reference.state === 'INACTIVE'
  );
  const assetImportBlocked = Boolean(
    (project.currentRun &&
      [
        'QUEUED',
        'STARTING',
        'RUNNING',
        'AWAITING_APPROVAL',
        'AWAITING_USER_INPUT',
        'INTERRUPTING',
        'RECOVERY_REQUIRED'
      ].includes(project.currentRun.status)) ||
      project.turns.some((turn) => turn.outcome === undefined)
  );

  useDialogFocusBoundary({
    dialogRef,
    initialFocusRef: chooseFilesRef,
    busy: submitting || Boolean(referenceActionId),
    trapFocus: false,
    onClose
  });

  const addReferences = async () => {
    if (submitting || attachments.activeItems.length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const draftId = await attachments.prepareForCreate();
      if (!draftId) return;
      await onAddReferences(draftId);
      await attachments.finishAdoption();
    } catch (caught) {
      await attachments.markCreateFailed(true);
      setError(caught instanceof Error ? caught.message : 'Could not add the references.');
    } finally {
      setSubmitting(false);
    }
  };

  const runReferenceAction = async (
    referenceId: string,
    action: () => Promise<void>,
    fallback: string
  ) => {
    if (referenceActionId) return;
    setReferenceActionId(referenceId);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setReferenceActionId(undefined);
    }
  };

  return (
    <aside
      ref={dialogRef}
      id="design-files-drawer"
      className="tm-design-files"
      role="dialog"
      aria-labelledby="design-files-title"
      tabIndex={-1}
      onPaste={attachments.paste}
      onDragEnter={attachments.dragEnter}
      onDragOver={attachments.dragOver}
      onDragLeave={attachments.dragLeave}
      onDrop={attachments.drop}
    >
      <header className="tm-design-files__head">
        <div>
          <h2 id="design-files-title">Files and references</h2>
          <p>Checked items ride along with your next message.</p>
        </div>
        <button type="button" aria-label="Close files and references" onClick={onClose}>
          <UiCloseIcon size={12} />
        </button>
      </header>

      <div className="tm-design-files__body">
        <section className="tm-design-files__upload" aria-label="Add references">
          <div
            className={`tm-design-reference-add ${attachments.isDragging ? 'tm-design-reference-add--dragging' : ''}`}
          >
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
              ref={chooseFilesRef}
              type="button"
              disabled={attachments.interactionBlocked}
              onClick={() => attachments.inputRef.current?.click()}
            >
              <PaperclipIcon />
              <strong>Choose files</strong>
              <span>
                {attachments.isReadingClipboardImage
                  ? 'Reading clipboard…'
                  : attachments.activeItems.length > 0
                    ? `${attachments.activeItems.length} selected`
                    : 'or drop here'}
              </span>
            </button>
          </div>
          {attachments.items.length > 0 ? (
            <ul className="task-attachments" aria-label="References to add">
              {attachments.items.map((item) => (
                <AttachmentChip
                  key={item.clientId}
                  item={item}
                  disabled={submitting}
                  onRemove={() => void attachments.remove(item.clientId)}
                />
              ))}
            </ul>
          ) : null}
          {attachments.overflowError || attachments.modelError ? (
            <p className="tm-design-files__error" role="alert">
              {attachments.overflowError ?? attachments.modelError}
            </p>
          ) : null}
          {attachments.activeItems.length > 0 ? (
            <button
              type="button"
              className="primary-button tm-design-reference-add__submit"
              disabled={
                submitting ||
                attachments.busy ||
                attachments.hasErrors ||
                Boolean(attachments.modelError)
              }
              onClick={() => void addReferences()}
            >
              {submitting ? 'Adding…' : 'Add references'}
            </button>
          ) : null}
        </section>

        <section className="tm-design-files__section" aria-labelledby="design-active-references-title">
          <div className="tm-design-files__section-title">
            <h3 id="design-active-references-title">In this task</h3>
            {activeReferences.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  onSelectionChange(
                    selectedReferenceIds.length > 0
                      ? []
                      : activeReferences.map((reference) => reference.id)
                  )
                }
              >
                {selectedReferenceIds.length > 0 ? 'Select none' : 'Select all'}
              </button>
            ) : null}
          </div>
          {activeReferences.length === 0 ? (
            <p className="tm-design-files__empty">No references in this Design.</p>
          ) : (
            <ul className="tm-design-reference-list">
              {activeReferences.map((reference) => (
                <DesignReferenceRow
                  key={reference.id}
                  attachment={attachmentForReference(project, reference.attachmentId)}
                  assetPath={reference.projectAssetPath}
                  selected={selectedReferenceIds.includes(reference.id)}
                  busy={referenceActionId === reference.id}
                  importDisabled={assetImportBlocked}
                  onSelectedChange={(selected) =>
                    onSelectionChange(
                      selected
                        ? [...new Set([...selectedReferenceIds, reference.id])]
                        : selectedReferenceIds.filter((id) => id !== reference.id)
                    )
                  }
                  onImport={() =>
                    runReferenceAction(
                      reference.id,
                      () => onImportReferenceAsset(reference.id),
                      'Could not import the project asset.'
                    )
                  }
                  onRemove={() =>
                    runReferenceAction(
                      reference.id,
                      () => onRemoveReference(reference.id),
                      'Could not remove the reference.'
                    )
                  }
                />
              ))}
            </ul>
          )}
          {inactiveReferences.length > 0 ? (
            <details className="tm-design-reference-history">
              <summary><DisclosureChevron /><span>{inactiveReferences.length} removed</span></summary>
              <ul className="tm-design-reference-list">
                {inactiveReferences.map((reference) => {
                  const attachment = attachmentForReference(project, reference.attachmentId);
                  return (
                    <li key={reference.id} className="tm-design-reference-row tm-design-reference-row--inactive">
                      <span className="tm-design-reference-row__preview" aria-hidden="true">
                        <UiFileIcon kind={attachment.kind} />
                      </span>
                      <span>
                        <strong title={attachment.displayName}>{attachment.displayName}</strong>
                        <small>
                          Removed{reference.projectAssetPath ? ` · ${reference.projectAssetPath}` : ''}
                        </small>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>

        <details className="tm-design-project-files-section">
          <summary>
            <span className="tm-design-project-files-section__label">
              <DisclosureChevron />
              Project files
            </span>
            <span>{project.projectFiles.length}</span>
          </summary>
          {project.projectFiles.length === 0 ? (
            <p className="tm-design-files__empty">No project files found.</p>
          ) : (
            <ul className="tm-design-project-files">
              {project.projectFiles.map((file) => (
                <li key={file.path}>
                  <span title={file.path}>{file.path}</span>
                  <small>{formatAttachmentBytes(file.byteCount)}</small>
                </li>
              ))}
            </ul>
          )}
          {project.projectFilesTruncated ? (
            <p className="tm-design-files__note">Only the first 500 files are shown.</p>
          ) : null}
        </details>
        {error ? <p className="tm-design-files__error" role="alert">{error}</p> : null}
      </div>
    </aside>
  );
}

function DesignReferenceRow({
  attachment,
  assetPath,
  selected,
  busy,
  importDisabled,
  onSelectedChange,
  onImport,
  onRemove
}: {
  attachment: TaskAttachmentRecord;
  assetPath?: string;
  selected: boolean;
  busy: boolean;
  importDisabled: boolean;
  onSelectedChange(selected: boolean): void;
  onImport(): void;
  onRemove(): void;
}) {
  return (
    <li className={`tm-design-reference-row ${selected ? 'tm-design-reference-row--selected' : ''}`}>
      <label>
        <input
          className="tm-visually-hidden"
          type="checkbox"
          checked={selected}
          disabled={busy}
          onChange={(event) => onSelectedChange(event.target.checked)}
        />
        <span className="tm-design-reference-row__check" aria-hidden="true">
          {selected ? <UiCheckIcon /> : null}
        </span>
        <span className="tm-design-reference-row__preview" aria-hidden="true">
          <UiFileIcon kind={attachment.kind} />
        </span>
        <span>
          <strong title={attachment.displayName}>{attachment.displayName}</strong>
          <small>
            {assetPath ?? `${formatAttachmentBytes(attachment.byteCount)} · read-only`}
          </small>
        </span>
      </label>
      <div className="tm-design-reference-row__actions">
        {!assetPath && !importDisabled ? (
          <button
            type="button"
            disabled={busy}
            title="Copy into the project so Codex can edit it."
            onClick={onImport}
          >
            Import
          </button>
        ) : assetPath ? (
          <span>In project</span>
        ) : null}
        <button type="button" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}

function attachmentForReference(
  project: DesignProjectDetail,
  attachmentId: string
): TaskAttachmentRecord {
  const attachment = project.attachments.find(
    (candidate) => candidate.id === attachmentId
  );
  if (!attachment) throw new Error('A Design reference is missing its attachment.');
  return attachment;
}
