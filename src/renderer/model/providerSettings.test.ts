import { describe, expect, it } from 'vitest';
import { compareProviderSetting } from './providerSettings';

describe('provider setting comparison', () => {
  it('marks equal requested and observed settings as matches', () => {
    expect(compareProviderSetting('high', 'high')).toBe('match');
    expect(compareProviderSetting(false, false)).toBe('match');
  });

  it('marks provider-filled values as defaults when Task Monki did not request one', () => {
    expect(compareProviderSetting(undefined, 'default')).toBe('provider-default');
    expect(compareProviderSetting(undefined, 'openai')).toBe('provider-default');
  });

  it('marks requested values that differ from provider observations as mismatches', () => {
    expect(compareProviderSetting('high', 'xhigh')).toBe('mismatch');
    expect(compareProviderSetting('workspace-write', 'read-only')).toBe('mismatch');
  });

  it('marks missing provider observations separately from mismatches', () => {
    expect(compareProviderSetting('high', undefined)).toBe('not-observed');
  });
});
