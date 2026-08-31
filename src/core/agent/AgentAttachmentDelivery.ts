import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentModel } from '../../shared/agent';
import type {
  AgentAttachmentSelection,
  AttachmentSubmissionRecord,
  StagedAttachmentRecord,
  TaskAttachmentRecord
} from '../../shared/attachments';
import { posixModeMatches } from '../filesystem/secureFilesystem';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A task attachment after Task Monki has verified its immutable task-owned file.
 *
 * The path is deliberately supplied by core storage instead of the renderer. It
 * must point at a read-only managed file. Original user paths must never cross
 * this boundary.
 */
export interface AgentTurnAttachment
  extends AgentAttachmentSelection {
  displayName: string;
  path: string;
  verifiedAt: string;
}

export type AttachmentSubmissionCandidate = Omit<
  AttachmentSubmissionRecord,
  'correlation' | 'submittedAt'
>;

export function completeAttachmentSubmissions(
  candidates: readonly AttachmentSubmissionCandidate[],
  correlation: AttachmentSubmissionRecord['correlation'],
  submittedAt: string
): AttachmentSubmissionRecord[] {
  return candidates.map((candidate) => ({
    ...candidate,
    correlation,
    submittedAt
  }));
}

export interface VerifiedAgentTurnAttachment extends AgentTurnAttachment {
  /** Present only when the provider adapter requested inline delivery. */
  bytes?: Uint8Array;
}

export class AgentAttachmentDeliveryError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ATTACHMENT_DELIVERY'
      | 'ATTACHMENT_MISSING'
      | 'ATTACHMENT_NOT_REGULAR'
      | 'ATTACHMENT_NOT_READ_ONLY'
      | 'ATTACHMENT_SIZE_MISMATCH'
      | 'ATTACHMENT_HASH_MISMATCH'
      | 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    message: string
  ) {
    super(message);
    this.name = 'AgentAttachmentDeliveryError';
  }
}

export function toAgentTurnAttachments(
  verified: readonly {
    record: TaskAttachmentRecord | StagedAttachmentRecord;
    absolutePath: string;
  }[],
  verifiedAt = new Date().toISOString()
): AgentTurnAttachment[] {
  return verified.map(({ record, absolutePath }) => ({
    attachmentId: record.id,
    ordinal: record.ordinal,
    displayName: record.displayName,
    kind: record.kind,
    mediaType: record.mediaType,
    byteCount: record.byteCount,
    sha256: record.sha256,
    path: absolutePath,
    verifiedAt
  }));
}

export function toAgentAttachmentSelection(
  attachments: readonly Pick<
    AgentTurnAttachment,
    'attachmentId' | 'ordinal' | 'kind' | 'mediaType' | 'byteCount' | 'sha256'
  >[]
): AgentAttachmentSelection[] {
  return attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    ordinal: attachment.ordinal,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    byteCount: attachment.byteCount,
    sha256: attachment.sha256
  }));
}

export function toAgentAttachmentSelectionFromRecords(
  attachments: readonly (TaskAttachmentRecord | StagedAttachmentRecord)[]
): AgentAttachmentSelection[] {
  return attachments.map((attachment) => ({
    attachmentId: attachment.id,
    ordinal: attachment.ordinal,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    byteCount: attachment.byteCount,
    sha256: attachment.sha256
  }));
}

export function assertAgentTurnAttachmentSelection(
  expected: readonly AgentAttachmentSelection[],
  attachments: readonly AgentTurnAttachment[]
): void {
  const actual = toAgentAttachmentSelection(attachments);
  if (
    actual.length !== expected.length ||
    actual.some((attachment, index) => {
      const selected = expected[index];
      return (
        !selected ||
        attachment.attachmentId !== selected.attachmentId ||
        attachment.ordinal !== selected.ordinal ||
        attachment.kind !== selected.kind ||
        attachment.mediaType !== selected.mediaType ||
        attachment.byteCount !== selected.byteCount ||
        attachment.sha256 !== selected.sha256
      );
    })
  ) {
    throw new AgentAttachmentDeliveryError(
      'INVALID_ATTACHMENT_DELIVERY',
      'Provider attachments do not match the stored run selection.'
    );
  }
}

/**
 * Re-verifies the task-owned file immediately before provider submission.
 * This second check prevents a stale or replaced file from being submitted.
 */
export async function verifyAgentTurnAttachments(
  attachments: readonly AgentTurnAttachment[],
  options: {
    includeBytes?: (attachment: AgentTurnAttachment) => boolean;
  } = {}
): Promise<VerifiedAgentTurnAttachment[]> {
  validateAttachments(attachments);
  return Promise.all(
    attachments.map((attachment) =>
      verifyAttachment(attachment, options.includeBytes?.(attachment) ?? false)
    )
  );
}

