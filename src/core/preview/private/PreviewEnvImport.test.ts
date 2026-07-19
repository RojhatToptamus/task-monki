import { describe, expect, it } from 'vitest';
import { parseSelectedEnvValue } from './PreviewEnvImport';

describe('parseSelectedEnvValue', () => {
  it('materializes only the explicitly selected key', () => {
    const file = Buffer.from('OTHER=$DO_NOT_PARSE\nexport TOKEN="selected"\nTHIRD=`also-not-parsed`\n');
    expect(parseSelectedEnvValue(file, 'TOKEN')).toEqual({ status: 'VALUE', value: 'selected' });
  });
  it.each([
    ['BAD-KEY', 'INVALID_KEY'],
    ['MISSING', 'KEY_MISSING']
  ])('rejects %s safely', (key, status) => {
    expect(parseSelectedEnvValue(Buffer.from('TOKEN=value\n'), key)).toEqual({ status });
  });
  it('rejects duplicates and shell syntax', () => {
    expect(parseSelectedEnvValue(Buffer.from('TOKEN=a\nTOKEN=b'), 'TOKEN')).toEqual({ status: 'KEY_DUPLICATE' });
    expect(parseSelectedEnvValue(Buffer.from('TOKEN=$OTHER'), 'TOKEN')).toEqual({ status: 'INVALID_FILE' });
  });
  it('rejects invalid UTF-8 and oversized physical lines without throwing', () => {
    expect(parseSelectedEnvValue(Buffer.from([0x54, 0x4f, 0x4b, 0x45, 0x4e, 0x3d, 0xff]), 'TOKEN'))
      .toEqual({ status: 'INVALID_FILE' });
    expect(parseSelectedEnvValue(Buffer.from(`OTHER=${'x'.repeat(16 * 1024)}\nTOKEN=value`), 'TOKEN'))
      .toEqual({ status: 'INVALID_FILE' });
  });
});
