import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DISCOURSE_LIMITS, type DiscourseJsonValue } from '../../shared/discourse';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';

export const DISCOURSE_EVENT_LOG_SCHEMA_VERSION = 1 as const;
const EVENT_FORMAT_VERSION = 1 as const;
const DEFAULT_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEGMENT_MAX_EVENTS = 2_048;
const DEFAULT_EVENT_MAX_BYTES = 128 * 1024;
const MAX_LOG_EVENTS = DISCOURSE_LIMITS.maxEventsPerConversation;
const MAX_LOG_SEGMENTS = DISCOURSE_LIMITS.maxEventLogSegments;
const MANIFEST_FILE = 'manifest.json';
const SEGMENT_NAME = /^events-(\d{6})\.jsonl$/u;

export interface DiscourseLogEvent<T extends DiscourseJsonValue = DiscourseJsonValue> {
  formatVersion: typeof EVENT_FORMAT_VERSION;
  sequence: number;
  kind: string;
  operationId: string;
  requestFingerprint: string;
  payload: T;
  checksum: string;
}

interface DiscourseLogIndexEntry {
  sequence: number;
  segment: number;
  offset: number;
  length: number;
  kind: string;
  operationId: string;
  requestFingerprint: string;
  eventChecksum: string;
}

interface DiscourseSegmentIndex {
  schemaVersion: typeof DISCOURSE_EVENT_LOG_SCHEMA_VERSION;
  segment: number;
  fileSize: number;
  fileMtimeMs: number;
  fileCtimeMs: number;
  entries: DiscourseLogIndexEntry[];
}

interface DiscourseManifestSegment {
  segment: number;
  firstSequence: number | null;
  lastSequence: number | null;
  eventCount: number;
  byteLength: number;
}

interface DiscourseLogManifest {
  schemaVersion: typeof DISCOURSE_EVENT_LOG_SCHEMA_VERSION;
  revision: number;
  eventCount: number;
  nextSequence: number;
  segments: DiscourseManifestSegment[];
  checksum: string;
}

export interface DiscourseLogDurableSummary {
  eventCount: number;
  latestSequence: number;
  segmentCount: number;
}

export interface FileDiscourseEventLogOptions {
  segmentMaxBytes?: number;
  segmentMaxEvents?: number;
  eventMaxBytes?: number;
  afterAppendBeforeIndex?: () => void | Promise<void>;
  afterSegmentIndexBeforeManifest?: () => void | Promise<void>;
}

/**
 * Phase-1 physical format selected for the discourse store. JSONL segments are
 * authoritative. Each bounded segment owns a rebuildable index; the small
 * manifest contains summaries only, so an append never rewrites prior event
 * indexes or a conversation-wide entry array on disk.
 */
export class FileDiscourseEventLog {
  private entries: DiscourseLogIndexEntry[] = [];
  private entriesBySegment = new Map<number, DiscourseLogIndexEntry[]>();
  private operationEntries = new Map<string, DiscourseLogIndexEntry>();
  private initialized = false;
  private initPromise?: Promise<void>;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private manifestRevision = 0;
  private readonly segmentMaxBytes: number;
  private readonly segmentMaxEvents: number;
  private readonly eventMaxBytes: number;

  constructor(
    private readonly directory: string,
    private readonly options: FileDiscourseEventLogOptions = {}
  ) {
    this.segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES;
    this.segmentMaxEvents = options.segmentMaxEvents ?? DEFAULT_SEGMENT_MAX_EVENTS;
    this.eventMaxBytes = options.eventMaxBytes ?? DEFAULT_EVENT_MAX_BYTES;
    if (
      this.segmentMaxBytes < 512 ||
      this.segmentMaxEvents < 1 ||
      this.eventMaxBytes < 128 ||
      this.eventMaxBytes > this.segmentMaxBytes
    ) {
      throw new Error('Discourse event-log bounds are invalid.');
    }
  }

