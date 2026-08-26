import type {
  ClientTextExcerpt,
  ClientTextExcerptAvailability,
  TaskDetailSnapshot
} from '../../shared/contracts';

export const CLIENT_DETAIL_TEXT_BYTES = 128 * 1024;

export function projectTaskDetailForClient(
  detail: TaskDetailSnapshot
): TaskDetailSnapshot {
  const textExcerpts: ClientTextExcerpt[] = [];
  return {
    ...detail,
    runs: detail.runs.map((run) => {
      if (!run.finalMessage) return run;
      return {
        ...run,
        finalMessage: projectText({
          value: run.finalMessage,
          collection: 'runs',
          recordId: run.id,
          fieldPath: 'finalMessage',
          availableContent: run.finalArtifactId
            ? { kind: 'BOUNDED_ARTIFACT', artifactId: run.finalArtifactId }
            : { kind: 'NOT_AVAILABLE' },
          textExcerpts
        })
      };
    }),
    agentItems: detail.agentItems.map((item) => ({
      ...item,
      payload: projectValue(
        item.payload,
        'payload',
        item.id,
        'agentItems',
        textExcerpts
      )
    })),
    events: detail.events.map((event) => ({
      ...event,
      payload: projectValue(
        event.payload,
        'payload',
        event.id,
        'events',
        textExcerpts
      )
    })),
    textExcerpts
  };
}

function projectValue(
  value: unknown,
  fieldPath: string,
  recordId: string,
  collection: Extract<ClientTextExcerpt['collection'], 'agentItems' | 'events'>,
  textExcerpts: ClientTextExcerpt[]
): unknown {
  if (typeof value === 'string') {
    return projectText({
      value,
      collection,
      recordId,
      fieldPath,
      availableContent: { kind: 'NOT_AVAILABLE' },
      textExcerpts
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      projectValue(
        entry,
        `${fieldPath}[${index}]`,
        recordId,
        collection,
        textExcerpts
      )
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        projectValue(
          entry,
          `${fieldPath}.${key}`,
          recordId,
          collection,
          textExcerpts
        )
      ])
    );
  }
  return value;
}

function projectText(input: {
  value: string;
  collection: ClientTextExcerpt['collection'];
  recordId: string;
  fieldPath: string;
  availableContent: ClientTextExcerptAvailability;
  textExcerpts: ClientTextExcerpt[];
}): string {
  const bytes = Buffer.from(input.value, 'utf8');
  if (bytes.byteLength <= CLIENT_DETAIL_TEXT_BYTES) {
    return input.value;
  }
  const projected = boundedTextExcerpt(bytes);
  input.textExcerpts.push({
    collection: input.collection,
    recordId: input.recordId,
    fieldPath: input.fieldPath,
    originalByteCount: bytes.byteLength,
    displayedByteCount: Buffer.byteLength(projected, 'utf8'),
    availableContent: input.availableContent
  });
  return projected;
}

function boundedTextExcerpt(bytes: Buffer): string {
  let omittedBytes = bytes.byteLength - CLIENT_DETAIL_TEXT_BYTES;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const marker = Buffer.from(
      `\n\n[Task Monki omitted ${omittedBytes} bytes from this display excerpt.]\n\n`,
      'utf8'
    );
    const retainedByteBudget = CLIENT_DETAIL_TEXT_BYTES - marker.byteLength;
    const headBudget = Math.floor(retainedByteBudget / 2);
    const tailBudget = retainedByteBudget - headBudget;
    const headEnd = utf8PrefixBoundary(bytes, headBudget);
    const tailStart = utf8SuffixBoundary(
      bytes,
      bytes.byteLength - tailBudget
    );
    const actualOmittedBytes =
      bytes.byteLength - headEnd - (bytes.byteLength - tailStart);
    if (actualOmittedBytes !== omittedBytes) {
      omittedBytes = actualOmittedBytes;
      continue;
    }
    return Buffer.concat([
      bytes.subarray(0, headEnd),
      marker,
      bytes.subarray(tailStart)
    ]).toString('utf8');
  }
  throw new Error('Could not stabilize the task-detail excerpt byte boundary.');
}

function utf8PrefixBoundary(bytes: Buffer, requestedEnd: number): number {
  let end = Math.min(requestedEnd, bytes.byteLength);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return end;
}

function utf8SuffixBoundary(bytes: Buffer, requestedStart: number): number {
  let start = Math.max(0, requestedStart);
  while (
    start < bytes.byteLength &&
    isUtf8ContinuationByte(bytes[start])
  ) {
    start += 1;
  }
  return start;
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
