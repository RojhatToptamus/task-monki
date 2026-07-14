import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import {
  isCompatibleOpenCodeVersion,
  resolveOpenCodeRuntime
} from './OpenCodeRuntimeResolver';

describe('OpenCodeRuntimeResolver', () => {
  it('enforces the explicitly supported native protocol version range', () => {
    expect(isCompatibleOpenCodeVersion('1.4.0')).toBe(true);
    expect(isCompatibleOpenCodeVersion('1.17.18')).toBe(true);
    expect(isCompatibleOpenCodeVersion('1.3.9')).toBe(false);
    expect(isCompatibleOpenCodeVersion('2.0.0')).toBe(false);
  });

  it('probes the executable version and required headless server flags', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-opencode-resolver-'));
    const executable = await writeNodeExecutable(
      directory,
      'opencode',
      [
        'if (process.argv.includes("--version")) { console.log("1.17.18"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("opencode serve --hostname HOST --port PORT"); process.exit(0); }',
        'process.exit(2);'
      ].join('\n')
    );

    const resolved = await resolveOpenCodeRuntime({ executable, cwd: directory });

    expect(resolved).toEqual(
      expect.objectContaining({ executable, version: '1.17.18', source: 'config' })
    );
    expect(resolved.diagnostics.requiredCapabilities).toContain('GET /event (SSE)');
    expect(resolved.diagnostics.requiredCapabilities).toContain('POST /session/{id}/fork');
  });
});
