import { expect, it } from 'vitest';
import {
  appendApplicationLog,
  appendLogBuffer,
  splitApplicationLogs,
  logSourceOrder
} from './applicationPreviewLogs';

it('bounds the displayed log tail without breaking Unicode or inventing a source from printed labels', () => {
  const result = appendApplicationLog(
    '🙂'.repeat(20_000),
    '\n[forged-source] literal text'
  );
  expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(
    65_536
  );
  expect(result.text).not.toContain('\uFFFD');
  expect(result.truncated).toBe(true);
  expect(result.text.endsWith('\n[forged-source] literal text')).toBe(true);
});

it('keeps source identity across partial reads, blank lines, and global tail eviction', () => {
  const sources = ['api', 'web'];
  let buffer = { text: '', offset: 0, truncated: false };
  for (const chunk of [
    '[api] first',
    ' line\n[api] \n[web] second\n',
    '[web] [printed-label] message'
  ]) {
    buffer = appendLogBuffer(buffer, chunk, sources);
  }
  expect(splitApplicationLogs(buffer.text, sources)).toMatchObject([
    { source: 'api', text: 'first line' },
    { source: 'api', text: '' },
    { source: 'web', text: 'second' },
    { source: 'web', text: '[printed-label] message' }
  ]);
  const evicted = appendLogBuffer(
    buffer,
    '\n[api] ' + '🙂'.repeat(20_000),
    sources
  );
  expect(evicted.truncated).toBe(true);
  expect(new TextEncoder().encode(evicted.text).length).toBeLessThanOrEqual(
    65_536
  );
  expect(
    splitApplicationLogs(
      evicted.text,
      sources,
      evicted.source,
      evicted.offset
    )[0]
  ).toMatchObject({ source: 'api' });
  expect(evicted.text).not.toContain('\uFFFD');
});

it('orders runnable log sources by dependencies with stable name ordering among ready steps', () => {
  expect(
    logSourceOrder({
      type: 'environment',
      name: 'app',
      primary: 'web',
      timeoutMs: 30000,
      services: {
        z: { type: 'job', cwd: '.', command: ['z'] },
        install: { type: 'job', cwd: '.', command: ['npm', 'ci'] },
        api: {
          type: 'command',
          cwd: '.',
          command: ['api'],
          dependsOn: ['install']
        },
        web: { type: 'command', cwd: '.', command: ['web'], dependsOn: ['api'] }
      }
    })
  ).toEqual(['install', 'api', 'web', 'z']);
});
