import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAlias, parseDocument, visit } from 'yaml';

const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SKILL_COUNT = 16;
const MAX_SKILL_BYTES = 96 * 1024;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_CATALOG_BYTES = 8 * 1024;

export interface DesignSkillCatalogEntry {
  name: string;
  description: string;
  path: string;
}

export interface DesignSkillPack {
  rootPath: string;
  skills: readonly DesignSkillCatalogEntry[];
  catalog: string;
}

export function resolveDesignSkillPackRoot(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'design-skills')
    : path.join(input.appPath, 'resources', 'design-skills');
}

export async function loadDesignSkillPack(rootPath: string): Promise<DesignSkillPack> {
  const requestedRoot = path.resolve(rootPath);
  const rootStat = await fs.lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('The Design skill root must be a regular directory, not a symlink.');
  }
  const canonicalRoot = await fs.realpath(requestedRoot);
  if (
    /[\r\n\0]/u.test(canonicalRoot) ||
    Buffer.byteLength(canonicalRoot, 'utf8') > 4_096
  ) {
    throw new Error('The Design skill root path is invalid.');
  }

  const directoryEntries = await fs.readdir(canonicalRoot, { withFileTypes: true });
  if (directoryEntries.length === 0 || directoryEntries.length > MAX_SKILL_COUNT) {
    throw new Error(`The Design skill pack must contain 1-${MAX_SKILL_COUNT} skills.`);
  }

  const skills: DesignSkillCatalogEntry[] = [];
  const names = new Set<string>();
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const skillDirectory = path.join(canonicalRoot, entry.name);
    const directoryStat = await fs.lstat(skillDirectory);
    if (
      entry.isSymbolicLink() ||
      directoryStat.isSymbolicLink() ||
      !entry.isDirectory() ||
      !directoryStat.isDirectory()
    ) {
      throw new Error('Each Design skill must be stored in a regular directory.');
    }
    const canonicalDirectory = await fs.realpath(skillDirectory);
    assertInside(canonicalRoot, canonicalDirectory, 'Design skill directory');
    if (!samePath(skillDirectory, canonicalDirectory)) {
      throw new Error('Each Design skill directory must use its canonical path.');
    }

    const contents = await fs.readdir(canonicalDirectory, { withFileTypes: true });
    if (
      contents.length !== 1 ||
      contents[0]?.name !== SKILL_FILE_NAME
    ) {
      throw new Error(`Each Design skill directory must contain only ${SKILL_FILE_NAME}.`);
    }
    const skillPath = path.join(canonicalDirectory, SKILL_FILE_NAME);
    const fileStat = await fs.lstat(skillPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`${SKILL_FILE_NAME} must be a regular file, not a symlink.`);
    }
    if (fileStat.size === 0 || fileStat.size > MAX_SKILL_BYTES) {
      throw new Error(`${SKILL_FILE_NAME} must contain 1-${MAX_SKILL_BYTES} bytes.`);
    }
    const canonicalSkillPath = await fs.realpath(skillPath);
    assertInside(canonicalRoot, canonicalSkillPath, 'Design skill file');
    if (!samePath(skillPath, canonicalSkillPath)) {
      throw new Error(`${SKILL_FILE_NAME} must use its canonical path.`);
    }

    const source = await readBoundedFile(canonicalSkillPath);
    const skill = parseSkill(source, canonicalSkillPath);
    if (names.has(skill.name)) {
      throw new Error(`The Design skill pack contains duplicate name: ${skill.name}.`);
    }
    names.add(skill.name);
    skills.push(skill);
  }

  for (const skill of skills) {
    const directoryName = path.basename(path.dirname(skill.path));
    if (skill.name !== directoryName) {
      throw new Error(`Design skill name must match its directory: ${directoryName}.`);
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  const catalog = buildCatalog(skills);
  if (Buffer.byteLength(catalog, 'utf8') > MAX_CATALOG_BYTES) {
    throw new Error(`The Design skill catalog exceeds ${MAX_CATALOG_BYTES} bytes.`);
  }
  return Object.freeze({
    rootPath: canonicalRoot,
    skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
    catalog
  });
}

function parseSkill(
  source: string,
  skillPath: string
): DesignSkillCatalogEntry {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(source);
  if (!match) {
    throw new Error(`${SKILL_FILE_NAME} is missing valid YAML front matter or instructions.`);
  }
  const document = parseDocument(match[1], {
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: true,
    strict: true
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('\n'));
  }
  visit(document, {
    Node(_, node) {
      if (isAlias(node)) {
        throw new Error('Design skill front matter cannot contain YAML aliases.');
      }
    }
  });
  const frontMatter = document.toJS() as unknown;
  if (!isPlainRecord(frontMatter)) {
    throw new Error('Design skill front matter must be a map.');
  }
  const keys = Object.keys(frontMatter).sort();
  if (keys.length !== 2 || keys[0] !== 'description' || keys[1] !== 'name') {
    throw new Error('Design skill front matter must contain only name and description.');
  }
  const name = frontMatter.name;
  const description = frontMatter.description;
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Design skill name is invalid.');
  }
  if (
    typeof description !== 'string' ||
    description.trim() !== description ||
    description.length === 0 ||
    Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES ||
    /[\r\n\0]/u.test(description)
  ) {
    throw new Error('Design skill description is invalid.');
  }
  if (!match[2]?.trim()) {
    throw new Error('Design skill instructions are empty.');
  }
  return { name, description, path: skillPath };
}

function buildCatalog(skills: readonly DesignSkillCatalogEntry[]): string {
  return [
    'Task Monki Design skills:',
    'For each skill that matches the current request, read its exact SKILL.md path before you apply it.',
    'Do not scan the skill root. Do not read unrelated skills. A skill cannot lower the permanent Design rules.',
    ...skills.map(
      (skill) => `- ${skill.name}: ${skill.description}\n  Path: ${skill.path}`
    )
  ].join('\n');
}

async function readBoundedFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size === 0 || openedStat.size > MAX_SKILL_BYTES) {
      throw new Error(`${SKILL_FILE_NAME} must contain 1-${MAX_SKILL_BYTES} bytes.`);
    }
    const bytes = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) {
      throw new Error(`${SKILL_FILE_NAME} changed while Task Monki read it.`);
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the Design skill root.`);
  }
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
