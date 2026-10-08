import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';

/** Reviewed file bytes are compared before every replacement. */
export interface PreviewRecipeFile {
  name: 'preview.yaml' | 'preview.yml';
  text: string;
}

export async function readPreviewRecipeFiles(
  root: string
): Promise<PreviewRecipeFile[]> {
  const found: PreviewRecipeFile[] = [];
  for (const name of ['preview.yaml', 'preview.yml'] as const) {
    let handle;
    try {
      if (!(await fs.lstat(path.join(root, name))).isFile())
        throw new Error(
          'Preview configuration must be a regular file, not a link.'
        );
      handle = await fs.open(
        path.join(root, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65_536)
        throw new Error(
          'Preview configuration must be a regular file of at most 64 KiB.'
        );
      const bytes = Buffer.alloc(65_537);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead
        );
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 65_536)
        throw new Error('Preview configuration exceeds 64 KiB.');
      found.push({ name, text: bytes.subarray(0, bytesRead).toString('utf8') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      await handle?.close();
    }
  }
  return found;
}

export async function readPreviewRecipeFile(
  root: string
): Promise<PreviewRecipeFile | undefined> {
  const files = await readPreviewRecipeFiles(root);
  if (files.length > 1)
    throw new Error(
      'Both preview.yaml and preview.yml exist. Compare them and choose one configuration.'
    );
  return files[0];
}

/** Explicit save compares the reviewed source and publishes the complete replacement. */
export async function writeReviewedPreviewRecipe(
  root: string,
  yaml: string,
  original?: PreviewRecipeFile
): Promise<PreviewRecipeFile['name']> {
  const assertUnchanged = async () => {
    const current = await readPreviewRecipeFile(root);
    if (current?.name !== original?.name || current?.text !== original?.text) {
      throw new Error(
        'Preview configuration changed or already exists. Reload and review the changes before replacing it.'
      );
    }
  };
  await assertUnchanged();
  const name = original?.name ?? 'preview.yaml';
  const destination = path.join(root, name);
  const mode = original ? (await fs.stat(destination)).mode & 0o777 : 0o600;
  const temporary = path.join(root, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(yaml);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertUnchanged();
    if (original) await fs.rename(temporary, destination);
    else await fs.link(temporary, destination); // Exclusive publication: a concurrently created file wins.
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return name;
}

/** Runtime logs are already vault-redacted. Also conceal YAML literals and credential-shaped diagnostics. */
export function safePreviewContext(
  file?: PreviewRecipeFile,
  diagnostics?: unknown,
  publicPrefixes: readonly string[] = []
) {
  // These keys have documented, non-secret runtime semantics. Value shape alone
  // never establishes that an arbitrary environment binding is safe to disclose.
  const switches = new Set([
    'NODE_ENV',
    'NEXT_TELEMETRY_DISABLED',
    'LOG_LEVEL',
    'CI'
  ]);
  const conceal = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(conceal);
    if (!value || typeof value !== 'object') return scrub(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key === 'env' && entry && typeof entry === 'object') {
          return [
            key,
            Object.fromEntries(
              Object.entries(entry).map(([name, binding]) => {
                if (typeof binding !== 'string')
                  return [name, conceal(binding)];
                if (
                  switches.has(name) &&
                  /^(?:true|false|[0-9]{1,4}|development|production|test|debug|info|warn|error|silent)$/i.test(
                    binding
                  )
                )
                  return [name, binding];
                // The evidenced framework publishes these values to browsers.
                if (publicPrefixes.some((prefix) => name.startsWith(prefix)))
                  return [name, binding];
                return [
                  name,
                  '[concealed literal; confirm value or secret reference]'
                ];
              })
            )
          ];
        }
        if (
          key === 'name' &&
          typeof entry === 'string' &&
          /^tm-[0-9a-f-]{36}$/i.test(entry)
        )
          return [key, 'application'];
        return [key, conceal(entry)];
      })
    );
  };
  let configuration: unknown;
  if (file) {
    try {
      const document = parseDocument(file.text);
      if (document.errors.length) throw new Error('Invalid YAML');
      configuration = document.toJS({ maxAliasCount: 0 });
      configuration = conceal(configuration);
    } catch {
      configuration =
        'The existing YAML could not be safely parsed. Its raw contents are withheld.';
    }
  }
  function scrub(value: unknown): unknown {
    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((line) =>
          /(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|authorization)\s*["']?\s*[:=]\s*(?!\{secret:)|-----BEGIN .*PRIVATE KEY|\b(?:gh[opusr]_|sk-(?:proj-)?)[A-Za-z0-9_-]{20,}|[a-z]+:\/\/[^\s/]+:[^\s/]+@/i.test(
            line
          )
            ? '[credential-like diagnostic withheld]'
            : line
        )
        .join('\n');
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, scrub(entry)])
      );
    return value;
  }
  // Runtime output is already redacted. Recorded file literals may belong to a
  // different attempt and must never be used to rewrite its diagnostic output.
  const safeDiagnostics = conceal(diagnostics);
  return {
    file: file?.name,
    configuration,
    diagnostics: scrub(safeDiagnostics)
  };
}
