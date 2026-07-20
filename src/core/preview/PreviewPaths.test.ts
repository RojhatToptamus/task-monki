import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalProspectivePath, isPathWithin } from './PreviewPaths';

describe('PreviewPaths', () => {
  it('canonicalizes a missing path through its nearest existing ancestor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-paths-'));
    const aliasRoot = root.startsWith('/private/var/') ? root.replace(/^\/private/, '') : root;
    const candidate = path.join(aliasRoot, 'missing', 'child');
    const canonical = await canonicalProspectivePath(candidate);
    expect(canonical).toBe(path.join(await fs.realpath(root), 'missing', 'child'));
  });

  it('does not treat prefix siblings as contained paths', () => {
    expect(isPathWithin('/tmp/preview', '/tmp/preview/generation')).toBe(true);
    expect(isPathWithin('/tmp/preview', '/tmp/preview-other')).toBe(false);
  });
});
