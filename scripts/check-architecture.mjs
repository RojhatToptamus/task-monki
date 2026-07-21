import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs'];
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|mts|mjs)$/u;
const GENERATED_SOURCE_SEGMENTS = [
  '/src/core/agent/codex/protocol/generated/',
  '/src/shared/codex-protocol/'
];

const LAYER_RULES = [
  {
    prefix: 'src/shared/',
    allowed: ['src/shared/'],
    detail: 'shared contracts cannot depend on application or renderer code'
  },
  {
    prefix: 'src/core/',
    allowed: ['src/core/', 'src/shared/'],
    detail: 'core cannot depend on renderer, Electron, or development hosts'
  },
  {
    prefix: 'src/renderer/model/',
    allowed: ['src/renderer/model/', 'src/shared/'],
    detail: 'renderer models must stay independent of UI and transport adapters'
  },
  {
    prefix: 'src/renderer/api/',
    allowed: ['src/renderer/api/', 'src/shared/'],
    detail: 'renderer transport adapters must stay independent of UI and view models'
  },
  {
    prefix: 'src/renderer/ui/',
    allowed: [
      'src/renderer/ui/',
      'src/renderer/model/',
      'src/renderer/api/',
      'src/shared/'
    ],
    detail: 'renderer UI cannot reach into core, Electron, or development hosts'
  },
  {
    prefix: 'src/dev/',
    allowed: ['src/dev/', 'src/core/', 'src/shared/'],
    detail: 'development hosts may compose core but cannot depend on renderer or Electron'
  },
  {
    prefix: 'src/electron/',
    allowed: ['src/electron/', 'src/core/', 'src/shared/'],
    detail: 'Electron hosts may compose core but cannot depend on renderer or development hosts'
  }
];

export async function collectProductionGraph(rootDir) {
  const sourceRoot = path.join(rootDir, 'src');
  const files = (await walkFiles(sourceRoot))
    .filter(isProductionSourceFile)
    .sort();
  const fileSet = new Set(files);
  const graph = new Map();

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const dependencies = new Set();
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveSourceImport(file, specifier, fileSet);
      if (resolved) dependencies.add(resolved);
    }
    graph.set(file, [...dependencies].sort());
  }

  return graph;
}

export function validateBoundaries(rootDir, graph) {
  const violations = [];
  for (const [source, dependencies] of graph) {
    const sourcePath = relativePath(rootDir, source);
    const rule = LAYER_RULES.find((candidate) => sourcePath.startsWith(candidate.prefix));
    const sourceProvider = agentProvider(sourcePath);
    if (!rule) continue;
    for (const dependency of dependencies) {
      const dependencyPath = relativePath(rootDir, dependency);
      if (dependencyPath.startsWith('src/testSupport/')) {
        violations.push({
          source: sourcePath,
          dependency: dependencyPath,
          detail: 'production code cannot depend on test support'
        });
        continue;
      }
      const dependencyProvider = agentProvider(dependencyPath);
      if (
        sourceProvider &&
        dependencyProvider &&
        sourceProvider !== dependencyProvider
      ) {
        violations.push({
          source: sourcePath,
          dependency: dependencyPath,
          detail: 'provider adapters cannot depend on another provider implementation'
        });
        continue;
      }
      if (!rule.allowed.some((prefix) => dependencyPath.startsWith(prefix))) {
        violations.push({
          source: sourcePath,
          dependency: dependencyPath,
          detail: rule.detail
        });
      }
    }
  }
  return violations.sort(compareViolations);
}

function agentProvider(file) {
  return /^src\/core\/agent\/(codex|acp|opencode)\//u.exec(file)?.[1];
}

export function findCycles(rootDir, graph) {
  const indexByFile = new Map();
  const lowLinkByFile = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let index = 0;

  const visit = (file) => {
    indexByFile.set(file, index);
    lowLinkByFile.set(file, index);
    index += 1;
    stack.push(file);
    onStack.add(file);

    for (const dependency of graph.get(file) ?? []) {
      if (!graph.has(dependency)) continue;
      if (!indexByFile.has(dependency)) {
        visit(dependency);
        lowLinkByFile.set(
          file,
          Math.min(lowLinkByFile.get(file), lowLinkByFile.get(dependency))
        );
      } else if (onStack.has(dependency)) {
        lowLinkByFile.set(
          file,
          Math.min(lowLinkByFile.get(file), indexByFile.get(dependency))
        );
      }
    }

    if (lowLinkByFile.get(file) !== indexByFile.get(file)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== file);

    const selfCycle =
      component.length === 1 && (graph.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfCycle) {
      cycles.push(component.map((entry) => relativePath(rootDir, entry)).sort());
    }
  };

  for (const file of [...graph.keys()].sort()) {
    if (!indexByFile.has(file)) visit(file);
  }
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
}

export async function checkArchitecture(rootDir) {
  const graph = await collectProductionGraph(rootDir);
  return {
    productionFileCount: graph.size,
    boundaryViolations: validateBoundaries(rootDir, graph),
    cycles: findCycles(rootDir, graph)
  };
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveSourceImport(sourceFile, specifier, fileSet) {
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

async function walkFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
    })
  );
  return nested.flat();
}

function isProductionSourceFile(file) {
  const normalized = file.split(path.sep).join('/');
  return (
    SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension)) &&
    !TEST_FILE_PATTERN.test(normalized) &&
    !GENERATED_SOURCE_SEGMENTS.some((segment) => normalized.includes(segment))
  );
}

function relativePath(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

function compareViolations(left, right) {
  return (
    left.source.localeCompare(right.source) ||
    left.dependency.localeCompare(right.dependency)
  );
}

async function main() {
  const rootDir = process.cwd();
  const result = await checkArchitecture(rootDir);
  if (result.boundaryViolations.length === 0 && result.cycles.length === 0) {
    console.log(
      `Architecture check passed for ${result.productionFileCount} production source files.`
    );
    return;
  }

  if (result.boundaryViolations.length > 0) {
    console.error('Architecture boundary violations:');
    for (const violation of result.boundaryViolations) {
      console.error(
        `- ${violation.source} -> ${violation.dependency}: ${violation.detail}`
      );
    }
  }
  if (result.cycles.length > 0) {
    console.error('Production dependency cycles:');
    for (const cycle of result.cycles) console.error(`- ${cycle.join(' <-> ')}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
