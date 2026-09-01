import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  type AttachmentDraftSnapshot,
  type AttachmentKind,
  type StagedAttachmentRecord,
  type TaskAttachmentRecord
} from '../../shared/attachments';
import { attachmentIntegrityError } from './AttachmentErrors';

export interface VerifiedTaskAttachment {
  record: TaskAttachmentRecord;
  /** Ephemeral core-only path. Never persist or expose this in a snapshot. */
  absolutePath: string;
}

export interface VerifiedDraftAttachment {
  record: StagedAttachmentRecord;
  /** Ephemeral core-only path. Never persist or expose this in a snapshot. */
  absolutePath: string;
}

export interface StoredAttachmentContent {
  attachmentId: string;
  displayName: string;
  kind: AttachmentKind;
  mediaType: string;
  byteCount: number;
  bytes: Uint8Array;
}

interface PreparedAttachmentAdoption {
  draft: AttachmentDraftSnapshot;
  taskId: string;
  records: TaskAttachmentRecord[];
}

export class AttachmentAdoptionAmbiguousError extends AggregateError {
  readonly name = 'AttachmentAdoptionAmbiguousError';

  constructor(
    readonly receipt: PreparedAttachmentAdoption,
    publicationError: unknown,
    rollbackError: unknown
  ) {
    super(
      [publicationError, rollbackError],
      'Attachment adoption failed and its durable ownership could not be proven.'
    );
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function validateTaskAttachmentRecords(
  records: readonly TaskAttachmentRecord[],
  taskId: string
): void {
  if (!SAFE_ID.test(taskId) || records.length > ATTACHMENT_MAX_COUNT) {
    throw attachmentIntegrityError();
  }

  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let totalBytes = 0;
  for (const record of records) {
    if (
      record.taskId !== taskId ||
      !SAFE_ID.test(record.id) ||
      ids.has(record.id) ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 0 ||
      record.ordinal >= ATTACHMENT_MAX_COUNT ||
      ordinals.has(record.ordinal) ||
      !record.displayName ||
      /[\u0000-\u001f\u007f]/u.test(record.displayName) ||
      (record.kind !== 'image' && record.kind !== 'text') ||
      !record.mediaType ||
      !Number.isSafeInteger(record.byteCount) ||
      record.byteCount <= 0 ||
      !SHA256.test(record.sha256) ||
      !Number.isFinite(Date.parse(record.createdAt))
    ) {
      throw attachmentIntegrityError();
    }
    ids.add(record.id);
    ordinals.add(record.ordinal);
    totalBytes += record.byteCount;
  }

  if (
    totalBytes > ATTACHMENT_MAX_TOTAL_BYTES ||
    [...ordinals].some((ordinal) => ordinal >= records.length)
  ) {
    throw attachmentIntegrityError();
  }
}
