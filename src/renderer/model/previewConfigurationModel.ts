import { isCollection, isNode, isScalar, parseDocument, type Document, type ToStringOptions } from 'yaml';
import type { PreviewDescription } from 'previewhost';
import type { DiffLine } from './diffEvidence';

/*
 * The Preview configuration file as the person reads it: entries grouped by what they are, the
 * folders they run in and the secrets they read, and typed edits written back into the file text
 * without disturbing the lines they do not touch.
 */

export type ConfigurationGroupName = 'Services' | 'Databases' | 'Setup steps';
export type EnvironmentKind = 'text' | 'secret' | 'service' | 'other';

export interface EnvironmentBinding {
  key: string;
  kind: EnvironmentKind;
  /** Text value, secret reference id or service name; a compact description for `other`. */
  value: string;
}

export interface ConfigurationEntry {
  id: string;
  /** Where the entry lives in the file: `['services', id]`, or `[]` for a single-application file. */
  path: string[];
  type: string;
  group: ConfigurationGroupName;
  folder?: string;
  folderField?: 'cwd' | 'directory';
  command?: string[];
  dependsOn: string[];
  /** Jobs only; the file's default is `always`. */
  run?: 'always' | 'once';
  readyPath?: string;
  environment: EnvironmentBinding[];
  /** The `url` of an external service, when the file sets one. */
  address?: EnvironmentBinding;
  /** Everything the structured editor does not model, in file order. */
  other: Array<[string, unknown]>;
  /** The entry as written, for summaries of entries without a command. */
  node: Record<string, unknown>;
}

export interface FolderUse {
  path: string;
  entries: string[];
}

export interface SecretUse {
  id: string;
  uses: Array<{ entry: string; key: string }>;
}

export interface ConfigurationOverview {
  services: ConfigurationEntry[];
  databases: ConfigurationEntry[];
  steps: ConfigurationEntry[];
  folders: FolderUse[];
  secrets: SecretUse[];
}

const DATABASE_TYPES = new Set(['postgres', 'redis', 'external-postgres', 'external-redis']);
const COMMAND_TYPES = new Set(['command', 'worker', 'job']);
const READY_PATH_TYPES = new Set(['command', 'attach', 'preview']);
const MODELED = new Set(['type', 'cwd', 'directory', 'command', 'dependsOn', 'run', 'readyPath', 'env', 'url']);

export function entryGroup(type: string): ConfigurationGroupName {
  if (DATABASE_TYPES.has(type)) return 'Databases';
  if (type === 'job') return 'Setup steps';
  return 'Services';
}

/** The typed fields the inline editor offers for an entry. */
export function editableFields(entry: Pick<ConfigurationEntry, 'type' | 'path' | 'folderField'>) {
  const folder = COMMAND_TYPES.has(entry.type) || entry.type === 'compose' ? 'cwd' : entry.type === 'static' ? 'directory' : undefined;
  return {
    command: COMMAND_TYPES.has(entry.type),
    folder: folder ? (entry.folderField ?? folder) : undefined,
    dependsOn: entry.path.length > 0 && !DATABASE_TYPES.has(entry.type),
    run: entry.type === 'job',
    readyPath: READY_PATH_TYPES.has(entry.type),
    environment: COMMAND_TYPES.has(entry.type),
    /** An external HTTP service takes a URL; an external database's URL may be a secret reference. */
    address: entry.type === 'attach' ? ('url' as const) : entry.type === 'external-postgres' || entry.type === 'external-redis' ? ('reference' as const) : undefined
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function environmentBinding(key: string, value: unknown): EnvironmentBinding {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { key, kind: 'text', value: String(value) };
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.secret === 'string') return { key, kind: 'secret', value: value.secret };
    if (keys.length === 1 && typeof value.service === 'string') return { key, kind: 'service', value: value.service };
    return { key, kind: 'other', value: keys.map((name) => `${name}: ${String(value[name])}`).join(', ') };
  }
  return { key, kind: 'other', value: value === null || value === undefined ? '' : JSON.stringify(value) };
}

