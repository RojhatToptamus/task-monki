import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  PreviewDescription,
  PreviewRuntime,
  PreviewStatus
} from 'previewhost';
import { diagnosePreviewFailure } from './ApplicationPreviewDiagnosis';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function diagnosis(
  message: string,
  code: string,
  logs = '',
  description?: PreviewDescription
) {
  const runtime = {
    logs: async () => ({ text: logs, cursor: logs.length, truncated: false }),
    describe: async () =>
      description ?? {
        spec: {
          name: 'app',
          type: 'command',
          cwd: '/project',
          command: ['python', 'server.py'],
          readyPath: '/',
          timeoutMs: 1000
        }
      }
  } as unknown as PreviewRuntime;
  const status = {
    name: 'app',
    busy: false,
    latest: {
      id: 'failed',
      type: 'command',
      state: 'failed',
      startedAt: '2026-10-08T12:00:00Z',
      sources: [],
      error: { code, message }
    }
  } as PreviewStatus;
  return diagnosePreviewFailure(runtime, 'app', status);
}

it('distinguishes project dependency installation from a missing global executable', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-diagnosis-'));
  roots.push(cwd);
  await fs.writeFile(path.join(cwd, 'package.json'), '{}');
  await fs.writeFile(path.join(cwd, 'package-lock.json'), '{}');
  const result = await diagnosis(
    'spawn ./node_modules/.bin/next ENOENT',
    'START_FAILED',
    '',
    {
      spec: {
        name: 'app',
        type: 'command',
        cwd,
        command: ['./node_modules/.bin/next', 'dev'],
        readyPath: '/',
        timeoutMs: 1000
      }
    } as PreviewDescription
  );
  expect(result?.action).toBe('install');
  expect((await diagnosis('spawn python ENOENT', 'START_FAILED'))?.action).toBe(
    'agent'
  );
});

it('keeps probe evidence distinct from an application error and an unavailable Docker engine', async () => {
  expect(
    (
      await diagnosis(
        'Readiness timed out: last response 404 at /ready',
        'TIMEOUT'
      )
    )?.action
  ).toBe('readiness');
  expect(
    (await diagnosis('Readiness timed out: last response 503', 'TIMEOUT'))
      ?.action
  ).toBe('agent');
  expect(
    (await diagnosis('Readiness timed out: connection refused', 'TIMEOUT'))
      ?.observed
  ).toContain('connection refused');
  expect(
    (
      await diagnosis(
        'Readiness timed out: last response 503',
        'TIMEOUT',
        'TypeError: application setup failed'
      )
    )?.action
  ).toBe('task-agent');
  expect(
    (await diagnosis('Cannot connect to Docker daemon', 'START_FAILED'))?.action
  ).toBe('docker');
  expect(
    (await diagnosis('No such image: postgres:17', 'START_FAILED'))?.command
  ).toBe('docker pull postgres:17');
});

it('names the exit code it saw and quotes the error line instead of the runtime summary', async () => {
  const exited = await diagnosis(
    'Job exited (1). Database writes are not rolled back.',
    'START_FAILED',
    [
      'applying 0003_add_tags.sql',
      'Error: relation "notes" does not exist',
      '    at Migrator.apply (/project/src/migrate.ts:48:11)',
      'Job exited (1). Database writes are not rolled back.'
    ].join('\n'),
    {
      spec: {
        name: 'app',
        type: 'environment',
        primary: 'web',
        timeoutMs: 1000,
        services: {
          migrate: { type: 'job', cwd: '/project', command: ['node', 'migrate.js'] },
          web: { type: 'command', cwd: '/project', command: ['node', 'server.js'], readyPath: '/', timeoutMs: 1000 }
        }
      }
    } as unknown as PreviewDescription
  );
  expect(exited?.title).toBe('Application exited with code 1');
  expect(exited?.summary).toBe('Nothing is serving.');
  expect(exited?.excerpt).toBe(
    'Error: relation "notes" does not exist\n    at Migrator.apply (/project/src/migrate.ts:48:11)'
  );
  const never = await diagnosis('Native command could not start (ENOENT)', 'START_FAILED');
  expect(never?.title).toBe('The configured command could not be found');
  expect(never?.excerpt).toBeUndefined();
  const timeout = await diagnosis('Readiness probe timed out after 30000 ms.', 'TIMEOUT');
  expect(timeout?.title).toBe('Application did not become ready in time');
});
