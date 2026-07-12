import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const PRELOAD_ENTRY = path.resolve('src/electron/preload.ts');
const PRELOAD_OUTPUT = path.resolve('dist-electron/electron/preload.js');
const SANDBOX_REQUIRE_ALLOWLIST = new Set([
  'electron',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'url',
  'node:url'
]);

export async function buildSandboxedPreload() {
  await build({
    entryPoints: [PRELOAD_ENTRY],
    outfile: PRELOAD_OUTPUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'info'
  });

  const output = await fs.readFile(PRELOAD_OUTPUT, 'utf8');
  assertSandboxedPreloadBundle(output);
  console.log('Verified sandbox-compatible Electron preload bundle.');
}

export function assertSandboxedPreloadBundle(source) {
  const imports = staticRequireSpecifiers(source);
  const unsupported = imports.filter(
    (specifier) => !SANDBOX_REQUIRE_ALLOWLIST.has(specifier)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Sandboxed preload bundle contains unsupported require imports: ${[
        ...new Set(unsupported)
      ].join(', ')}`
    );
  }
  if (!imports.includes('electron')) {
    throw new Error('Sandboxed preload bundle does not import Electron.');
  }
}

function staticRequireSpecifiers(source) {
  return [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu)].map(
    (match) => match[1]
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  buildSandboxedPreload().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