function entryFrom(id: string, path: string[], node: Record<string, unknown>, single: boolean): ConfigurationEntry {
  const type = String(node.type ?? '');
  const folderField = typeof node.cwd === 'string' ? 'cwd' : typeof node.directory === 'string' ? 'directory' : undefined;
  return {
    id,
    path,
    type,
    group: entryGroup(type),
    folder: folderField ? String(node[folderField]) : undefined,
    folderField,
    command: Array.isArray(node.command) ? node.command.map(String) : undefined,
    dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.map(String) : [],
    run: type === 'job' ? (node.run === 'once' ? 'once' : 'always') : undefined,
    readyPath: typeof node.readyPath === 'string' ? node.readyPath : undefined,
    environment: isRecord(node.env) ? Object.entries(node.env).map(([key, value]) => environmentBinding(key, value)) : [],
    address: node.url === undefined || node.url === null ? undefined : environmentBinding('url', node.url),
    other: Object.entries(node).filter(([key]) => !MODELED.has(key) && !(single && key === 'name')),
    node
  };
}

/** The file's entries in file order, or undefined while the text does not parse to a configuration. */
export function readConfiguration(text: string): ConfigurationEntry[] | undefined {
  const document = parseDocument(text);
  if (document.errors.length) return undefined;
  let config: unknown;
  try {
    config = document.toJS({ maxAliasCount: 0 });
  } catch {
    return undefined;
  }
  if (!isRecord(config)) return undefined;
  if (config.type === 'environment')
    return isRecord(config.services)
      ? Object.entries(config.services).flatMap(([id, node]) => (isRecord(node) ? [entryFrom(id, ['services', id], node, false)] : []))
      : [];
  return [entryFrom(typeof config.name === 'string' && config.name ? config.name : 'Application', [], config, true)];
}

/**
 * The entries a past run started with, from the runtime's redacted description: environment keys
 * without values and absolute folders. Command probes are entries of their own because they ran too.
 */
export function describedEntries(description: PreviewDescription): ConfigurationEntry[] {
  const spec = description.spec as unknown as Record<string, unknown>;
  if (description.compose)
    return description.compose.services.map((service) =>
      entryFrom(service.id, ['services', service.id], { type: 'compose', cwd: spec.cwd, image: service.image }, false)
    );
  const services: Array<[string, Record<string, unknown>, boolean]> =
    spec.type === 'environment' && isRecord(spec.services)
      ? Object.entries(spec.services).flatMap(([id, node]): Array<[string, Record<string, unknown>, boolean]> => (isRecord(node) ? [[id, node, false]] : []))
      : [[typeof spec.name === 'string' ? spec.name : 'Application', spec, true]];
  return services.flatMap(([id, node, single]) => {
    const { envKeys, bindings, ...rest } = node;
    const env = Object.fromEntries([
      ...(Array.isArray(envKeys) ? envKeys.map((key): [string, unknown] => [String(key), '']) : []),
      ...(isRecord(bindings) ? Object.entries(bindings) : [])
    ]);
    const entry = entryFrom(id, single ? [] : ['services', id], { ...rest, env }, single);
    const probes = (
      [
        ['readiness', node.ready],
        ['health check', isRecord(node.liveness) ? node.liveness.probe : undefined]
      ] as const
    ).flatMap(([kind, probe]) =>
      isRecord(probe) && probe.type === 'command'
        ? [entryFrom(`${id} · ${kind}`, [], { type: 'probe', command: probe.command, ...(typeof probe.cwd === 'string' ? { cwd: probe.cwd } : {}) }, true)]
        : []
    );
    return [entry, ...probes];
  });
}

/** The redacted description's secret requirements, named by the entries that read them. */
export function describedSecrets(description: PreviewDescription): SecretUse[] {
  const spec = description.spec as { type?: string; name?: string };
  const fallback = spec.type === 'environment' ? 'Application' : (spec.name ?? 'Application');
  return (description.secrets ?? []).map((secret) => ({
    id: secret.id,
    uses: secret.bindings.map((binding) => ({ entry: binding.service ?? fallback, key: binding.key }))
  }));
}

/**
 * Whether an entry waits, directly or through other entries, for a database Preview manages. A
 * step can run once only then, because "once" is recorded with that retained data.
 */
