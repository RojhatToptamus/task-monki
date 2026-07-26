import type { TaskSnapshot } from '../../shared/contracts';

export const CLIENT_SNAPSHOT_TEXT_BYTES = 128 * 1024;

export function projectTaskSnapshotForClient(
  snapshot: TaskSnapshot
): TaskSnapshot {
  return {
    ...snapshot,
    runs: snapshot.runs.map((run) =>
      run.finalMessage
        ? { ...run, finalMessage: projectText(run.finalMessage) }
        : run
    ),
    agentItems: snapshot.agentItems.map((item) => ({
      ...item,
      payload: projectValue(item.payload)
    }))
  };
}

function projectValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return projectText(value);
  }
  if (Array.isArray(value)) {
    return value.map(projectValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, projectValue(entry)])
    );
  }
  return value;
}

function projectText(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= CLIENT_SNAPSHOT_TEXT_BYTES) {
    return value;
  }
  const marker = Buffer.from(
    `\n\n[Task Monki bounded this ${bytes.byteLength}-byte field in the UI projection. Complete provider output remains in the run artifacts.]\n\n`,
    'utf8'
  );
  const retainedBytes = CLIENT_SNAPSHOT_TEXT_BYTES - marker.byteLength;
  const headBytes = Math.floor(retainedBytes / 2);
  const tailBytes = retainedBytes - headBytes;
  const head = bytes.subarray(0, headBytes).toString('utf8').replace(/\uFFFD$/u, '');
  const tail = bytes
    .subarray(bytes.byteLength - tailBytes)
    .toString('utf8')
    .replace(/^\uFFFD+/u, '');
  return `${head}${marker.toString('utf8')}${tail}`;
}
