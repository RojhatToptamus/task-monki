import path from 'node:path';
import {
  ATTACHMENT_MAX_IMAGE_MEGAPIXELS,
  ATTACHMENT_MAX_IMAGE_PIXELS,
  attachmentKindForFileName,
  attachmentMaxBytesForKind,
  type AttachmentKind
} from '../../shared/attachments';
import { AttachmentStoreError } from './AttachmentErrors';

export interface AdmittedAttachment {
  displayName: string;
  kind: AttachmentKind;
  mediaType: string;
}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

export function admitAttachment(
  rawDisplayName: string,
  input: Uint8Array
): AdmittedAttachment {
  const displayName = validateAttachmentDisplayName(rawDisplayName);
  const bytes = Buffer.from(input);
  const kind = attachmentKindForFileName(displayName);
  if (!kind) {
    throw new AttachmentStoreError(
      'ATTACHMENT_UNSUPPORTED_TYPE',
      'This file type is not supported. Attach a common image, text, data, config, or source-code file.',
      400
    );
  }
  if (bytes.byteLength > attachmentMaxBytesForKind(kind)) {
    throw new AttachmentStoreError(
      'ATTACHMENT_TOO_LARGE',
      'This attachment is too large.',
      413
    );
  }

  if (kind === 'text') {
    validateUtf8Text(bytes);
    return { displayName, kind, mediaType: textMediaType(displayName) };
  }

  const image = inspectImage(bytes);
  assertImageExtension(displayName, image.mediaType);
  assertPixelLimit(image.width, image.height);
  return { displayName, kind, mediaType: image.mediaType };
}

export function validateAttachmentDisplayName(value: string): string {
  const normalized = value.normalize('NFC');
  if (
    !normalized ||
    normalized !== path.basename(normalized) ||
    normalized.includes('\\') ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(normalized) ||
    Buffer.byteLength(normalized) > 255
  ) {
    throw new AttachmentStoreError(
      'ATTACHMENT_INVALID_REQUEST',
      'Attachment filename is invalid.',
      400
    );
  }
  return normalized;
}

function validateUtf8Text(bytes: Buffer): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
      throw new Error('binary');
    }
  } catch {
    throw new AttachmentStoreError(
      'ATTACHMENT_INVALID_CONTENT',
      'Text attachments must contain valid UTF-8 text and no binary control bytes.',
      400
    );
  }
}

function inspectImage(
  bytes: Buffer
): { mediaType: string; width: number; height: number } {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { mediaType: 'image/png', ...pngDimensions(bytes) };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mediaType: 'image/webp', ...webpDimensions(bytes) };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { mediaType: 'image/jpeg', ...jpegDimensions(bytes) };
  }
  throw malformedImage();
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw malformedImage();
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const endOffset = dataOffset + length + 4;
    if (endOffset > bytes.length) throw malformedImage();
    const typeBytes = bytes.subarray(typeOffset, dataOffset);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/u.test(type)) throw malformedImage();
    if (
      pngCrc32(bytes.subarray(typeOffset, dataOffset + length)) !==
      bytes.readUInt32BE(dataOffset + length)
    ) {
      throw malformedImage();
    }

    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw malformedImage();
      width = bytes.readUInt32BE(dataOffset);
      height = bytes.readUInt32BE(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      const allowedBitDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      };
      if (
        !width ||
        !height ||
        !allowedBitDepths[colorType]?.includes(bitDepth) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] > 1
      ) {
        throw malformedImage();
      }
      sawHeader = true;
    } else if (type === 'IHDR') {
      throw malformedImage();
    }

    if (type === 'IDAT') {
      if (length === 0 || sawEnd) throw malformedImage();
      sawImageData = true;
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw malformedImage();
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawImageData || endOffset !== bytes.length) {
        throw malformedImage();
      }
      sawEnd = true;
    } else if (
      (typeBytes[0] & 0x20) === 0 &&
      type !== 'IHDR' &&
      type !== 'PLTE' &&
      type !== 'IDAT'
    ) {
      throw malformedImage();
    }
    offset = endOffset;
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== bytes.length) {
    throw malformedImage();
  }
  return { width, height };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  const startsOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf
  ]);
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw malformedImage();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw malformedImage();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!sawScan || !width || !height || offset !== bytes.length) {
        throw malformedImage();
      }
      return { width, height };
    }
    if (marker === 0x01) continue;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw malformedImage();
    }
    if (offset + 2 > bytes.length) throw malformedImage();
    const length = bytes.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.length) throw malformedImage();

    if (startsOfFrame.has(marker)) {
      if (length < 11) throw malformedImage();
      const frameHeight = bytes.readUInt16BE(offset + 3);
      const frameWidth = bytes.readUInt16BE(offset + 5);
      if (
        !frameWidth ||
        !frameHeight ||
        (width && width !== frameWidth) ||
        (height && height !== frameHeight)
      ) {
        throw malformedImage();
      }
      width = frameWidth;
      height = frameHeight;
    }

    if (marker === 0xda) {
      if (!width || !height) throw malformedImage();
      sawScan = true;
      offset = segmentEnd;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const markerStart = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) throw malformedImage();
        const scanMarker = bytes[offset];
        if (
          scanMarker === 0x00 ||
          scanMarker === 0x01 ||
          (scanMarker >= 0xd0 && scanMarker <= 0xd7)
        ) {
          offset += 1;
          continue;
        }
        offset = markerStart;
        break;
      }
      continue;
    }
    offset = segmentEnd;
  }
  throw malformedImage();
}

function webpDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw malformedImage();
  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  let coded: { width: number; height: number } | undefined;
  let extended = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw malformedImage();
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) throw malformedImage();

    if (type === 'VP8X') {
      if (offset !== 12 || extended || length !== 10) throw malformedImage();
      const flags = bytes[dataOffset];
      if ((flags & 0xc3) !== 0) throw malformedImage();
      extended = true;
      canvas = validDimensions(
        1 + bytes.readUIntLE(dataOffset + 4, 3),
        1 + bytes.readUIntLE(dataOffset + 7, 3)
      );
    } else if (type === 'VP8 ') {
      if (coded) throw malformedImage();
      coded = webpLossyDimensions(bytes, dataOffset, length);
      canvas ??= coded;
    } else if (type === 'VP8L') {
      if (coded) throw malformedImage();
      coded = webpLosslessDimensions(bytes, dataOffset, length);
      canvas ??= coded;
    } else if (type === 'ANIM' || type === 'ANMF') {
      throw malformedImage();
    } else if (!extended || !['ICCP', 'ALPH', 'EXIF', 'XMP '].includes(type)) {
      throw malformedImage();
    }

    if ((length & 1) === 1 && bytes[dataEnd] !== 0) throw malformedImage();
    offset = paddedEnd;
  }

  if (
    offset !== bytes.length ||
    !canvas ||
    !coded ||
    canvas.width !== coded.width ||
    canvas.height !== coded.height
  ) {
    throw malformedImage();
  }
  return canvas;
}

function webpLosslessDimensions(
  bytes: Buffer,
  offset: number,
  length: number
): { width: number; height: number } {
  if (length <= 5 || bytes[offset] !== 0x2f || (bytes[offset + 4] & 0xe0) !== 0) {
    throw malformedImage();
  }
  return validDimensions(
    1 + bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8),
    1 +
      (bytes[offset + 2] >> 6) +
      (bytes[offset + 3] << 2) +
      ((bytes[offset + 4] & 0x0f) << 10)
  );
}

function webpLossyDimensions(
  bytes: Buffer,
  offset: number,
  length: number
): { width: number; height: number } {
  if (
    length <= 10 ||
    (bytes[offset] & 0x01) !== 0 ||
    !bytes.subarray(offset + 3, offset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
  ) {
    throw malformedImage();
  }
  return validDimensions(
    bytes.readUInt16LE(offset + 6) & 0x3fff,
    bytes.readUInt16LE(offset + 8) & 0x3fff
  );
}

function validDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw malformedImage();
  }
  assertPixelLimit(width, height);
  return { width, height };
}

function assertPixelLimit(width: number, height: number): void {
  if (width > Math.floor(ATTACHMENT_MAX_IMAGE_PIXELS / height)) {
    throw new AttachmentStoreError(
      'ATTACHMENT_INVALID_CONTENT',
      `Image dimensions exceed the ${ATTACHMENT_MAX_IMAGE_MEGAPIXELS} megapixel limit.`,
      400
    );
  }
}

function assertImageExtension(displayName: string, mediaType: string): void {
  const extension = path.extname(displayName).toLowerCase();
  const matches =
    (mediaType === 'image/png' && extension === '.png') ||
    (mediaType === 'image/jpeg' && (extension === '.jpg' || extension === '.jpeg')) ||
    (mediaType === 'image/webp' && extension === '.webp');
  if (!matches) {
    throw new AttachmentStoreError(
      'ATTACHMENT_INVALID_CONTENT',
      'The image contents do not match the file extension.',
      400
    );
  }
}

function textMediaType(displayName: string): string {
  switch (path.extname(displayName).toLowerCase()) {
    case '.json': return 'application/json';
    case '.csv': return 'text/csv';
    case '.tsv': return 'text/tab-separated-values';
    case '.md':
    case '.markdown': return 'text/markdown';
    case '.yaml':
    case '.yml': return 'application/yaml';
    case '.toml': return 'application/toml';
    case '.xml': return 'application/xml';
    case '.sql': return 'application/sql';
    default: return 'text/plain';
  }
}

function malformedImage(): AttachmentStoreError {
  return new AttachmentStoreError(
    'ATTACHMENT_INVALID_CONTENT',
    'The image file is malformed or unsupported.',
    400
  );
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
