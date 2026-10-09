import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
