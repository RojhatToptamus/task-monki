import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import { resolveOpenCodeRuntime } from './OpenCodeRuntimeResolver';

describe('OpenCodeRuntimeResolver', () => {
  it('accepts the discovered OpenCode serve contract without a version allowlist', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-opencode-resolver-'));
    const executable = await writeNodeExecutable(
      directory,
      'opencode',
      [
        'if (process.env.CODEX_HOME !== undefined) process.exit(12);',
        'if (process.argv.length === 3 && process.argv.includes("--version")) { console.error("2.0.0"); process.exit(0); }',
        'if (process.argv.includes("--help")) {',
        '  console.error(`opencode serve',
        '',
        'starts a headless opencode server',
        '',
        'Options:',
        '  -h, --help       show help',
        '      --port       port to listen on [number] [default: 0]',
        '      --hostname   hostname to listen on [string] [default: "127.0.0.1"]`);',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\n')
    );

    const resolved = await resolveOpenCodeRuntime({
      executable,
      cwd: directory,
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: '/must-not-pass/codex-home'
      }
    });

    expect(resolved).toEqual(
      expect.objectContaining({ executable, version: '2.0.0', source: 'config' })
    );
    expect(resolved.diagnostics.selectedLaunchArgv).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '<allocated-loopback-port>'
    ]);
    expect(resolved.diagnostics.requiredCapabilities).toContain('GET /event (SSE)');
    expect(resolved.diagnostics.requiredCapabilities).toContain('POST /session/{id}/fork');
    expect(resolved.diagnostics.requiredCapabilities).toContain('DELETE /session/{id}');
  });
});
