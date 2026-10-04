import { useEffect, useState, type ReactNode } from 'react';
import type { AgentModel } from '../../shared/contracts';
import type { AttachmentDraftSnapshot } from '../../shared/attachments';
import { taskManagerApi } from '../api/taskManagerClient';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { useTaskAttachments, type TaskAttachmentController } from './useTaskAttachments';

/** Mounted per conversation so pending file reads cannot cross composer scopes. */
export function DiscourseComposer({ draftId, blocked, model, validateModel, onPersistDraft, children, mode, actions }: {
  draftId?: string;
  blocked: boolean;
  model?: AgentModel;
  validateModel: boolean;
  onPersistDraft(draftId: string | undefined): Promise<void>;
  children(files: TaskAttachmentController): ReactNode;
  mode: ReactNode;
  actions(files: TaskAttachmentController): ReactNode;
}) {
  const [restoringId] = useState(draftId);
  const [initialDraft, setInitialDraft] = useState<AttachmentDraftSnapshot>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    if (!restoringId) return;
    let canceled = false;
    void taskManagerApi.getAttachmentDraft(restoringId).then((draft) => {
      if (!canceled) setInitialDraft(draft);
    }).catch((error: unknown) => {
      if (!canceled) setLoadError(error instanceof Error ? error.message : 'Files could not be restored.');
    });
    return () => { canceled = true; };
  }, [restoringId]);
  const files = useTaskAttachments({
    enabled: true,
    model,
    validateModel,
    blocked: blocked || Boolean(restoringId && !initialDraft),
    initialDraft,
    preserveDraftOnClose: true,
    onPersistDraft,
    onStageBatch: taskManagerApi.stageTaskAttachmentBatch,
    onDiscard: (id) => taskManagerApi.discardTaskAttachmentDraft({ draftId: id }),
    onReadClipboardImage: taskManagerApi.readClipboardImage,
    onReadDraftAttachment: (attachmentId) => taskManagerApi.readTaskAttachment({ attachmentId, draftId: restoringId })
  });
  const error = loadError ?? files.draftError ?? files.modelError ?? files.overflowError;
  return <AttachmentComposerShell attachments={files} className="tm-discourse-composer"
    attachmentLabel="Message files" addButtonTitle="Attach files" hint="" toolbarStart={mode} toolbarAction={actions(files)}>
    {children(files)}
    {error ? <p className="tm-error" role="alert">{error}</p> : null}
  </AttachmentComposerShell>;
}
