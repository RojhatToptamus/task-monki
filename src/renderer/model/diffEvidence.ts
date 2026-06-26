export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'addition' | 'deletion';

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffBlock {
  id: string;
  label: string;
  source: DiffSectionSource;
  lines: DiffLine[];
}

export interface DiffFile {
  id: string;
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  blocks: DiffBlock[];
}

export interface DiffFileGroup {
  directory: string;
  files: DiffFile[];
}

export type DiffFileStatusFilter = 'all' | DiffFile['status'];

export interface DiffTreeDirectory {
  type: 'directory';
  id: string;
  name: string;
  path: string;
  additions: number;
  deletions: number;
  fileCount: number;
  children: DiffTreeNode[];
}

export interface DiffTreeFile {
  type: 'file';
  id: string;
  name: string;
  path: string;
  additions: number;
  deletions: number;
  fileCount: 1;
  file: DiffFile;
}

export type DiffTreeNode = DiffTreeDirectory | DiffTreeFile;

export interface DiffFileFilterOptions {
  query?: string;
  status?: DiffFileStatusFilter;
}

export type DiffEvidenceScope = 'all' | 'committed' | 'uncommitted';
export type DiffSectionSource = 'committed' | 'staged' | 'unstaged' | 'local';

interface RawDiffSection {
  label: string;
  source: DiffSectionSource;
  lines: string[];
}

interface ParsedFileBlock {
  path: string;
  oldPath?: string;
  status: DiffFile['status'];
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export function parseGitDiffEvidence(text: string): DiffFile[] {
  return parseGitDiffEvidenceForScope(text, 'all');
}

export function parseGitDiffEvidenceForScope(
  text: string,
  scope: DiffEvidenceScope
): DiffFile[] {
  const sections = extractDiffSections(text);
  return parseDiffSections(filterDiffSectionsByScope(sections, scope));
}

function parseDiffSections(sections: RawDiffSection[]): DiffFile[] {
  const filesByPath = new Map<string, DiffFile>();

  for (const section of sections) {
    const parsedFiles = parseUnifiedDiff(section.lines);
    for (const parsed of parsedFiles) {
      const existing = filesByPath.get(parsed.path);
      const block: DiffBlock = {
        id: `${section.label}:${parsed.path}:${existing?.blocks.length ?? 0}`,
        label: section.label,
        source: section.source,
        lines: parsed.lines
      };

      if (existing) {
        existing.additions += parsed.additions;
        existing.deletions += parsed.deletions;
        existing.status = mergeStatus(existing.status, parsed.status);
        existing.blocks.push(block);
      } else {
        filesByPath.set(parsed.path, {
          id: parsed.path,
          path: parsed.path,
          oldPath: parsed.oldPath,
          status: parsed.status,
          additions: parsed.additions,
          deletions: parsed.deletions,
          blocks: [block]
        });
      }
    }
  }

  return [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function filterDiffSectionsByScope(
  sections: RawDiffSection[],
  scope: DiffEvidenceScope
): RawDiffSection[] {
  if (scope === 'all') {
    return sections;
  }
  if (scope === 'committed') {
    return sections.filter((section) => section.source === 'committed');
  }
  return sections.filter(
    (section) => section.source === 'staged' || section.source === 'unstaged'
  );
}

export function groupDiffFiles(files: DiffFile[]): DiffFileGroup[] {
  const groups = new Map<string, DiffFile[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf('/');
    const directory = slash === -1 ? 'Root' : file.path.slice(0, slash);
    const group = groups.get(directory);
    if (group) {
      group.push(file);
    } else {
      groups.set(directory, [file]);
    }
  }
  return [...groups.entries()]
    .map(([directory, groupedFiles]) => ({
      directory,
      files: groupedFiles.sort((a, b) => a.path.localeCompare(b.path))
    }))
    .sort((a, b) => {
      if (a.directory === 'Root') return -1;
      if (b.directory === 'Root') return 1;
      return a.directory.localeCompare(b.directory);
    });
}

export function filterDiffFiles(
  files: DiffFile[],
  options: DiffFileFilterOptions
): DiffFile[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  const status = options.status ?? 'all';

  return files.filter((file) => {
    if (status !== 'all' && file.status !== status) {
      return false;
    }
    if (!query) {
      return true;
    }
    return (
      file.path.toLowerCase().includes(query) ||
      file.oldPath?.toLowerCase().includes(query) === true
    );
  });
}

export function buildDiffFileTree(files: DiffFile[]): DiffTreeDirectory {
  const root = createDirectory('Root', '');

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    const ancestors: MutableDiffTreeDirectory[] = [root];
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = getOrCreateDirectory(current, segment);
      ancestors.push(current);
    }

    const node: DiffTreeFile = {
      type: 'file',
      id: `file:${file.id}`,
      name: segments.at(-1) ?? file.path,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      fileCount: 1,
      file
    };
    current.children.push(node);

    for (const ancestor of ancestors) {
      ancestor.additions += file.additions;
      ancestor.deletions += file.deletions;
      ancestor.fileCount += 1;
    }
  }

  return finalizeDirectory(root);
}

function extractDiffSections(text: string): RawDiffSection[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: RawDiffSection[] = [];
  let current: RawDiffSection | undefined;

  for (const line of lines) {
    const heading = /^## (Committed|Staged|Unstaged) diff\s*$/.exec(line);
    if (heading) {
      current = {
        label: `${heading[1]} diff`,
        source: diffSectionSource(heading[1]),
        lines: []
      };
      sections.push(current);
      continue;
    }
    if (/^## /.test(line)) {
      current = undefined;
      continue;
    }
    current?.lines.push(line);
  }

  if (sections.length === 0 && lines.some((line) => line.startsWith('diff --git '))) {
    return [{ label: 'Local diff', source: 'local', lines }];
  }

  return sections;
}

function diffSectionSource(heading: string): DiffSectionSource {
  switch (heading) {
    case 'Committed':
      return 'committed';
    case 'Staged':
      return 'staged';
    case 'Unstaged':
      return 'unstaged';
    default:
      return 'local';
  }
}

function parseUnifiedDiff(lines: string[]): ParsedFileBlock[] {
  const files: ParsedFileBlock[] = [];
  let chunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (chunk.length > 0) {
        const parsed = parseFileChunk(chunk);
        if (parsed) {
          files.push(parsed);
        }
      }
      chunk = [line];
    } else if (chunk.length > 0) {
      chunk.push(line);
    }
  }

  if (chunk.length > 0) {
    const parsed = parseFileChunk(chunk);
    if (parsed) {
      files.push(parsed);
    }
  }

  return files;
}