export function waitsForManagedData(entry: ConfigurationEntry, entries: ConfigurationEntry[]): boolean {
  const byId = new Map(entries.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const visit = (current: ConfigurationEntry): boolean =>
    current.dependsOn.some((id) => {
      const dependency = byId.get(id);
      if (!dependency || seen.has(id)) return false;
      seen.add(id);
      return dependency.type === 'postgres' || dependency.type === 'redis' || visit(dependency);
    });
  return visit(entry);
}

/** External services that cannot start until the file says where they are. */
export function needsAddress(entry: ConfigurationEntry): boolean {
  return (entry.type === 'attach' || entry.type === 'external-postgres' || entry.type === 'external-redis') && !entry.address?.value;
}

/** Steps in the order they can run: each after the steps it waits for, otherwise in file order. */
export function orderSteps(steps: ConfigurationEntry[]): ConfigurationEntry[] {
  const ids = new Set(steps.map((step) => step.id));
  const done = new Set<string>();
  const ordered: ConfigurationEntry[] = [];
  while (ordered.length < steps.length) {
    const next =
      steps.find((step) => !done.has(step.id) && step.dependsOn.every((id) => !ids.has(id) || done.has(id))) ??
      steps.find((step) => !done.has(step.id))!; // a cycle keeps file order
    done.add(next.id);
    ordered.push(next);
  }
  return ordered;
}

const normalizeFolder = (folder: string) => {
  const trimmed = folder.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return '.';
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '').replace(/^\.\//, '') : trimmed;
};

/** How a folder is named for the person: the task worktree, a folder inside it, or an outside folder by name. */
export function folderLabel(folder: string, projectDirectory?: string): { name: string; root: boolean; external: boolean } {
  const path = normalizeFolder(folder);
  const project = projectDirectory?.replace(/\/+$/, '');
  if (path === '.' || path === project) return { name: 'Task worktree', root: true, external: false };
  if (project && path.startsWith(`${project}/`)) return { name: path.slice(project.length + 1), root: false, external: false };
  if (!path.startsWith('/') && !path.startsWith('../') && path !== '..') return { name: path, root: false, external: false };
  return { name: path.split('/').filter(Boolean).at(-1) ?? path, root: false, external: true };
}

export function configurationOverview(entries: ConfigurationEntry[], secrets?: SecretUse[]): ConfigurationOverview {
  const folders = new Map<string, string[]>();
  for (const entry of entries)
    if (entry.folder !== undefined) {
      const path = normalizeFolder(entry.folder);
      folders.set(path, [...(folders.get(path) ?? []), entry.id]);
    }
  const references = new Map<string, SecretUse['uses']>();
  const use = (id: string, entry: string, key: string) => {
    if (id) references.set(id, [...(references.get(id) ?? []), { entry, key }]);
  };
  if (!secrets)
    for (const entry of entries) {
      for (const binding of entry.environment) if (binding.kind === 'secret') use(binding.value, entry.id, binding.key);
      const url = entry.node.url;
      if (isRecord(url) && typeof url.secret === 'string') use(url.secret, entry.id, 'url');
    }
  return {
    services: entries.filter((entry) => entry.group === 'Services'),
    databases: entries.filter((entry) => entry.group === 'Databases'),
    steps: orderSteps(entries.filter((entry) => entry.group === 'Setup steps')),
    folders: [...folders].map(([path, ids]) => ({ path, entries: ids })),
    secrets: secrets ?? [...references].map(([id, uses]) => ({ id, uses }))
  };
}

/**
 * A command as one line: arguments separated by spaces, JSON-quoted when they contain whitespace
 * (exactly as the shared `commandText` writes them), and also when empty or starting with a quote,
 * the two arguments `commandText` cannot round-trip.
 */
export function formatCommand(command: string[]): string {
  return command.map((argument) => (argument === '' || /\s/.test(argument) || argument.startsWith('"') ? JSON.stringify(argument) : argument)).join(' ');
}

/** The inverse of `formatCommand` and `commandText`: whitespace separates, a leading quote starts a JSON string. Never a shell. */
export function parseCommand(text: string): { command: string[] } | { error: string } {
  const command: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index++;
      continue;
    }
    let end = index;
    if (text[index] === '"') {
      end++;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return { error: 'Close the quoted argument.' };
      end++;
      if (end < text.length && !/\s/.test(text[end]!)) return { error: 'Put a space after a quoted argument.' };
      try {
        command.push(String(JSON.parse(text.slice(index, end))));
      } catch {
        return { error: 'Use JSON escapes inside quotes, such as \\" or \\\\.' };
      }
    } else {
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      command.push(text.slice(index, end));
    }
    index = end;
  }
  return command.length ? { command } : { error: 'Enter a command.' };
}

