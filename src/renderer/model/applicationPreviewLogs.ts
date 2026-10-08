/** Retain complete UTF-8 characters within the same bound as the runtime reader. */
export function appendApplicationLog(
  previous: string,
  next: string
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(previous + next);
  let start = Math.max(0, bytes.length - 65_536);
  const truncated = start > 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated };
}

export interface ApplicationLogBuffer {
  text: string;
  offset: number;
  source?: string;
  truncated: boolean;
}
export interface ApplicationLogLine {
  id: number;
  source: string;
  text: string;
  marker?: string;
}

/** The leading label is transport framing; labels printed inside a message stay text. */
export function splitApplicationLogs(
  text: string,
  sources: readonly string[],
  initialSource = '',
  offset = 0
): ApplicationLogLine[] {
  const known = new Set(sources);
  let source = initialSource;
  let position = offset;
  const rows = text.split('\n').map((raw) => {
    const prefix = /^\[([^\]\n]+)\] /.exec(raw);
    if (prefix && known.has(prefix[1]!)) source = prefix[1]!;
    const row = {
      id: position,
      source,
      text: prefix && known.has(prefix[1]!) ? raw.slice(prefix[0].length) : raw
    };
    position += raw.length + 1;
    return row;
  });
  if (text.endsWith('\n')) rows.pop();
  return text ? rows : [];
}

export function appendLogBuffer(
  previous: ApplicationLogBuffer,
  next: string,
  sources: readonly string[]
): ApplicationLogBuffer {
  const full = previous.text + next;
  const bounded = appendApplicationLog(previous.text, next);
  const removed = full.length - bounded.text.length;
  const lastRemoved = removed
    ? splitApplicationLogs(full.slice(0, removed), sources, previous.source).at(
        -1
      )?.source
    : previous.source;
  return {
    text: bounded.text,
    offset: previous.offset + removed,
    source: lastRemoved,
    truncated: previous.truncated || bounded.truncated
  };
}

export function logSourceOrder(
  spec?: import('previewhost').PreviewDescription['spec']
): string[] {
  if (!spec || spec.type !== 'environment') return [];
  const pending = new Set(Object.keys(spec.services));
  const result: string[] = [];
  while (pending.size) {
    const ready = [...pending]
      .filter(
        (id) =>
          !(spec.services[id]?.dependsOn ?? []).some((dependency) =>
            pending.has(dependency)
          )
      )
      .sort();
    // A malformed description must not trap the renderer in a loop.
    if (!ready.length) {
      result.push(...[...pending].sort());
      break;
    }
    const id = ready[0]!;
    pending.delete(id);
    result.push(id);
  }
  return result.filter((id) =>
    ['command', 'worker', 'job', 'compose'].includes(spec.services[id]!.type)
  );
}