function parseFileChunk(lines: string[]): ParsedFileBlock | undefined {
  const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
  if (!header) {
    return undefined;
  }

  let oldPath: string | undefined = header[1];
  let newPath: string | undefined = header[2];
  let status: DiffFile['status'] = 'modified';
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const parsedLines: DiffLine[] = [];

  for (const line of lines) {
    if (line === 'new file mode') {
      status = 'added';
    } else if (line.startsWith('new file mode ')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode ')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      status = 'renamed';
      oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      status = 'renamed';
      newPath = line.slice('rename to '.length);
    } else if (line.startsWith('--- ')) {
      oldPath = parseDiffPath(line.slice(4), oldPath);
    } else if (line.startsWith('+++ ')) {
      newPath = parseDiffPath(line.slice(4), newPath);
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      parsedLines.push({ kind: 'hunk', content: line });
      continue;
    }

    if (!inHunk || line.startsWith('\\ No newline at end of file')) {
      parsedLines.push({ kind: 'meta', content: line });
      continue;
    }

    if (line.startsWith('+')) {
      parsedLines.push({ kind: 'addition', newLine, content: line });
      additions += 1;
      newLine += 1;
    } else if (line.startsWith('-')) {
      parsedLines.push({ kind: 'deletion', oldLine, content: line });
      deletions += 1;
      oldLine += 1;
    } else {
      parsedLines.push({ kind: 'context', oldLine, newLine, content: line });
      oldLine += 1;
      newLine += 1;
    }
  }

  const path = newPath && newPath !== '/dev/null' ? newPath : oldPath;
  if (!path || path === '/dev/null') {
    return undefined;
  }

  return {
    path,
    oldPath: oldPath && oldPath !== path && oldPath !== '/dev/null' ? oldPath : undefined,
    status,
    additions,
    deletions,
    lines: parsedLines
  };
}

function parseDiffPath(value: string, fallback: string | undefined): string | undefined {
  if (value === '/dev/null') {
    return value;
  }
  if (value.startsWith('a/') || value.startsWith('b/')) {
    return value.slice(2);
  }
  return value || fallback;
}

function mergeStatus(a: DiffFile['status'], b: DiffFile['status']): DiffFile['status'] {
  if (a === b) {
    return a;
  }
  if (a === 'renamed' || b === 'renamed') {
    return 'renamed';
  }
  return 'modified';
}

interface MutableDiffTreeDirectory extends DiffTreeDirectory {
  directoryChildren: Map<string, MutableDiffTreeDirectory>;
}

function createDirectory(name: string, path: string): MutableDiffTreeDirectory {
  return {
    type: 'directory',
    id: `dir:${path || '.'}`,
    name,
    path,
    additions: 0,
    deletions: 0,
    fileCount: 0,
    children: [],
    directoryChildren: new Map()
  };
}

function getOrCreateDirectory(
  parent: MutableDiffTreeDirectory,
  name: string
): MutableDiffTreeDirectory {
  const path = parent.path ? `${parent.path}/${name}` : name;
  const existing = parent.directoryChildren.get(path);
  if (existing) {
    return existing;
  }

  const directory = createDirectory(name, path);
  parent.directoryChildren.set(path, directory);
  parent.children.push(directory);
  return directory;
}

function finalizeDirectory(directory: MutableDiffTreeDirectory): DiffTreeDirectory {
  const sortedChildren = [...directory.children]
    .map((child) =>
      child.type === 'directory'
        ? finalizeDirectory(child as MutableDiffTreeDirectory)
        : child
    )
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    type: 'directory',
    id: directory.id,
    name: directory.name,
    path: directory.path,
    additions: directory.additions,
    deletions: directory.deletions,
    fileCount: directory.fileCount,
    children: sortedChildren
  };
}
