import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentBrowserRuntime,
  parseInspectDesignOperation
} from './AgentBrowserRuntime';

const roots: string[] = [];
const designId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('AgentBrowserRuntime', () => {
  it('uses current refs, returns transient screenshots, and removes owned scratch on close', async () => {
    const root = await fixtureRoot();
    const calls: string[][] = [];
    const environments: NodeJS.ProcessEnv[] = [];
    let snapshotCount = 0;
    const execute = vi.fn(async (
      _executable: string,
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv }
    ) => {
      calls.push(argv);
      if (options?.env) environments.push(options.env);
      if (argv[0] === '--version') {
        return { stdout: 'agent-browser 0.34.0\n', stderr: '' };
      }
      const command = argv[1];
      if (command === 'snapshot') {
        snapshotCount += 1;
        const ref = snapshotCount === 1 ? 'e1' : 'e2';
        return json(`button "Continue" [ref=${ref}]`);
      }
      if (command === 'screenshot') {
        const outputPath = argv.find((value) => value.endsWith('.png'));
        if (!outputPath) throw new Error('Missing screenshot path.');
        await fs.writeFile(outputPath, png);
        return json('captured');
      }
      return json(command === 'errors' || command === 'console' ? '(no output)' : 'ok');
    });
    const lease = { proxyUrl: 'http://127.0.0.1:42000', close: vi.fn(async () => {}) };
    const runtime = await runtimeFixture(root, execute);

    await expect(
      runtime.openCandidate({
        designId,
        runId,
        generationId: 'candidate-1',
        origin: 'http://tm-1234567890abcdef1234567890abcdef.localhost:41000/',
        lease
      })
    ).resolves.toMatchObject({ snapshot: expect.stringContaining('ref=e1') });
    expect(environments).toContainEqual(
      expect.objectContaining({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '3600000' })
    );
    const [ownedRoot] = await fs.readdir(path.join(root, 'scratch'));
    const policy = JSON.parse(
      await fs.readFile(path.join(root, 'scratch', ownedRoot!, 'action-policy.json'), 'utf8')
    ) as { allow: string[] };
    expect(policy.allow).toContain('launch');
    expect(policy.allow).toContain('emulatemedia');
    expect(policy.allow).not.toContain('set_media');

    await runtime.inspect(runId, { operation: 'act', action: 'click', ref: '@e1' });
    await expect(
      runtime.inspect(runId, { operation: 'act', action: 'click', ref: '@e1' })
    ).rejects.toThrow('current element reference');
    expect(calls.filter((argv) => argv[1] === 'click')).toHaveLength(1);

    const result = await runtime.inspect(runId, {
      operation: 'screenshot',
      ref: '@e2'
    });
    expect(result).toMatchObject({
      text: 'Screenshot captured at 1 by 1 pixels.',
      image: { mimeType: 'image/png', width: 1, height: 1 }
    });
    expect(result.image?.bytes).toEqual(png);
    const screenshotPath = calls
      .find((argv) => argv[1] === 'screenshot')
      ?.find((value) => value.endsWith('.png'));
    expect(screenshotPath).toBeDefined();
    await expect(fs.lstat(screenshotPath!)).rejects.toMatchObject({ code: 'ENOENT' });

    const [ownedSocketRoot] = await fs.readdir(path.join(root, 'sockets'));
    await runtime.closeRun(runId);
    expect(lease.close).toHaveBeenCalledOnce();
    await expect(fs.lstat(path.join(root, 'scratch', ownedRoot!))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(
      fs.lstat(path.join(root, 'sockets', ownedSocketRoot!))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails startup recovery when an owned browser cannot be closed', async () => {
    const root = await fixtureRoot();
    let rejectClose = false;
    const execute = vi.fn(async (_executable: string, argv: string[]) => {
      if (argv[0] === '--version') return { stdout: 'agent-browser 0.34.0\n', stderr: '' };
      if (argv[1] === 'close' && rejectClose) throw new Error('close failed');
      if (argv[1] === 'snapshot') return json('button [ref=e1]');
      return json('(no output)');
    });
    const runtime = await runtimeFixture(root, execute);
    await runtime.openCandidate({
      designId,
      runId,
      generationId: 'candidate-1',
      origin: 'http://tm-1234567890abcdef1234567890abcdef.localhost:41000/',
      lease: { proxyUrl: 'http://127.0.0.1:42000', async close() {} }
    });
    rejectClose = true;
    await expect(runtime.closeRun(runId)).rejects.toThrow('close failed');

    const recovered = await runtimeFixture(root, execute);
    await expect(recovered.recover()).rejects.toThrow(
      'Design browser startup cleanup is incomplete'
    );
    expect(await fs.readdir(path.join(root, 'scratch'))).toHaveLength(1);
  });

  it('accepts only the narrow inspect_design argument shapes', () => {
    expect(parseInspectDesignOperation({ operation: 'open_candidate' })).toEqual({
      operation: 'open_candidate'
    });
    expect(
      parseInspectDesignOperation({
        operation: 'act',
        action: 'hover',
        ref: '@e4'
      })
    ).toEqual({ operation: 'act', action: 'hover', ref: '@e4' });
    expect(() =>
      parseInspectDesignOperation({ operation: 'open_candidate', url: 'https://example.com' })
    ).toThrow('unsupported argument');
    expect(() =>
      parseInspectDesignOperation({ operation: 'act', action: 'evaluate', value: '1 + 1' })
    ).toThrow('not supported');
    expect(() =>
      parseInspectDesignOperation({ operation: 'screenshot', path: '/tmp/keep.png' })
    ).toThrow('unsupported argument');
    expect(() =>
      parseInspectDesignOperation({
        operation: 'set_media',
        colorScheme: 'no-preference'
      })
    ).toThrow('media values');
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-browser-'));
  roots.push(root);
  await Promise.all([
    executable(path.join(root, 'agent-browser')),
    executable(path.join(root, 'chrome'))
  ]);
  return root;
}

async function runtimeFixture(
  root: string,
  execute: (...args: Parameters<NonNullable<ConstructorParameters<typeof AgentBrowserRuntime>[0]['execute']>>) => Promise<{ stdout: string; stderr: string }>
): Promise<AgentBrowserRuntime> {
  const runtime = new AgentBrowserRuntime({
    executablePath: path.join(root, 'agent-browser'),
    browserExecutablePath: path.join(root, 'chrome'),
    scratchRoot: path.join(root, 'scratch'),
    socketRoot: path.join(root, 'sockets'),
    execute,
    async attestResources() {}
  });
  await runtime.attest();
  return runtime;
}

async function executable(filePath: string): Promise<void> {
  await fs.writeFile(filePath, '#!/bin/sh\n', { mode: 0o700 });
}

function json(data: string): { stdout: string; stderr: string } {
  return { stdout: `${JSON.stringify({ success: true, data })}\n`, stderr: '' };
}
