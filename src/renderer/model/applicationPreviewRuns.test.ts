import { expect, it } from 'vitest';
import type { AttemptSummary, PreviewStatus } from 'previewhost';
import { hostAndPort, previewRunRows, runTime, serviceOutcome } from './applicationPreviewRuns';

const now = new Date('2026-10-09T14:40:00');
const attempt = (overrides: Partial<AttemptSummary>): AttemptSummary => ({
  id: 'a', type: 'environment', state: 'stopped', startedAt: '2026-10-09T14:01:00', sources: [], ...overrides
});

it('names runs by outcome and cause, newest first, without attempt ids', () => {
  const status: PreviewStatus = {
    name: 'app', busy: false, url: 'http://127.0.0.1:60300',
    active: attempt({ id: 'serving', state: 'ready', readyAt: '2026-10-09T14:01:21' }),
    latest: attempt({ id: 'update', state: 'failed', startedAt: '2026-10-09T14:31:00', services: { migrate: { type: 'job', state: 'failed', error: { code: 'START_FAILED', message: 'migrate exited with code 1' } as never } } }),
    history: [
      attempt({ id: 'early', state: 'failed', startedAt: '2026-10-09T13:58:00', error: { code: 'START_FAILED', message: 'web could not start' } as never }),
      attempt({ id: 'old', state: 'stopped', startedAt: '2026-10-08T22:19:00' })
    ]
  };
  const rows = previewRunRows(status, false, now);
  expect(rows.map((row) => [row.time, row.outcome, row.cause])).toEqual([
    [runTime('2026-10-09T14:31:00', now), 'Update failed', 'migrate exited with code 1'],
    [runTime('2026-10-09T14:01:00', now), 'Current run · ready in 21 s · serving', undefined],
    [runTime('2026-10-09T13:58:00', now), 'Failed', 'web could not start'],
    [`Yesterday ${runTime('2026-10-08T22:19:00', new Date('2026-10-08T23:00:00'))}`, 'Stopped', undefined]
  ]);
  expect(JSON.stringify(rows)).not.toContain('"outcome":"serving"');
});

it('marks a run restored after a runtime restart as expired instead of offering its logs', () => {
  const rows = previewRunRows({ name: 'app', busy: false, latest: attempt({}) }, true, now);
  expect(rows[0]).toMatchObject({ outcome: 'Stopped when Task Monki quit', cause: 'logs expired', logsAvailable: false });
});

it('keeps the clock for today and adds the day for older runs', () => {
  expect(runTime('2026-10-09T09:05:00', now)).not.toContain('Yesterday');
  expect(runTime('2026-10-08T09:05:00', now)).toMatch(/^Yesterday /);
  expect(runTime('2026-10-01T09:05:00', now)).toMatch(/^Oct 1 /);
  expect(runTime('nonsense', now)).toBe('');
});

it('words a service state with the fact that decided it', () => {
  expect(serviceOutcome({ type: 'job', state: 'failed', error: { code: 'START_FAILED', message: 'migrate exited with code 1' } as never })).toEqual({ word: 'Failed', detail: 'exit 1' });
  expect(serviceOutcome({ type: 'command', state: 'failed', error: { code: 'TIMEOUT', message: 'web did not become ready in time' } as never })).toEqual({ word: 'Failed', detail: 'not ready in time' });
  expect(serviceOutcome({ type: 'command', state: 'waiting', waitingFor: ['install', 'api'] })).toEqual({ word: 'Waiting', detail: 'after install, api' });
  expect(serviceOutcome({ type: 'job', state: 'starting' })).toEqual({ word: 'Running' });
  expect(serviceOutcome({ type: 'job', state: 'skipped' })).toEqual({ word: 'Not started' });
  expect(hostAndPort('http://tm-6ef76297-2457-4e2a-a3ad-a6d0cb1f2e3d--api.localhost:60300/health')).toBe('api.localhost:60300');
  expect(hostAndPort('http://127.0.0.1:61280/')).toBe('127.0.0.1:61280');
  expect(hostAndPort('not a url')).toBe('not a url');
});
