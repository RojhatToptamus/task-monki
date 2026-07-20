import type { AgentModel } from '../../shared/contracts';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_IMAGE_MEGAPIXELS,
  ATTACHMENT_MAX_IMAGE_PIXELS,
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentKindForFileName,
  attachmentMaxBytesForKind,
  isAttachmentClientToken,
  type AttachmentKind
} from '../../shared/attachments';

export interface DecodedAttachmentImage {
  width: number;
  height: number;
  encode(mediaType: 'image/png' | 'image/jpeg' | 'image/webp'): Promise<Blob>;
  encodePreview?(maximumDimension: number): Promise<Blob>;
  close(): void;
}

export interface PreparedImageAttachment {
  file: File;
  preview?: Blob;
}

export type AttachmentImageDecoder = (file: File) => Promise<DecodedAttachmentImage>;

export interface AttachmentFileCandidate {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AttachmentAdmissionContext {
  count: number;
  byteCount: number;
}

export interface AttachmentAdmissionResult {
  admitted: Array<{ file: AttachmentFileCandidate; kind: AttachmentKind }>;
  rejected: Array<{ file: AttachmentFileCandidate; reason: string }>;
}

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

/** Cheap renderer preflight; core repeats authoritative byte validation. */
export function admitAttachmentFiles(
  files: readonly AttachmentFileCandidate[],
  context: AttachmentAdmissionContext
): AttachmentAdmissionResult {
  const admitted: AttachmentAdmissionResult['admitted'] = [];
  const rejected: AttachmentAdmissionResult['rejected'] = [];
  let count = context.count;
  let byteCount = context.byteCount;

  for (const file of files) {
    const kind = attachmentKindForFileName(file.name);
    if (!kind) {
      rejected.push({ file, reason: 'This file type is not supported.' });
      continue;
    }
    if (count >= ATTACHMENT_MAX_COUNT) {
      rejected.push({ file, reason: `You can attach up to ${ATTACHMENT_MAX_COUNT} files.` });
      continue;
    }
    const maximumBytes = attachmentMaxBytesForKind(kind);
    if (file.size <= 0 || file.size > maximumBytes) {
      rejected.push({
        file,
        reason: `${kind === 'image' ? 'Images' : 'Text files'} must be ${formatAttachmentBytes(maximumBytes)} or smaller.`
      });
      continue;
    }
    if (byteCount + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
      rejected.push({
        file,
        reason: `Attachments must total ${formatAttachmentBytes(ATTACHMENT_MAX_TOTAL_BYTES)} or less.`
      });
      continue;
    }
    admitted.push({ file, kind });
    count += 1;
    byteCount += file.size;
  }
  return { admitted, rejected };
}

export function createAttachmentClientToken(
  createUuid: () => string = () => globalThis.crypto.randomUUID()
): string {
  const token = createUuid();
  if (!isAttachmentClientToken(token)) {
    throw new Error('Secure attachment identifiers are unavailable.');
  }
  return token;
}

export function modelAcceptsImageAttachments(model: AgentModel | undefined): boolean {
  return Boolean(
    model?.inputModalities.some(
      (modality) => modality.trim().toLocaleLowerCase('en-US') === 'image'
    )
  );
}

export async function normalizeImageAttachment(
  file: File,
  decode: AttachmentImageDecoder = decodeBrowserImage
): Promise<File> {
  return (await prepareImageAttachment(file, decode)).file;
}

export async function prepareImageAttachment(
  file: File,
  decode: AttachmentImageDecoder = decodeBrowserImage
): Promise<PreparedImageAttachment> {
  const mediaType = imageMediaType(file.name);
  const maximumBytes = attachmentMaxBytesForKind('image');
  if (file.size <= 0 || file.size > maximumBytes) {
    throw new AttachmentValidationError(`Images must be ${formatAttachmentBytes(maximumBytes)} or smaller.`);
  }
  let image: DecodedAttachmentImage;
  try {
    image = await decode(file);
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw new AttachmentValidationError('This image could not be safely decoded.');
  }
  try {
    assertSafeDimensions(image.width, image.height);
    const normalized = await image.encode(mediaType);
    if (normalized.size <= 0 || normalized.size > maximumBytes) {
      throw new AttachmentValidationError(`Images must be ${formatAttachmentBytes(maximumBytes)} or smaller.`);
    }
    let preview: Blob | undefined;
    if (image.encodePreview) {
      try {
        const candidate = await image.encodePreview(96);
        if (candidate.type === 'image/png' && candidate.size <= 512 * 1024) preview = candidate;
      } catch {
        // Preview generation is optional.
      }
    }
    return {
      file: new File([normalized], file.name, {
        type: mediaType,
        lastModified: file.lastModified
      }),
      preview
    };
  } finally {
    image.close();
  }
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

function imageMediaType(fileName: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const lower = fileName.toLocaleLowerCase('en-US');
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function decodeBrowserImage(file: File): Promise<DecodedAttachmentImage> {
  const ImageDecoderConstructor = (globalThis as unknown as {
    ImageDecoder?: new (input: { data: ArrayBuffer; type: string }) => NativeImageDecoder;
  }).ImageDecoder;
  if (!ImageDecoderConstructor) {
    throw new AttachmentValidationError('Safe image decoding is unavailable in this build.');
  }
  const decoder = new ImageDecoderConstructor({
    data: await file.arrayBuffer(),
    type: imageMediaType(file.name)
  });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  if (!track) {
    decoder.close();
    throw new AttachmentValidationError('This image could not be safely decoded.');
  }
  assertSafeDimensions(track.codedWidth, track.codedHeight);
  const result = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
  const frame = result.image;
  const encode = async (
    width: number,
    height: number,
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  ) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new AttachmentValidationError('Image canvas is unavailable.');
    context.drawImage(frame, 0, 0, width, height);
    return canvas.convertToBlob({ type: mediaType, quality: mediaType === 'image/png' ? undefined : 0.92 });
  };
  return {
    width: frame.displayWidth,
    height: frame.displayHeight,
    encode: (mediaType) => encode(frame.displayWidth, frame.displayHeight, mediaType),
    encodePreview: (maximumDimension) => {
      const scale = Math.min(1, maximumDimension / Math.max(frame.displayWidth, frame.displayHeight));
      return encode(
        Math.max(1, Math.round(frame.displayWidth * scale)),
        Math.max(1, Math.round(frame.displayHeight * scale)),
        'image/png'
      );
    },
    close() {
      frame.close();
      decoder.close();
    }
  };
}

function assertSafeDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > Math.floor(ATTACHMENT_MAX_IMAGE_PIXELS / height)
  ) {
    throw new AttachmentValidationError(
      `Image dimensions exceed the ${ATTACHMENT_MAX_IMAGE_MEGAPIXELS} megapixel limit.`
    );
  }
}

interface NativeImageDecoder {
  tracks: {
    ready: Promise<void>;
    selectedTrack?: { codedWidth: number; codedHeight: number };
  };
  decode(input: { frameIndex: number; completeFramesOnly: boolean }): Promise<{
    image: CanvasImageSource & {
      displayWidth: number;
      displayHeight: number;
      close(): void;
    };
  }>;
  close(): void;
}