/* Editing ----------------------------------------------------------------------------------- */

interface FileFormat {
  options: ToStringOptions;
  /** Whether `{ a: b }` and `[a, b]` are written with inner spaces, decided per bracket kind. */
  padded: { '{': boolean; '[': boolean };
}

/** Formatting read from the file, so rewritten lines look like their neighbours. */
function fileFormat(text: string): FileFormat {
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#.*$/, ''));
  const habit = (open: string) => {
    const padded = code.filter((line) => new RegExp(`\\${open} \\S`).test(line)).length;
    const tight = code.filter((line) => new RegExp(`\\${open}[^\\s\\]}]`).test(line)).length;
    return padded + tight ? padded > tight : undefined;
  };
  const maps = habit('{');
  const seqs = habit('[');
  const indents = code.flatMap((line) => {
    const match = /^( +)\S/.exec(line);
    return match ? [match[1]!.length] : [];
  });
  let indentSeq = true;
  for (let index = 1; index < code.length; index++) {
    const item = /^( *)- /.exec(code[index]!);
    const parent = /^( *)[^\s#-][^:]*:\s*$/.exec(code[index - 1]!);
    if (item && parent) {
      indentSeq = item[1]!.length > parent[1]!.length;
      break;
    }
  }
  return {
    options: { lineWidth: 0, indent: indents.length ? Math.min(...indents) : 2, indentSeq },
    padded: { '{': maps ?? seqs ?? true, '[': seqs ?? maps ?? true }
  };
}

/** The document's lines, each flow collection spaced the way the file spaces that kind of bracket. */
function renderLines(document: Document, format: FileFormat): string[] {
  const tight = document.toString({ ...format.options, flowCollectionPadding: false }).split('\n');
  const padded = document.toString({ ...format.options, flowCollectionPadding: true }).split('\n');
  if (tight.length !== padded.length) return padded;
  return tight.map((line, index) => {
    const bracket = /[[{]/.exec(line.replace(/\s#.*$/, ''))?.[0] as '{' | '[' | undefined;
    return bracket && format.padded[bracket] ? padded[index]! : line;
  });
}

interface Hunk {
  /** The changed range in the shared base, `[from, to)`. */
  from: number;
  to: number;
  /** The range that replaces it, `[start, end)`. */
  start: number;
  end: number;
  side: 'written' | 'edited';
}

/** About 1 MB of alignment table: a few hundred changed lines on each side align line by line. */
const MAX_ALIGNED_LINE_PAIRS = 250_000;

/** Line ranges where `after` differs from `before`, from a longest-common-subsequence alignment. */
function lineChanges(before: string[], after: string[], side: Hunk['side']): Hunk[] {
  // An edit touches a few lines; only the span between the common head and tail needs aligning.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const left = before.slice(head, before.length - tail);
  const right = after.slice(head, after.length - tail);
  // The alignment table grows with the product of the differing spans. Past the bound, the whole
  // span reads as one replacement: still exact about which lines changed, and the work stays small.
  if (left.length * right.length > MAX_ALIGNED_LINE_PAIRS) {
    return [{ from: head, to: head + left.length, start: head, end: head + right.length, side }];
  }
  const columns = right.length + 1;
  const table = new Uint32Array((left.length + 1) * columns);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i * columns + j] =
        left[i] === right[j] ? table[(i + 1) * columns + j + 1]! + 1 : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let from = 0;
  let start = 0;
  const close = () => {
    if (i > from || j > start) hunks.push({ from: head + from, to: head + i, start: head + start, end: head + j, side });
  };
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      close();
      from = ++i;
      start = ++j;
    } else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) i++;
    else j++;
  }
  i = left.length;
  j = right.length;
  close();
  return hunks;
}

/** Two changes conflict when they replace the same lines, or one inserts strictly inside the other. */
const overlaps = (left: { from: number; to: number }, right: Hunk) => {
  const leftEmpty = left.from === left.to;
  const rightEmpty = right.from === right.to;
  if (leftEmpty && rightEmpty) return left.from === right.from;
  if (leftEmpty) return right.from < left.from && left.from < right.to;
  if (rightEmpty) return left.from < right.from && right.from < left.to;
  return right.from < left.to && left.from < right.to;
};

/**
 * Three-way merge over the document's own formatting: lines only the person formatted differently
 * keep their bytes, lines the edit changed take the new text; where both apply the edit wins.
 */
function mergeLines(written: string[], base: string[], edited: string[]): string[] {
  const hunks = [...lineChanges(base, written, 'written'), ...lineChanges(base, edited, 'edited')].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: string[] = [];
  let position = 0;
  let inWritten = 0;
  let inEdited = 0;
  for (let index = 0; index < hunks.length; ) {
    const cluster = [hunks[index++]!];
    const range = { from: cluster[0]!.from, to: cluster[0]!.to };
    while (index < hunks.length && overlaps(range, hunks[index]!)) {
      range.to = Math.max(range.to, hunks[index]!.to);
      cluster.push(hunks[index++]!);
    }
    const gap = range.from - position;
    merged.push(...written.slice(inWritten, inWritten + gap));
    inWritten += gap;
    inEdited += gap;
    const length = (side: Hunk['side']) =>
      range.to - range.from + cluster.filter((hunk) => hunk.side === side).reduce((sum, hunk) => sum + (hunk.end - hunk.start) - (hunk.to - hunk.from), 0);
    const writtenLength = length('written');
    const editedLength = length('edited');
    const edits = cluster.filter((hunk) => hunk.side === 'edited');
    if (!edits.length) merged.push(...written.slice(inWritten, inWritten + writtenLength));
    else if (writtenLength !== range.to - range.from) merged.push(...edited.slice(inEdited, inEdited + editedLength));
    else {
      // The person's formatting changed lines one-for-one, so it survives on every line the edit left alone.
      let base = range.from;
      for (const edit of edits) {
        merged.push(...written.slice(inWritten + base - range.from, inWritten + edit.from - range.from));
        merged.push(...edited.slice(edit.start, edit.end));
        base = edit.to;
      }
      merged.push(...written.slice(inWritten + base - range.from, inWritten + writtenLength));
    }
    inWritten += writtenLength;
    inEdited += editedLength;
    position = range.to;
  }
  merged.push(...written.slice(inWritten));
  return merged;
}

/** A line diff of the file with a few lines of context around each change, as hunks. */
export function configurationDiff(before: string, after: string, context = 3): DiffLine[] {
  const left = before ? before.replace(/\n$/, '').split('\n') : [];
  const right = after ? after.replace(/\n$/, '').split('\n') : [];
  const changes = lineChanges(left, right, 'edited');
  const lines: DiffLine[] = [];
  for (let index = 0; index < changes.length; ) {
    const group = [changes[index++]!];
    // Changes closer than twice the context share one hunk.
    while (index < changes.length && changes[index]!.from - group.at(-1)!.to <= context * 2) group.push(changes[index++]!);
    const first = group[0]!;
    const last = group.at(-1)!;
    const from = Math.max(0, first.from - context);
    const to = Math.min(left.length, last.to + context);
    const start = first.start - (first.from - from);
    const end = last.end + (to - last.to);
    lines.push({ kind: 'hunk', content: `@@ -${from + 1},${to - from} +${start + 1},${end - start} @@` });
    let oldLine = from;
    let newLine = start;
    for (const change of group) {
      for (; oldLine < change.from; oldLine++, newLine++) lines.push({ kind: 'context', content: ` ${left[oldLine]}`, oldLine: oldLine + 1, newLine: newLine + 1 });
      for (; oldLine < change.to; oldLine++) lines.push({ kind: 'deletion', content: `-${left[oldLine]}`, oldLine: oldLine + 1 });
      for (; newLine < change.end; newLine++) lines.push({ kind: 'addition', content: `+${right[newLine]}`, newLine: newLine + 1 });
    }
    for (; oldLine < to; oldLine++, newLine++) lines.push({ kind: 'context', content: ` ${left[oldLine]}`, oldLine: oldLine + 1, newLine: newLine + 1 });
  }
  return lines;
}

const sameData = (left: Document, right: Document) => {
  try {
    return JSON.stringify(left.toJS({ maxAliasCount: 0 })) === JSON.stringify(right.toJS({ maxAliasCount: 0 }));
  } catch {
    return false;
  }
};

/**
 * Applies a change through the YAML document model, so comments and structure survive, then keeps
 * every line the change did not touch byte-for-byte as written (spacing, padding, trailing
 * comments). Uses the document's own formatting only when the merged text would mean something else.
 */
export function editConfiguration(text: string, change: (document: Document) => void): string {
  const document = parseDocument(text);
  if (document.errors.length) throw new Error('Correct the file in YAML before editing it here.');
  const format = fileFormat(text);
  const base = renderLines(document, format);
  change(document);
  const next = renderLines(document, format);
  const merged = mergeLines(text.split('\n'), base, next).join('\n');
  const check = parseDocument(merged);
  return !check.errors.length && sameData(check, document) ? merged : next.join('\n');
}

function setValue(document: Document, path: string[], value: unknown) {
  if (value === undefined) {
    document.deleteIn(path);
    return;
  }
  const existing = document.getIn(path, true);
  const scalar = value === null || typeof value !== 'object';
  // A scalar replacing a scalar keeps its node, so its quoting style and comments stay.
  if (scalar && isScalar(existing)) {
    existing.value = value;
    return;
  }
  const node = document.createNode(value, scalar ? undefined : { flow: isCollection(existing) ? existing.flow : true });
  if (isNode(existing)) {
    node.commentBefore = existing.commentBefore;
    node.comment = existing.comment;
    node.spaceBefore = existing.spaceBefore;
  }
  document.setIn(path, node);
}

/** Sets one field of an entry, or removes it with `undefined`. */
export function setEntryField(text: string, entryPath: string[], field: string, value: unknown): string {
  return editConfiguration(text, (document) => setValue(document, [...entryPath, field], value));
}

export function environmentValue(kind: Exclude<EnvironmentKind, 'other'>, value: string): string | { secret: string } | { service: string } {
  return kind === 'secret' ? { secret: value } : kind === 'service' ? { service: value } : value;
}

/** Writes one environment binding, creating the entry's `env` map when it has none. */
export function setEnvironmentBinding(text: string, entryPath: string[], key: string, value: unknown): string {
  return editConfiguration(text, (document) => {
    const env = [...entryPath, 'env'];
    if (!isCollection(document.getIn(env, true))) document.setIn(env, document.createNode({}, { flow: false }));
    setValue(document, [...env, key], value);
  });
}

/** Renames a binding in place, keeping its position, value and comments. */
export function renameEnvironmentBinding(text: string, entryPath: string[], from: string, to: string): string {
  return editConfiguration(text, (document) => {
    const env = document.getIn([...entryPath, 'env'], true);
    if (!isCollection(env)) throw new Error(`${from} is no longer in the file.`);
    const pair = (env.items as Array<{ key: unknown }>).find((item) => (isScalar(item.key) ? item.key.value : item.key) === from);
    if (!pair) throw new Error(`${from} is no longer in the file.`);
    if (isScalar(pair.key)) pair.key.value = to;
    else pair.key = to;
  });
}

/** Removes a binding, and the `env` map with its last binding. */
export function removeEnvironmentBinding(text: string, entryPath: string[], key: string): string {
  return editConfiguration(text, (document) => {
    const env = [...entryPath, 'env'];
    document.deleteIn([...env, key]);
    const map = document.getIn(env, true);
    if (isCollection(map) && !map.items.length) document.deleteIn(env);
  });
}
