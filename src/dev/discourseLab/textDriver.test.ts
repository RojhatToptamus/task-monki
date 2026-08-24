import { describe, expect, it } from 'vitest';
import { ScriptedLabTextDriver, type LabTextCallInput } from './textDriver';

describe('ScriptedLabTextDriver output limits', () => {
  it('returns an explicit failure without exposing output beyond the hard token ceiling', async () => {
    const driver = new ScriptedLabTextDriver(() => 'abcdefghijklmnop');

    const result = await driver.call(callInput(2));
    await driver.close();

    expect(result.failure).toEqual(
      expect.objectContaining({ kind: 'TOKEN_LIMIT_EXCEEDED' })
    );
    expect(Buffer.byteLength(result.rawText, 'utf8')).toBeLessThanOrEqual(8);
    expect(result.usage?.last.outputTokens).toBeLessThanOrEqual(2);
    expect(result.lifecycle).toContainEqual(
      expect.objectContaining({ event: 'output-token-limit-reached' })
    );
  });

  it('accepts output exactly at the configured ceiling', async () => {
    const driver = new ScriptedLabTextDriver(() => 'abcdefgh');

    const result = await driver.call(callInput(2));
    await driver.close();

    expect(result.failure).toBeUndefined();
    expect(result.rawText).toBe('abcdefgh');
    expect(result.usage?.last.outputTokens).toBe(2);
  });

  it('copies the exact scripted checkpoint into an independent child', async () => {
    const driver = new ScriptedLabTextDriver((_input, index) => `output-${index}`);
    const source = await driver.call(callInput(100));
    const fork = await driver.fork({
      forkKey: 'test:fork',
      sourceSession: source.session!,
      model: 'scripted',
      reasoningEffort: 'none',
      maximumForkMs: 1_000,
      experimentDeadlineMs: Date.now() + 1_000
    });

    expect(fork.failure).toBeUndefined();
    expect(fork.inheritedProviderTurnIds).toEqual([source.providerTurnId]);
    expect(fork.session?.providerSessionTreeId).toBe(
      source.session?.providerSessionTreeId
    );
    expect(fork.session?.providerThreadId).not.toBe(
      source.session?.providerThreadId
    );

    const child = await driver.call({
      ...callInput(100),
      callKey: 'test:child',
      continuation: fork.session
    });
    expect(child.session).toEqual(fork.session);
    await driver.close();
  });
});

function callInput(maximumOutputTokens: number): LabTextCallInput {
  return {
    callKey: 'test:call',
    prompt: 'Return text.',
    outputSchema: {},
    model: 'scripted',
    reasoningEffort: 'none',
    seed: 17,
    maximumOutputTokens,
    maximumCallMs: 1_000,
    experimentDeadlineMs: Date.now() + 1_000
  };
}
