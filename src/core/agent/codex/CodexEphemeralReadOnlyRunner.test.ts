import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexEphemeralRunError,
  startCodexEphemeralReadOnlyRun
} from './CodexEphemeralReadOnlyRunner';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('CodexEphemeralReadOnlyRunner', () => {
  it('does not reject a timeout until the child process has been stopped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ephemeral-runner-'));
    roots.push(root);
    const executable = path.join(root, 'fake-codex.mjs');
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('mcp')) {
  process.stdout.write('[]');
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'run.pid'), String(process.pid));
setInterval(() => {}, 1000);
`,
      { encoding: 'utf8', mode: 0o700 }
    );

    const run = await startCodexEphemeralReadOnlyRun({
      cwd: root,
      instruction: 'generate',
      model: 'test-model',
      reasoningEffort: 'low',
      timeoutMs: 30,
      codexExecutable: executable,
      toolSettings: { webSearchMode: 'disabled', mcpServers: 'disabled', apps: 'disabled' },
      failClosedMcpDiscovery: true
    });

    await expect(run.result).rejects.toMatchObject({
      code: 'TIMED_OUT'
    } satisfies Partial<CodexEphemeralRunError>);
    const pid = Number(await fs.readFile(path.join(root, 'run.pid'), 'utf8'));
    expect(processExists(pid)).toBe(false);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
