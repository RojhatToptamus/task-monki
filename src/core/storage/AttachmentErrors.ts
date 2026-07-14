export type AttachmentStoreErrorCode =
  | 'ATTACHMENT_INVALID_REQUEST'
  | 'ATTACHMENT_UNSUPPORTED_TYPE'
  | 'ATTACHMENT_INVALID_CONTENT'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_LIMIT_EXCEEDED'
  | 'ATTACHMENT_TOTAL_TOO_LARGE'
  | 'ATTACHMENT_DRAFT_NOT_FOUND'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_CONFLICT'
  | 'ATTACHMENT_INTEGRITY_MISMATCH'
  | 'ATTACHMENT_STORAGE_QUOTA_EXCEEDED'
  | 'ATTACHMENT_INSUFFICIENT_SPACE'
  | 'ATTACHMENT_STORAGE_ERROR';

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string,
    readonly httpStatus: 400 | 404 | 409 | 413 | 507
  ) {
    super(message);
    this.name = 'AttachmentStoreError';
  }
}

export function attachmentIntegrityError(): AttachmentStoreError {
  return new AttachmentStoreError(
    'ATTACHMENT_INTEGRITY_MISMATCH',
    'Attachment storage failed an integrity check.',
    409
  );
}

export function attachmentStorageError(
  status: 400 | 404 | 409 | 413 | 507 = 507
): AttachmentStoreError {
  return new AttachmentStoreError(
    'ATTACHMENT_STORAGE_ERROR',
    'Attachment storage is unavailable. Try again or free disk space.',
    status
  );
}
