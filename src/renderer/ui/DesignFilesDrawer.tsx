import { useState } from 'react';
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
  const selectedModel = models.find(
    (model) =>
      model.runtimeId === project.task.runtimeId &&
      model.model === project.task.agentSettings.model
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
      id="design-files-drawer"
      className="tm-design-files"
      aria-label="Files and references"
      tabIndex={-1}
      onPaste={attachments.paste}
      onDragEnter={attachments.dragEnter}
      onDragOver={attachments.dragOver}
      onDragLeave={attachments.dragLeave}
      onDrop={attachments.drop}
    >
      <header className="tm-design-files__head">
        <div>
          <h2>Files and references</h2>
          <p>Choose which references Codex receives with your next message.</p>
        </div>
        <button type="button" aria-label="Close files and references" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="tm-design-files__body">
        <section className="tm-design-files__section" aria-labelledby="design-add-reference-title">
          <div className="tm-design-files__section-title">
            <h3 id="design-add-reference-title">Add references</h3>
            <span>Text or images</span>
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
              type="button"
              className="outline-button"
              disabled={attachments.interactionBlocked}
              onClick={() => attachments.inputRef.current?.click()}
            >
              <PaperclipIcon />
              Choose files
            </button>
            <span>
              {attachments.isReadingClipboardImage
                ? 'Reading clipboard image…'
                : attachments.activeItems.length > 0
                  ? `${attachments.activeItems.length} selected · ${formatAttachmentBytes(attachments.byteCount)}`
                  : 'Paste or drop files here'}
            </span>
          </div>
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
            <h3 id="design-active-references-title">References</h3>
            <span>{activeReferences.length} active</span>
          </div>
          {activeReferences.length === 0 ? (
            <p className="tm-design-files__empty">No active references.</p>
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
              <summary>{inactiveReferences.length} removed</summary>
              <ul className="tm-design-reference-list">
                {inactiveReferences.map((reference) => {
                  const attachment = attachmentForReference(project, reference.attachmentId);
                  return (
                    <li key={reference.id} className="tm-design-reference-row tm-design-reference-row--inactive">
                      <FileKindIcon kind={attachment.kind} />
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

        <section className="tm-design-files__section" aria-labelledby="design-project-files-title">
          <div className="tm-design-files__section-title">
            <h3 id="design-project-files-title">Project files</h3>
            <span>{project.projectFiles.length}</span>
          </div>
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
        </section>
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
    <li className="tm-design-reference-row">
      <label>
        <input
          type="checkbox"
          checked={selected}
          disabled={busy}
          onChange={(event) => onSelectedChange(event.target.checked)}
        />
        <FileKindIcon kind={attachment.kind} />
        <span>
          <strong title={attachment.displayName}>{attachment.displayName}</strong>
          <small>
            {assetPath ?? `${formatAttachmentBytes(attachment.byteCount)} · read-only`}
          </small>
        </span>
      </label>
      <div className="tm-design-reference-row__actions">
        {!assetPath ? (
          <button
            type="button"
            disabled={busy || importDisabled}
            title={
              importDisabled
                ? 'Wait for Design work to finish before importing an asset.'
                : 'Copy into the project so Codex can edit it.'
            }
            onClick={onImport}
          >
            Import
          </button>
        ) : (
          <span>Asset</span>
        )}
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

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5.2 8.7 4-4a2.1 2.1 0 0 1 3 3l-5.1 5.1a3 3 0 0 1-4.3-4.2l5-5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function FileKindIcon({ kind }: { kind: TaskAttachmentRecord['kind'] }) {
  return (
    <svg className="tm-design-reference-row__icon" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4 2.5h6l4 4v9H4z" />
      <path d="M10 2.5v4h4" />
      {kind === 'image' ? <path d="m6 12 2-2 1.5 1.5 1-1 1.5 1.5" /> : <path d="M6.5 9h5M6.5 11.5h4" />}
    </svg>
  );
}