  append<T extends DiscourseJsonValue>(input: {
    kind: string;
    operationId: string;
    requestFingerprint: string;
    payload: T;
  }): Promise<DiscourseLogEvent<T>> {
    return this.enqueue(async () => {
      await this.init();
      validateAppendInput(input);
      const existing = this.operationEntries.get(input.operationId);
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new Error('REQUEST_CONFLICT: operation id was reused with different content.');
        }
        return (await this.readEntry(existing)) as DiscourseLogEvent<T>;
      }
      if (this.entries.length >= MAX_LOG_EVENTS) {
        throw new Error('Discourse event log has reached its safety limit.');
      }

      const sequence = (this.entries.at(-1)?.sequence ?? 0) + 1;
      const event = createDiscourseLogEvent({
        formatVersion: EVENT_FORMAT_VERSION,
        sequence,
        kind: input.kind,
        operationId: input.operationId,
        requestFingerprint: input.requestFingerprint,
        payload: input.payload
      });
      const encoded = Buffer.from(encodeDiscourseLogEvent(event), 'utf8');
      if (encoded.byteLength > this.eventMaxBytes) {
        throw new Error('Discourse event exceeds its encoded-size safety limit.');
      }
      const segment = this.chooseSegment(encoded.byteLength);
      const segmentPath = this.segmentPath(segment);
      const handle = await fs.open(
        segmentPath,
        fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      let offset: number;
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          !hasNoGroupOrOtherPosixAccess(stat) ||
          !isOwnedByCurrentUser(stat)
        ) {
          throw new Error('Discourse segment failed its integrity check.');
        }
        offset = stat.size;
        await handle.write(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const entry: DiscourseLogIndexEntry = {
        sequence,
        segment,
        offset,
        length: encoded.byteLength,
        kind: input.kind,
        operationId: input.operationId,
        requestFingerprint: input.requestFingerprint,
        eventChecksum: event.checksum
      };
      this.entries.push(entry);
      const segmentEntries = this.entriesBySegment.get(segment) ?? [];
      segmentEntries.push(entry);
      this.entriesBySegment.set(segment, segmentEntries);
      this.operationEntries.set(entry.operationId, entry);
      await this.options.afterAppendBeforeIndex?.();
      await this.persistSegmentIndex(segment);
      await this.options.afterSegmentIndexBeforeManifest?.();
      await this.persistManifest();
      return event;
    });
  }

  async readPage(input: {
    afterSequence?: number;
    limit: number;
  }): Promise<{ events: DiscourseLogEvent[]; nextCursor?: number }> {
    await this.init();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Discourse event page limit must be between 1 and 200.');
    }
    const after = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('Discourse event cursor is invalid.');
    }
    const start = firstEntryAfter(this.entries, after);
    const selected = this.entries.slice(start, start + input.limit);
    const events = await Promise.all(selected.map((entry) => this.readEntry(entry)));
    const last = selected.at(-1);
    return {
      events,
      ...(last && start + selected.length < this.entries.length
        ? { nextCursor: last.sequence }
        : {})
    };
  }

  async readPageBefore(input: {
    beforeSequence?: number;
    limit: number;
  }): Promise<{ events: DiscourseLogEvent[]; previousCursor?: number }> {
    await this.init();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Discourse event page limit must be between 1 and 200.');
    }
    const before = input.beforeSequence ?? (this.entries.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(before) || before < 1) {
      throw new Error('Discourse event cursor is invalid.');
    }
    const end = firstEntryAtOrAfter(this.entries, before);
    const start = Math.max(0, end - input.limit);
    const selected = this.entries.slice(start, end);
    const events = await Promise.all(selected.map((entry) => this.readEntry(entry)));
    return {
      events,
      ...(start > 0 && selected.length > 0
        ? { previousCursor: selected[0]!.sequence }
        : {})
    };
  }

  async latestSequence(): Promise<number> {
    await this.init();
    return this.entries.at(-1)?.sequence ?? 0;
  }

  async getByOperationId(operationId: string): Promise<DiscourseLogEvent | undefined> {
    await this.init();
    const entry = this.operationEntries.get(operationId);
    return entry ? this.readEntry(entry) : undefined;
  }

  async count(): Promise<number> {
    await this.init();
    return this.entries.length;
  }

  /**
   * Reads the checksummed, file-size-attested tail summary without loading any
   * per-event indexes. Callers may use this for cold-start change detection;
   * an absent/stale summary must fall back to normal log initialization.
   */
  async inspectDurableSummary(): Promise<DiscourseLogDurableSummary | undefined> {
    await ensurePrivateDirectory(this.directory);
    const files = await fs.readdir(this.directory);
    const segments = files
      .flatMap((file) => {
        const match = SEGMENT_NAME.exec(file);
        return match ? [Number(match[1])] : [];
      })
      .sort((left, right) => left - right);
    assertSegmentNumbers(segments);
    if (segments.length > MAX_LOG_SEGMENTS) {
      throw new Error('Discourse event log exceeds its segment safety limit.');
    }
    const manifest = await this.readManifest();
    if (
      !manifest ||
      !manifestDescribesContiguousLog(
        manifest,
        segments,
        this.segmentMaxEvents,
        this.segmentMaxBytes
      )
    ) {
      return undefined;
    }
    const stats = await Promise.all(segments.map((segment) => this.segmentStat(segment)));
    if (
      stats.some(
        (stat, index) => stat.size !== manifest.segments[index]!.byteLength
      )
    ) {
      return undefined;
    }
    return {
      eventCount: manifest.eventCount,
      latestSequence: manifest.nextSequence - 1,
      segmentCount: segments.length
    };
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const files = await fs.readdir(this.directory);
    const segments = files
      .flatMap((file) => {
        const match = SEGMENT_NAME.exec(file);
        return match ? [Number(match[1])] : [];
      })
      .sort((left, right) => left - right);
    assertSegmentNumbers(segments);
    if (segments.length > MAX_LOG_SEGMENTS) {
      throw new Error('Discourse event log exceeds its segment safety limit.');
    }

    const entries: DiscourseLogIndexEntry[] = [];
    this.entriesBySegment = new Map();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const stat = await this.segmentStat(segment);
      let segmentEntries = await this.readSegmentIndex(segment, stat);
      if (!segmentEntries) {
        segmentEntries = await this.scanSegment(segment, index === segments.length - 1);
        this.entriesBySegment.set(segment, segmentEntries);
        await this.persistSegmentIndex(segment);
      } else {
        this.entriesBySegment.set(segment, segmentEntries);
      }
      entries.push(...segmentEntries);
    }
    assertMonotonicEntries(entries);
    if (entries.length > MAX_LOG_EVENTS) {
      throw new Error('Discourse event log exceeds its entry safety limit.');
    }
    this.entries = entries;
    this.operationEntries = buildOperationIndex(entries);

    const existingManifest = await this.readManifest();
    this.manifestRevision = existingManifest?.revision ?? 0;
    if (!existingManifest || !manifestMatches(existingManifest, this.manifestSegments(), entries)) {
      await this.persistManifest();
    }
    this.initialized = true;
  }

  private async scanSegment(
    segment: number,
    allowTailRepair: boolean
  ): Promise<DiscourseLogIndexEntry[]> {
    const segmentPath = this.segmentPath(segment);
    const handle = await fs.open(
      segmentPath,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > this.segmentMaxBytes ||
        !hasNoGroupOrOtherPosixAccess(stat) ||
        !isOwnedByCurrentUser(stat)
      ) {
        throw new Error(`Discourse segment ${segment} is invalid or oversized.`);
      }
      let buffer = await handle.readFile();
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (buffer.length > 0 && lastNewline !== buffer.length - 1) {
        if (!allowTailRepair) {
          throw new Error(`Discourse segment ${segment} has a partial non-tail record.`);
        }
        const repairedLength = Math.max(0, lastNewline + 1);
        await handle.truncate(repairedLength);
        await handle.sync();
        buffer = buffer.subarray(0, repairedLength);
      }

      const entries: DiscourseLogIndexEntry[] = [];
      const lines = buffer.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      let offset = 0;
      for (const line of lines) {
        if (!line) throw new Error(`Discourse segment ${segment} contains a blank record.`);
        const length = Buffer.byteLength(line, 'utf8') + 1;
        const event = decodeEvent(line, segment);
        entries.push({
          sequence: event.sequence,
          segment,
          offset,
          length,
          kind: event.kind,
          operationId: event.operationId,
          requestFingerprint: event.requestFingerprint,
          eventChecksum: event.checksum
        });
        offset += length;
        if (entries.length > this.segmentMaxEvents) {
          throw new Error(`Discourse segment ${segment} exceeds its event-count limit.`);
        }
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  private chooseSegment(nextLength: number): number {
    const segments = [...this.entriesBySegment.keys()].sort((left, right) => left - right);
    const current = segments.at(-1) ?? 1;
    const currentEntries = this.entriesBySegment.get(current) ?? [];
    const currentBytes = currentEntries.at(-1)
      ? currentEntries.at(-1)!.offset + currentEntries.at(-1)!.length
      : 0;
    if (
      currentEntries.length > 0 &&
      (currentEntries.length >= this.segmentMaxEvents ||
        currentBytes + nextLength > this.segmentMaxBytes)
    ) {
      if (segments.length >= MAX_LOG_SEGMENTS) {
        throw new Error('Discourse event log has reached its segment safety limit.');
      }
      return current + 1;
    }
    return current;
  }

  private async readEntry(entry: DiscourseLogIndexEntry): Promise<DiscourseLogEvent> {
    const handle = await fs.open(
      this.segmentPath(entry.segment),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const buffer = Buffer.alloc(entry.length);
      const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
      if (bytesRead !== entry.length || buffer.at(-1) !== 0x0a) {
        throw new Error('Discourse event index points to incomplete segment data.');
      }
      const event = decodeEvent(buffer.subarray(0, -1).toString('utf8'), entry.segment);
      if (
        event.sequence !== entry.sequence ||
        event.operationId !== entry.operationId ||
        event.requestFingerprint !== entry.requestFingerprint ||
        event.checksum !== entry.eventChecksum
      ) {
        throw new Error('Discourse event index does not match authoritative segment data.');
      }
      return event;
    } finally {
      await handle.close();
    }
  }

  private async segmentStat(
    segment: number
  ): Promise<{ size: number; mtimeMs: number; ctimeMs: number }> {
    const handle = await fs.open(
      this.segmentPath(segment),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > this.segmentMaxBytes ||
        !hasNoGroupOrOtherPosixAccess(stat) ||
        !isOwnedByCurrentUser(stat)
      ) {
        throw new Error(`Discourse segment ${segment} is invalid or oversized.`);
      }
      return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } finally {
      await handle.close();
    }
  }

  private async readSegmentIndex(
    segment: number,
    stat: { size: number; mtimeMs: number; ctimeMs: number }
  ): Promise<DiscourseLogIndexEntry[] | undefined> {
    const parsed = await readBoundedJson(this.segmentIndexPath(segment), 2 * 1024 * 1024);
    if (!isSegmentIndex(parsed, segment, stat, this.segmentMaxEvents)) return undefined;
    return parsed.entries;
  }

  private async readManifest(): Promise<DiscourseLogManifest | undefined> {
    const parsed = await readBoundedJson(path.join(this.directory, MANIFEST_FILE), 256 * 1024);
    return isManifest(parsed) ? parsed : undefined;
  }

  private async persistSegmentIndex(segment: number): Promise<void> {
    const stat = await this.segmentStat(segment);
    const index: DiscourseSegmentIndex = {
      schemaVersion: DISCOURSE_EVENT_LOG_SCHEMA_VERSION,
      segment,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      fileCtimeMs: stat.ctimeMs,
      entries: this.entriesBySegment.get(segment) ?? []
    };
    await atomicPrivateWrite(
      this.directory,
      this.segmentIndexPath(segment),
      `${JSON.stringify(index)}\n`
    );
  }

  private async persistManifest(): Promise<void> {
    this.manifestRevision += 1;
    const unsigned = {
      schemaVersion: DISCOURSE_EVENT_LOG_SCHEMA_VERSION,
      revision: this.manifestRevision,
      eventCount: this.entries.length,
      nextSequence: (this.entries.at(-1)?.sequence ?? 0) + 1,
      segments: this.manifestSegments()
    };
    const manifest: DiscourseLogManifest = {
      ...unsigned,
      checksum: checksumJson(unsigned)
    };
    await atomicPrivateWrite(
      this.directory,
      path.join(this.directory, MANIFEST_FILE),
      `${JSON.stringify(manifest)}\n`
    );
  }

  private manifestSegments(): DiscourseManifestSegment[] {
    return [...this.entriesBySegment.entries()]
      .sort(([left], [right]) => left - right)
      .map(([segment, entries]) => ({
        segment,
        firstSequence: entries[0]?.sequence ?? null,
        lastSequence: entries.at(-1)?.sequence ?? null,
        eventCount: entries.length,
        byteLength: entries.at(-1)
          ? entries.at(-1)!.offset + entries.at(-1)!.length
          : 0
      }));
  }

  private segmentPath(segment: number): string {
    return path.join(this.directory, `events-${String(segment).padStart(6, '0')}.jsonl`);
  }

  private segmentIndexPath(segment: number): string {
    return path.join(this.directory, `events-${String(segment).padStart(6, '0')}.index.json`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }
}

export function createDiscourseLogEvent<T extends DiscourseJsonValue>(
  event: Omit<DiscourseLogEvent<T>, 'checksum'>
): DiscourseLogEvent<T> {
  return {
    ...event,
    checksum: crypto.createHash('sha256').update(canonicalJson(event)).digest('hex')
  };
}

export function encodeDiscourseLogEvent(event: DiscourseLogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function decodeEvent(line: string, segment: number): DiscourseLogEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Discourse segment ${segment} contains invalid JSON.`);
  }
  if (!isEvent(parsed)) {
    throw new Error(`Discourse segment ${segment} contains an invalid event envelope.`);
  }
  const { checksum, ...unsigned } = parsed;
  const expected = crypto.createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
  if (checksum !== expected) {
    throw new Error(`Discourse segment ${segment} contains a checksum mismatch.`);
  }
  return parsed;
}

function isEvent(value: unknown): value is DiscourseLogEvent {
  if (!isRecord(value)) return false;
  return (
    value.formatVersion === EVENT_FORMAT_VERSION &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    typeof value.kind === 'string' &&
    Boolean(value.kind) &&
    typeof value.operationId === 'string' &&
    Boolean(value.operationId) &&
    typeof value.requestFingerprint === 'string' &&
    Boolean(value.requestFingerprint) &&
    typeof value.checksum === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.checksum)
  );
}

function validateAppendInput(input: {
  kind: string;
  operationId: string;
  requestFingerprint: string;
}): void {
  for (const [label, value] of [
    ['kind', input.kind],
    ['operation id', input.operationId],
    ['request fingerprint', input.requestFingerprint]
  ]) {
    if (!value.trim() || Buffer.byteLength(value, 'utf8') > 256) {
      throw new Error(`Discourse event ${label} is invalid.`);
    }
  }
}

function assertSegmentNumbers(segments: readonly number[]): void {
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== index + 1) {
      throw new Error('Discourse event segments must be contiguous and start at one.');
    }
  }
}

function assertMonotonicEntries(entries: readonly DiscourseLogIndexEntry[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]!.sequence !== index + 1) {
      throw new Error('Discourse event sequences must be contiguous and monotonic.');
    }
  }
  buildOperationIndex(entries);
}

function buildOperationIndex(
  entries: readonly DiscourseLogIndexEntry[]
): Map<string, DiscourseLogIndexEntry> {
  const operations = new Map<string, DiscourseLogIndexEntry>();
  for (const entry of entries) {
    if (operations.has(entry.operationId)) {
      throw new Error(`Duplicate discourse event operation id: ${entry.operationId}`);
    }
    operations.set(entry.operationId, entry);
  }
  return operations;
}

function firstEntryAfter(entries: readonly DiscourseLogIndexEntry[], sequence: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle]!.sequence <= sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstEntryAtOrAfter(
  entries: readonly DiscourseLogIndexEntry[],
  sequence: number
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle]!.sequence < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isSegmentIndex(
  value: unknown,
  segment: number,
  stat: { size: number; mtimeMs: number; ctimeMs: number },
  maxEvents: number
): value is DiscourseSegmentIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DISCOURSE_EVENT_LOG_SCHEMA_VERSION ||
    value.segment !== segment ||
    value.fileSize !== stat.size ||
    value.fileMtimeMs !== stat.mtimeMs ||
    value.fileCtimeMs !== stat.ctimeMs ||
    !Array.isArray(value.entries) ||
    value.entries.length > maxEvents
  ) {
    return false;
  }
  let nextOffset = 0;
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      candidate.segment !== segment ||
      !Number.isSafeInteger(candidate.sequence) ||
      !Number.isSafeInteger(candidate.offset) ||
      !Number.isSafeInteger(candidate.length) ||
      candidate.offset !== nextOffset ||
      (candidate.length as number) < 2 ||
      typeof candidate.kind !== 'string' ||
      typeof candidate.operationId !== 'string' ||
      typeof candidate.requestFingerprint !== 'string' ||
      typeof candidate.eventChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.eventChecksum)
    ) {
      return false;
    }
    nextOffset += candidate.length as number;
  }
  return nextOffset === stat.size;
}

function isManifest(value: unknown): value is DiscourseLogManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DISCOURSE_EVENT_LOG_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.eventCount) ||
    !Number.isSafeInteger(value.nextSequence) ||
    !Array.isArray(value.segments) ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    value.segments.length > MAX_LOG_SEGMENTS
  ) {
    return false;
  }
  if (!value.segments.every(
    (candidate) =>
      isRecord(candidate) &&
      Number.isSafeInteger(candidate.segment) &&
      Number.isSafeInteger(candidate.eventCount) &&
      Number.isSafeInteger(candidate.byteLength) &&
      (candidate.firstSequence === null || Number.isSafeInteger(candidate.firstSequence)) &&
      (candidate.lastSequence === null || Number.isSafeInteger(candidate.lastSequence))
  )) {
    return false;
  }
  const { checksum, ...unsigned } = value;
  return checksum === checksumJson(unsigned);
}

function manifestDescribesContiguousLog(
  manifest: DiscourseLogManifest,
  segments: readonly number[],
  segmentMaxEvents: number,
  segmentMaxBytes: number
): boolean {
  if (
    manifest.segments.length !== segments.length ||
    manifest.eventCount < 0 ||
    manifest.eventCount > MAX_LOG_EVENTS ||
    manifest.nextSequence !== manifest.eventCount + 1
  ) {
    return false;
  }
  let expectedSequence = 1;
  let eventCount = 0;
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const summary = manifest.segments[index]!;
    if (
      summary.segment !== segments[index] ||
      summary.eventCount < 1 ||
      summary.eventCount > segmentMaxEvents ||
      summary.byteLength < 1 ||
      summary.byteLength > segmentMaxBytes ||
      summary.firstSequence !== expectedSequence ||
      summary.lastSequence !== expectedSequence + summary.eventCount - 1
    ) {
      return false;
    }
    expectedSequence += summary.eventCount;
    eventCount += summary.eventCount;
  }
  return eventCount === manifest.eventCount;
}

function manifestMatches(
  manifest: DiscourseLogManifest,
  segments: readonly DiscourseManifestSegment[],
  entries: readonly DiscourseLogIndexEntry[]
): boolean {
  return (
    manifest.eventCount === entries.length &&
    manifest.nextSequence === (entries.at(-1)?.sequence ?? 0) + 1 &&
    JSON.stringify(manifest.segments) === JSON.stringify(segments)
  );
}

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error('Discourse events cannot contain undefined values.');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function checksumJson(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedJson(filePath: string, maxBytes: number): Promise<unknown> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      !hasNoGroupOrOtherPosixAccess(stat) ||
      !isOwnedByCurrentUser(stat)
    ) {
      throw new Error('Discourse index file failed its integrity check.');
    }
    try {
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Discourse event-log root must be a private directory.');
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    await enforcePosixMode(handle, 0o700);
  } finally {
    await handle.close();
  }
}

async function atomicPrivateWrite(
  directory: string,
  target: string,
  content: string
): Promise<void> {
  const temporary = path.join(
    directory,
    `.${path.basename(target)}-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await syncDirectoryIfSupported(directory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
