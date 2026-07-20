import {
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isAttachmentClientToken,
  type StageTaskAttachmentBatchRequest
} from '../shared/attachments';

export const ATTACHMENT_IPC_MAX_OPERATIONS = 2;
export const ATTACHMENT_IPC_MAX_IN_FLIGHT_BYTES = 20 * 1024 * 1024;

export class AttachmentIpcLimitError extends Error {
  constructor() {
    super('Too many attachment operations are in progress. Try again shortly.');
    this.name = 'AttachmentIpcLimitError';
  }
}

export function assertAttachmentIpcBatch(
  input: StageTaskAttachmentBatchRequest
): number {
  if (
    !input ||
    !Array.isArray(input.attachments) ||
    input.attachments.length === 0 ||
    input.attachments.length > ATTACHMENT_MAX_COUNT
  ) {
    throw new Error('Attachment batch data is invalid.');
  }
  let total = 0;
  for (const attachment of input.attachments) {
    if (
      !isAttachmentClientToken(attachment?.clientToken) ||
      typeof attachment.displayName !== 'string' ||
      Object.prototype.toString.call(attachment.bytes) !== '[object ArrayBuffer]'
    ) {
      throw new Error('Attachment batch data is invalid.');
    }
    if (attachment.bytes.byteLength > ATTACHMENT_MAX_IMAGE_BYTES) {
      throw new Error('This attachment is too large.');
    }
    total += attachment.bytes.byteLength;
  }
  if (total > ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error('Attachments exceed the per-task size limit.');
  }
  return total;
}

export class AttachmentIpcOperationGate {
  private operations = 0;
  private bytes = 0;

  async run<T>(reservedBytes: number, operation: () => Promise<T> | T): Promise<T> {
    if (
      !Number.isSafeInteger(reservedBytes) ||
      reservedBytes < 0 ||
      reservedBytes > ATTACHMENT_IPC_MAX_IN_FLIGHT_BYTES ||
      this.operations >= ATTACHMENT_IPC_MAX_OPERATIONS ||
      this.bytes + reservedBytes > ATTACHMENT_IPC_MAX_IN_FLIGHT_BYTES
    ) {
      throw new AttachmentIpcLimitError();
    }
    this.operations += 1;
    this.bytes += reservedBytes;
    try {
      return await operation();
    } finally {
      this.operations -= 1;
      this.bytes -= reservedBytes;
    }
  }
}
