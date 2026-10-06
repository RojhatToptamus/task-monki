import { expect,it } from 'vitest';
import { appendApplicationLog } from './applicationPreviewLogs';

it('bounds the displayed log tail without breaking Unicode or inventing a source from printed labels', () => {
  const result = appendApplicationLog('🙂'.repeat(20_000), '\n[forged-source] literal text');
  expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(65_536);
  expect(result.text).not.toContain('\uFFFD');
  expect(result.truncated).toBe(true);
  expect(result.text.endsWith('\n[forged-source] literal text')).toBe(true);
});
