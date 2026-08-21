import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildH1bSourceLock } from './h1bSourceLock';

describe('H1b executable source lock', () => {
  it('follows the Codex driver into the core process, RPC, permission, and workspace boundary', async () => {
    const lock = await buildH1bSourceLock(process.cwd(), [
      'src/dev/discourseLab/CodexTextDriver.ts'
    ]);
    expect(lock.sourceFiles).toEqual(expect.arrayContaining([
      'src/dev/discourseLab/CodexTextDriver.ts',
      'src/core/agent/codex/CodexAppServerSupervisor.ts',
      'src/core/agent/codex/CodexRpcClient.ts',
      'src/core/agent/codex/CodexPermissionProfile.ts',
      'src/core/discourse/DiscourseWorkspace.ts'
    ]));
    expect(lock.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lock.sourceFiles.every((file) => path.extname(file) === '.ts')).toBe(true);
  });
});