export function assertModelSupportsAttachments(
  model: AgentModel,
  attachments: readonly Pick<AgentTurnAttachment, 'kind'>[]
): void {
  if (
    attachments.some((attachment) => attachment.kind === 'image') &&
    !model.inputModalities.some((modality) => modality.toLowerCase() === 'image')
  ) {
    throw new AgentAttachmentDeliveryError(
      'MODEL_DOES_NOT_SUPPORT_IMAGES',
      `${model.displayName} does not accept image attachments. Choose an image-capable model or remove the images.`
    );
  }
}

function validateAttachments(attachments: readonly AgentTurnAttachment[]): void {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const attachment of attachments) {
    if (!attachment.attachmentId || ids.has(attachment.attachmentId)) {
      invalid('Attachment delivery ids must be non-empty and unique.');
    }
    if (
      !Number.isSafeInteger(attachment.ordinal) ||
      attachment.ordinal < 0 ||
      ordinals.has(attachment.ordinal)
    ) {
      invalid('Attachment delivery ordinals must be unique non-negative integers.');
    }
    if (!attachment.displayName.trim() || containsControlCharacter(attachment.displayName)) {
      invalid('Attachment display names must be non-empty and contain no control characters.');
    }
    if (!attachment.mediaType.trim() || containsControlCharacter(attachment.mediaType)) {
      invalid('Attachment media types must be non-empty and contain no control characters.');
    }
    if (!Number.isSafeInteger(attachment.byteCount) || attachment.byteCount < 0) {
      invalid('Attachment byte counts must be non-negative integers.');
    }
    if (!SHA256_PATTERN.test(attachment.sha256)) {
      invalid('Attachment hashes must be lowercase SHA-256 values.');
    }
    if (!path.isAbsolute(attachment.path) || attachment.path.includes('\0')) {
      invalid('Attachment delivery paths must be absolute managed paths.');
    }
    if (!Number.isFinite(Date.parse(attachment.verifiedAt))) {
      invalid('Attachment verification timestamps must be valid ISO dates.');
    }
    ids.add(attachment.attachmentId);
    ordinals.add(attachment.ordinal);
  }
}

async function verifyAttachment(
  attachment: AgentTurnAttachment,
  includeBytes: boolean
): Promise<VerifiedAgentTurnAttachment> {
  let entry: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    entry = await fs.lstat(attachment.path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_NOT_REGULAR',
        `Attachment ${attachment.attachmentId} is not a regular file.`
      );
    }
  } catch (error) {
    throw deliveryFileError(
      error,
      'ATTACHMENT_MISSING',
      `Attachment ${attachment.attachmentId} is missing or no longer accessible.`
    );
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      attachment.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    throw deliveryFileError(
      error,
      'ATTACHMENT_MISSING',
      `Attachment ${attachment.attachmentId} is missing or no longer accessible.`
    );
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_NOT_REGULAR',
        `Attachment ${attachment.attachmentId} is not a regular file.`
      );
    }
    if (
      stat.dev !== entry.dev ||
      (stat.ino !== 0 && entry.ino !== 0 && stat.ino !== entry.ino)
    ) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_NOT_REGULAR',
        `Attachment ${attachment.attachmentId} changed during verification.`
      );
    }
    if (!posixModeMatches(stat, 0o400)) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_NOT_READ_ONLY',
        `Attachment ${attachment.attachmentId} is not read-only.`
      );
    }
    if (stat.size !== attachment.byteCount) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_SIZE_MISMATCH',
        `Attachment ${attachment.attachmentId} changed size after it was staged.`
      );
    }
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    const stream = createReadStream(attachment.path, {
      fd: handle.fd,
      autoClose: false,
      start: 0
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      digest.update(bytes);
      if (includeBytes) chunks.push(bytes);
    }
    if (digest.digest('hex') !== attachment.sha256) {
      throw new AgentAttachmentDeliveryError(
        'ATTACHMENT_HASH_MISMATCH',
        `Attachment ${attachment.attachmentId} no longer matches its staged contents.`
      );
    }
    return {
      ...attachment,
      verifiedAt: new Date().toISOString(),
      ...(includeBytes ? { bytes: Buffer.concat(chunks, stat.size) } : {})
    };
  } finally {
    await handle.close();
  }
}

function deliveryFileError(
  error: unknown,
  fallbackCode: AgentAttachmentDeliveryError['code'],
  fallbackMessage: string
): AgentAttachmentDeliveryError {
  if (error instanceof AgentAttachmentDeliveryError) {
    return error;
  }
  return new AgentAttachmentDeliveryError(fallbackCode, fallbackMessage);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function invalid(message: string): never {
  throw new AgentAttachmentDeliveryError('INVALID_ATTACHMENT_DELIVERY', message);
}
