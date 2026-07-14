import type { AgentModel } from '../../shared/contracts';
import { isTaskCreationToken } from '../../shared/contracts';
import {
  attachmentKindForFileName,
  type AttachmentKind
} from '../../shared/attachments';
import { modelAcceptsImageAttachments } from './taskAttachmentDraft';

export type AttachmentItemStatus = 'ready' | 'error';
export type AttachmentFailureOperation = 'validation';
export const MAX_VISIBLE_ATTACHMENT_VALIDATION_ERRORS = 3;

/** Renderer-owned, bounded state for one attachment chip. */
export interface AttachmentComposerItem {
  clientId: string;
  clientToken: string;
  file: File;
  kind?: AttachmentKind;
  status: AttachmentItemStatus;
  previewUrl?: string;
  error?: string;
  failureOperation?: AttachmentFailureOperation;
}

export function capAttachmentValidationFailures<
  T extends { failureOperation?: AttachmentFailureOperation }
>(items: readonly T[]): T[] {
  let toDrop = Math.max(
    0,
    items.filter((item) => item.failureOperation === 'validation').length -
      MAX_VISIBLE_ATTACHMENT_VALIDATION_ERRORS
  );
  return items.filter((item) => {
    if (item.failureOperation !== 'validation' || toDrop === 0) return true;
    toDrop -= 1;
    return false;
  });
}

export function taskCreationNeedsUnchangedRetry(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return !(
    Number.isInteger(status) &&
    (status as number) >= 400 &&
    (status as number) < 500 &&
    status !== 408 &&
    code !== 'TASK_CREATION_CONFLICT'
  );
}

export function reserveClipboardAttachmentRead(
  pending: { current: boolean },
  blocked: boolean
): boolean {
  if (blocked || pending.current) return false;
  pending.current = true;
  return true;
}

export function getOrCreateTaskCreationToken(
  holder: { current: string | undefined },
  createUuid: () => string = () => globalThis.crypto.randomUUID()
): string {
  if (holder.current !== undefined) {
    if (!isTaskCreationToken(holder.current)) {
      throw new Error('Secure task creation identifiers are unavailable.');
    }
    return holder.current;
  }
  const token = createUuid();
  if (!isTaskCreationToken(token)) {
    throw new Error('Secure task creation identifiers are unavailable.');
  }
  holder.current = token;
  return token;
}


export function shouldPreventDefaultAttachmentPaste(
  fileCount: number,
  plainText: string,
  canReadNativeImage: boolean
): boolean {
  return plainText.length === 0 && (fileCount > 0 || canReadNativeImage);
}

export function imageAttachmentModelError(
  hasImageAttachments: boolean,
  selectedModel: AgentModel | undefined
): string | undefined {
  if (!hasImageAttachments || modelAcceptsImageAttachments(selectedModel)) return undefined;
  return selectedModel
    ? 'Selected model does not accept images. Choose an image-capable model or remove them.'
    : 'The selected runtime has not reported an image-capable model yet. Wait for models to load or remove the images.';
}

export function ensurePastedFileName(file: File, index: number): File {
  if (
    attachmentKindForFileName(file.name) ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(
      file.type.toLocaleLowerCase('en-US')
    )
  ) {
    return file;
  }
  const extension =
    file.type.toLocaleLowerCase('en-US') === 'image/jpeg'
      ? 'jpg'
      : file.type.toLocaleLowerCase('en-US') === 'image/webp'
        ? 'webp'
        : 'png';
  return new File([file], `pasted-image-${Date.now()}-${index + 1}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified
  });
}
