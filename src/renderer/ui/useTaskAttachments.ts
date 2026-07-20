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
}

export interface TaskAttachmentController {
  items: AttachmentComposerItem[];
  activeItems: AttachmentComposerItem[];
  byteCount: number;
  busy: boolean;
  hasErrors: boolean;
  isDragging: boolean;
  isReadingClipboardImage: boolean;
  overflowError?: string;
  modelError?: string;
  interactionBlocked: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  closedRef: MutableRefObject<boolean>;
  selectFiles(event: ChangeEvent<HTMLInputElement>): void;
  paste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  dragEnter(event: DragEvent<HTMLDivElement>): void;
  dragOver(event: DragEvent<HTMLDivElement>): void;
  dragLeave(event: DragEvent<HTMLDivElement>): void;
  drop(event: DragEvent<HTMLDivElement>): void;
  remove(clientId: string): Promise<void>;
  prepareForCreate(): Promise<string | undefined>;
  markCreateFailed(preserveDraft: boolean): Promise<void>;
  close(): void;
}

/** Keeps file bytes renderer-local until the user submits the task. */
export function useTaskAttachments(
  options: UseTaskAttachmentsOptions
): TaskAttachmentController {
  const [items, setItems] = useState<AttachmentComposerItem[]>([]);
  const [overflowError, setOverflowError] = useState<string>();
  const [isDragging, setIsDragging] = useState(false);
  const [isReadingClipboardImage, setIsReadingClipboardImage] = useState(false);
  const itemsRef = useRef<AttachmentComposerItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const closedRef = useRef(false);
  const submittingRef = useRef(false);
  const adoptedRef = useRef(false);
  const draftIdRef = useRef<string | undefined>(undefined);
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
      if (!closedRef.current) setItems(next);
    },
    []
  );

  const releasePreview = useCallback((item: AttachmentComposerItem) => {
    if (item.previewUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  const discardDraft = useCallback(async () => {
    const draftId = draftIdRef.current;
    draftIdRef.current = undefined;
    if (draftId && !adoptedRef.current) {
      await discardRef.current(draftId).catch(() => undefined);
    }
  }, []);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    for (const item of itemsRef.current) releasePreview(item);
    void discardDraft();
  }, [discardDraft, releasePreview]);

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
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
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

  const interactionBlocked = options.blocked || !options.enabled;
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
      throw new Error('Wait for the clipboard image to finish before creating the task.');
    }
    if (draftIdRef.current) return draftIdRef.current;
    const current = active(itemsRef.current);
    const imageError = imageAttachmentModelError(
      current.some((item) => item.kind === 'image'),
      options.model
    );
    if (imageError) throw new Error(imageError);
    if (current.length === 0) return undefined;

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
      return draft.id;
    } finally {
      submittingRef.current = false;
    }
  }, [options.model, options.onStageBatch]);

  const markCreateFailed = useCallback(async (preserveDraft: boolean) => {
    adoptedRef.current = false;
    if (!preserveDraft) await discardDraft();
  }, [discardDraft]);

  return {
    items,
    activeItems,
    byteCount: totalBytes(activeItems),
    busy: isReadingClipboardImage || submittingRef.current,
    hasErrors: items.some((item) => item.status === 'error'),
    isDragging,
    isReadingClipboardImage,
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
    markCreateFailed,
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
