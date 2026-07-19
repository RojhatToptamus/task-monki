import { isUtf8 } from 'node:buffer';

export type PreviewEnvImportResult =
  | { status: 'VALUE'; value: string }
  | { status: 'INVALID_KEY' | 'KEY_MISSING' | 'KEY_DUPLICATE' | 'INVALID_FILE' };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_VALUE_BYTES = 8 * 1024;
const EXPORT_PREFIX = Buffer.from('export ', 'ascii');

export function parseSelectedEnvValue(bytes: Buffer, selectedKey: string): PreviewEnvImportResult {
  if (!KEY.test(selectedKey)) return { status: 'INVALID_KEY' };
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0) || !isUtf8(bytes)) {
    return { status: 'INVALID_FILE' };
  }
  const selectedKeyBytes = Buffer.from(selectedKey, 'ascii');
  let found: string | undefined;
  for (let lineStart = 0; lineStart <= bytes.length;) {
    const newline = bytes.indexOf(0x0a, lineStart);
    let lineEnd = newline === -1 ? bytes.length : newline;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd - lineStart > MAX_LINE_BYTES) return { status: 'INVALID_FILE' };
    let start = trimAsciiLeft(bytes, lineStart, lineEnd);
    const end = trimAsciiRight(bytes, start, lineEnd);
    if (start === end || bytes[start] === 0x23) {
      if (newline === -1) break;
      lineStart = newline + 1;
      continue;
    }
    if (startsWith(bytes, start, end, EXPORT_PREFIX)) start += EXPORT_PREFIX.length;
    const equals = bytes.indexOf(0x3d, start);
    if (equals < start + 1 || equals >= end) {
      if (newline === -1) break;
      lineStart = newline + 1;
      continue;
    }
    const keyStart = trimAsciiLeft(bytes, start, equals);
    const keyEnd = trimAsciiRight(bytes, keyStart, equals);
    if (!bytes.subarray(keyStart, keyEnd).equals(selectedKeyBytes)) {
      if (newline === -1) break;
      lineStart = newline + 1;
      continue;
    }
    if (found !== undefined) return { status: 'KEY_DUPLICATE' };
    let valueStart = trimAsciiLeft(bytes, equals + 1, end);
    let valueEnd = trimAsciiRight(bytes, valueStart, end);
    const quote = bytes[valueStart];
    if (quote === 0x22 || quote === 0x27) {
      if (valueEnd - valueStart < 2 || bytes[valueEnd - 1] !== quote) {
        return { status: 'INVALID_FILE' };
      }
      valueStart += 1;
      valueEnd -= 1;
    } else {
      for (let index = valueStart; index < valueEnd; index += 1) {
        if (bytes[index] === 0x60 || bytes[index] === 0x24 || bytes[index] === 0x5c) {
          return { status: 'INVALID_FILE' };
        }
      }
    }
    if (valueEnd <= valueStart || valueEnd - valueStart > MAX_VALUE_BYTES) {
      return { status: 'INVALID_FILE' };
    }
    found = bytes.toString('utf8', valueStart, valueEnd);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return found === undefined ? { status: 'KEY_MISSING' } : { status: 'VALUE', value: found };
}

function trimAsciiLeft(bytes: Buffer, start: number, end: number): number {
  while (start < end && (bytes[start] === 0x20 || bytes[start] === 0x09)) start += 1;
  return start;
}

function trimAsciiRight(bytes: Buffer, start: number, end: number): number {
  while (end > start && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end -= 1;
  return end;
}

function startsWith(bytes: Buffer, start: number, end: number, prefix: Buffer): boolean {
  return end - start >= prefix.length && bytes.subarray(start, start + prefix.length).equals(prefix);
}
