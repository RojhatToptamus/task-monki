import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  type RefObject
} from 'react';
import type { AgentModel } from '../../shared/contracts';
import type {
  AttachmentContent,
  AttachmentDraftSnapshot,
  ClipboardAttachmentImage,
  StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import {
  capAttachmentValidationFailures,
  ensurePastedFileName,
  imageAttachmentModelError,
  MAX_VISIBLE_ATTACHMENT_VALIDATION_ERRORS,
  reserveClipboardAttachmentRead,
  shouldPreventDefaultAttachmentPaste,
  type AttachmentComposerItem
} from '../model/taskAttachmentComposer';
import {
  admitAttachmentFiles,
  createAttachmentClientToken,
  prepareImageAttachment
} from '../model/taskAttachmentDraft';

interface UseTaskAttachmentsOptions {
  enabled: boolean;
  blocked: boolean;
  model?: AgentModel;
  onStageBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscard(draftId: string): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  initialDraft?: AttachmentDraftSnapshot;
  onReadDraftAttachment?(attachmentId: string): Promise<AttachmentContent>;
  preserveDraftOnClose?: boolean;
}

export interface TaskAttachmentController {
  items: AttachmentComposerItem[];
  activeItems: AttachmentComposerItem[];
  byteCount: number;
  busy: boolean;
  hasErrors: boolean;
  isDragging: boolean;
  isReadingClipboardImage: boolean;
  isRestoringDraft: boolean;
  contentRevision: number;
  overflowError?: string;
  modelError?: string;
  interactionBlocked: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  closedRef: MutableRefObject<boolean>;
  selectFiles(event: ChangeEvent<HTMLInputElement>): void;
  paste(event: ClipboardEvent<HTMLElement>): void;
  dragEnter(event: DragEvent<HTMLDivElement>): void;
  dragOver(event: DragEvent<HTMLDivElement>): void;
  dragLeave(event: DragEvent<HTMLDivElement>): void;
  drop(event: DragEvent<HTMLDivElement>): void;
  remove(clientId: string): Promise<void>;
  prepareForCreate(): Promise<string | undefined>;
  acknowledgeDraftSave(draftId: string | undefined): Promise<void>;
  markCreateFailed(preserveDraft: boolean): Promise<void>;
  finishAdoption(): Promise<void>;
  close(): void;
}

/** Owns one bounded attachment selection and its existing staging lifecycle. */
export function useTaskAttachments(
  options: UseTaskAttachmentsOptions
): TaskAttachmentController {
  const [items, setItems] = useState<AttachmentComposerItem[]>([]);
  const [overflowError, setOverflowError] = useState<string>();
  const [isDragging, setIsDragging] = useState(false);
  const [isReadingClipboardImage, setIsReadingClipboardImage] = useState(false);
  const [isRestoringDraft, setIsRestoringDraft] = useState(false);
  const [draftRestoreFailed, setDraftRestoreFailed] = useState(false);
  const [contentRevision, setContentRevision] = useState(0);
  const itemsRef = useRef<AttachmentComposerItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const closedRef = useRef(false);
  const submittingRef = useRef(false);
  const draftIdRef = useRef<string | undefined>(undefined);
  const durableDraftIdRef = useRef<string | undefined>(undefined);
  const durableRevisionRef = useRef(-1);
  const preparedRevisionRef = useRef(-1);
  const contentRevisionRef = useRef(0);
  const knownDraftIdsRef = useRef(new Set<string>());
  const restoredDraftIdRef = useRef<string | undefined>(undefined);
  const sequenceRef = useRef(0);
  const dragDepthRef = useRef(0);
  const clipboardReadPendingRef = useRef(false);
  const blockedRef = useRef(options.blocked);
  const discardRef = useRef(options.onDiscard);
  blockedRef.current = options.blocked;
  discardRef.current = options.onDiscard;

  const updateItems = useCallback(
    (update: (current: AttachmentComposerItem[]) => AttachmentComposerItem[]) => {
      const next = capAttachmentValidationFailures(update(itemsRef.current));
      itemsRef.current = next;
      contentRevisionRef.current += 1;
      setContentRevision(contentRevisionRef.current);
      if (!closedRef.current) setItems(next);
    },
    []
  );

  const releasePreview = useCallback((item: AttachmentComposerItem) => {
    if (item.previewUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  const discardDraftsExcept = useCallback(async (retainedDraftId?: string) => {
    const discardIds = [...knownDraftIdsRef.current].filter(
      (draftId) => draftId !== retainedDraftId
    );
    knownDraftIdsRef.current = new Set(retainedDraftId ? [retainedDraftId] : []);
    await Promise.all(
      discardIds.map((draftId) => discardRef.current(draftId).catch(() => undefined))
    );
  }, []);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    for (const item of itemsRef.current) releasePreview(item);
    if (!options.preserveDraftOnClose) void discardDraftsExcept();
  }, [discardDraftsExcept, options.preserveDraftOnClose, releasePreview]);

  useEffect(() => {
    closedRef.current = false;
    return close;
  }, [close]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (!options.enabled || blockedRef.current || closedRef.current || files.length === 0) {
        return;
      }
      const current = active(itemsRef.current);
      const admission = admitAttachmentFiles(files, {
        count: current.length,
        byteCount: totalBytes(current)
      });
      const accepted = admission.admitted.map<AttachmentComposerItem>(({ file, kind }) => ({
        clientId: nextClientId(sequenceRef),
        clientToken: createAttachmentClientToken(),
        file: file as File,
        kind,
        status: 'ready',
        previewUrl:
          kind === 'image' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file as File)
            : undefined,
      }));
      const rejected = admission.rejected
        .slice(0, MAX_VISIBLE_ATTACHMENT_VALIDATION_ERRORS)
        .map<AttachmentComposerItem>(({ file, reason }) => ({
          clientId: nextClientId(sequenceRef),
          clientToken: createAttachmentClientToken(),
          file: file as File,
          status: 'error',
          error: reason,
          failureOperation: 'validation'
        }));
      updateItems((existing) => [...existing, ...accepted, ...rejected]);
      setOverflowError(
        admission.rejected.length > rejected.length
          ? `${admission.rejected.length - rejected.length} more files were not added.`
          : undefined
      );
    },
    [options.enabled, updateItems]
  );

  useEffect(() => {
    const draft = options.initialDraft;
    if (!draft || restoredDraftIdRef.current === draft.id) return;
    if (draftIdRef.current === draft.id) {
      restoredDraftIdRef.current = draft.id;
      return;
    }
    if (!options.onReadDraftAttachment) {
      setOverflowError('Saved draft files cannot be read in this app build.');
      return;
    }
    restoredDraftIdRef.current = draft.id;
    draftIdRef.current = draft.id;
    durableDraftIdRef.current = draft.id;
    knownDraftIdsRef.current.add(draft.id);
    const restoredRevision = contentRevisionRef.current;
    preparedRevisionRef.current = restoredRevision;
    durableRevisionRef.current = restoredRevision;
    setDraftRestoreFailed(false);
    setIsRestoringDraft(true);
    void Promise.all(
      draft.attachments.map(async (record) => {
        const content = await options.onReadDraftAttachment!(record.id);
        if (
          content.attachmentId !== record.id ||
          content.displayName !== record.displayName ||
          content.kind !== record.kind ||
          content.mediaType !== record.mediaType ||
          content.byteCount !== record.byteCount ||
          content.bytes.byteLength !== record.byteCount
        ) {
          throw new Error('Saved draft attachment metadata changed.');
        }
        const file = new File([content.bytes], content.displayName, {
          type: content.mediaType
        });
        return {
          clientId: nextClientId(sequenceRef),
          clientToken: record.clientToken ?? createAttachmentClientToken(),
          file,
          kind: record.kind,
          status: 'ready' as const,
          previewUrl:
            record.kind === 'image' && typeof URL.createObjectURL === 'function'
              ? URL.createObjectURL(file)
              : undefined
        };
      })
    )
      .then((restored) => {
        if (closedRef.current) {
          for (const item of restored) releasePreview(item);
          return;
        }
        itemsRef.current = restored;
        setItems(restored);
      })
      .catch((error: unknown) => {
        if (!closedRef.current) {
          setDraftRestoreFailed(true);
          setOverflowError(
            error instanceof Error
              ? error.message
              : 'Saved draft files could not be loaded.'
          );
        }
      })
      .finally(() => {
        if (!closedRef.current) setIsRestoringDraft(false);
      });
  }, [options.initialDraft, options.onReadDraftAttachment, releasePreview]);

  const remove = useCallback(
    async (clientId: string) => {
      if (blockedRef.current) return;
      const item = itemsRef.current.find((candidate) => candidate.clientId === clientId);
      if (!item) return;
      releasePreview(item);
      updateItems((current) => current.filter((candidate) => candidate.clientId !== clientId));
    },
    [releasePreview, updateItems]
  );

  const selectFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = '';
    },
    [addFiles]
  );

  const paste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const plainText = event.clipboardData.getData('text/plain');
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map(ensurePastedFileName);
      if (!options.enabled) {
        if (files.length > 0 && plainText.length === 0) event.preventDefault();
        return;
      }
      if (files.length > 0) {
        if (shouldPreventDefaultAttachmentPaste(files.length, plainText, false)) {
          event.preventDefault();
        }
        addFiles(files);
        return;
      }
      if (plainText.length > 0 || !options.onReadClipboardImage) return;
      event.preventDefault();
      if (!reserveClipboardAttachmentRead(clipboardReadPendingRef, blockedRef.current)) return;
      setIsReadingClipboardImage(true);
      void options.onReadClipboardImage()
        .then((image) => {
          if (image && !closedRef.current && !blockedRef.current) {
            addFiles([new File([image.bytes], image.displayName, { type: image.mediaType })]);
          }
        })
        .catch((error: unknown) => {
          if (!closedRef.current) {
            setOverflowError(error instanceof Error ? error.message : 'The clipboard image could not be read.');
          }
        })
        .finally(() => {
          clipboardReadPendingRef.current = false;
          if (!closedRef.current) setIsReadingClipboardImage(false);
        });
    },
    [addFiles, options.enabled, options.onReadClipboardImage]
  );

  const interactionBlocked = options.blocked || !options.enabled || isRestoringDraft;
  const dragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = interactionBlocked ? 'none' : 'copy';
    if (!interactionBlocked) {
      dragDepthRef.current += 1;
      setIsDragging(true);
    }
  }, [interactionBlocked]);
  const dragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = interactionBlocked ? 'none' : 'copy';
  }, [interactionBlocked]);
  const dragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);
  const drop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (!interactionBlocked) addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles, interactionBlocked]);

  const activeItems = active(items);
  const modelError = imageAttachmentModelError(
    activeItems.some((item) => item.kind === 'image'),
    options.model
  );

  const prepareForCreate = useCallback(async () => {
    if (clipboardReadPendingRef.current) {
      throw new Error('Wait for the clipboard image to finish before continuing.');
    }
    if (
      draftIdRef.current &&
      preparedRevisionRef.current === contentRevisionRef.current
    ) {
      return draftIdRef.current;
    }
    const current = active(itemsRef.current);
    const imageError = imageAttachmentModelError(
      current.some((item) => item.kind === 'image'),
      options.model
    );
    if (imageError) throw new Error(imageError);
    if (current.length === 0) {
      draftIdRef.current = undefined;
      preparedRevisionRef.current = contentRevisionRef.current;
      return undefined;
    }

    submittingRef.current = true;
    try {
      const attachments = [];
      for (const item of current) {
        const file = item.kind === 'image'
          ? (await prepareImageAttachment(item.file)).file
          : item.file;
        attachments.push({
          clientToken: item.clientToken,
          displayName: file.name,
          declaredMediaType: file.type || undefined,
          bytes: await file.arrayBuffer()
        });
      }
      const draft = await options.onStageBatch({ attachments });
      draftIdRef.current = draft.id;
      knownDraftIdsRef.current.add(draft.id);
      preparedRevisionRef.current = contentRevisionRef.current;
      return draft.id;
    } finally {
      submittingRef.current = false;
    }
  }, [options.model, options.onStageBatch]);

  const acknowledgeDraftSave = useCallback(async (draftId: string | undefined) => {
    draftIdRef.current = draftId;
    durableDraftIdRef.current = draftId;
    durableRevisionRef.current = contentRevisionRef.current;
    if (draftId) restoredDraftIdRef.current = draftId;
    await discardDraftsExcept(draftId);
  }, [discardDraftsExcept]);

  const markCreateFailed = useCallback(async (preserveDraft: boolean) => {
    if (preserveDraft) return;
    const currentDraftId = draftIdRef.current;
    if (currentDraftId && currentDraftId !== durableDraftIdRef.current) {
      knownDraftIdsRef.current.delete(currentDraftId);
      await discardRef.current(currentDraftId).catch(() => undefined);
    }
    draftIdRef.current = durableDraftIdRef.current;
    preparedRevisionRef.current = durableRevisionRef.current;
  }, []);

  const finishAdoption = useCallback(async () => {
    const adoptedDraftId = draftIdRef.current;
    const obsoleteDraftIds = [...knownDraftIdsRef.current].filter(
      (draftId) => draftId !== adoptedDraftId
    );
    draftIdRef.current = undefined;
    durableDraftIdRef.current = undefined;
    knownDraftIdsRef.current.clear();
    preparedRevisionRef.current = -1;
    durableRevisionRef.current = -1;
    for (const item of itemsRef.current) releasePreview(item);
    itemsRef.current = [];
    setItems([]);
    contentRevisionRef.current += 1;
    setContentRevision(contentRevisionRef.current);
    setOverflowError(undefined);
    await Promise.all(
      obsoleteDraftIds.map((draftId) => discardRef.current(draftId).catch(() => undefined))
    );
  }, [releasePreview]);

  return {
    items,
    activeItems,
    byteCount: totalBytes(activeItems),
    busy: isReadingClipboardImage || isRestoringDraft || submittingRef.current,
    hasErrors:
      draftRestoreFailed || items.some((item) => item.status === 'error'),
    isDragging,
    isReadingClipboardImage,
    isRestoringDraft,
    contentRevision,
    overflowError,
    modelError,
    interactionBlocked,
    inputRef,
    closedRef,
    selectFiles,
    paste,
    dragEnter,
    dragOver,
    dragLeave,
    drop,
    remove,
    prepareForCreate,
    acknowledgeDraftSave,
    markCreateFailed,
    finishAdoption,
    close
  };
}

function active(items: readonly AttachmentComposerItem[]): AttachmentComposerItem[] {
  return items.filter((item) => item.status !== 'error');
}

function totalBytes(items: readonly AttachmentComposerItem[]): number {
  return items.reduce((total, item) => total + item.file.size, 0);
}

function nextClientId(sequence: { current: number }): string {
  sequence.current += 1;
  return `attachment-${sequence.current}`;
}

function dragContainsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}
