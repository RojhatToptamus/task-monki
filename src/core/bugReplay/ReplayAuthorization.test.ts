import { parsePreviewSpec, type AuthorizationRequest, type PreviewRuntime, type PreviewSpec } from 'previewhost';
import { describe, expect, it, vi } from 'vitest';
import { REPLAY_LEASE_STARTS, ReplayAuthorization } from './ReplayAuthorization';

/**
 * Previewhost asks before every operation on a `br-` name. Only a start Task Monki registered,
 * with exactly the spec it derived, under a current lease, may run; nothing else about replay
 * names is approved, and every other name is left to its own approval path.
 */

const TASK = 'task-1';
const DIGEST = 'a'.repeat(64);

function replaySpec(name: string, env: Record<string, unknown> = {}, command = ['node', 'server.js']): PreviewSpec {
  return {
    name,
    type: 'environment',
    primary: 'web',
    services: { web: { type: 'command', cwd: '/exports/run-1/source', command, env } }
  } as PreviewSpec;
}

function nameOf(index: number): string {
  return `br-${index.toString(16).padStart(12, '0')}`;
}

function harness() {
  const approve = vi.fn(async () => undefined);
  const prepareSecretSetup = vi.fn(async () => ({ approve }));
  const authorization = new ReplayAuthorization(() => ({ prepareSecretSetup }) as unknown as PreviewRuntime);
  const signal = new AbortController().signal;
  /** Previewhost's request to start `spec`, as it hands it to the callback: parsed. */
  const start = (spec: PreviewSpec) => authorization.authorize({ operation: 'start', spec: parsePreviewSpec(spec), signal } as AuthorizationRequest);
  /** Task Monki registers the start of `name`, then Previewhost asks for it. */
  const expectedStart = (name: string, spec = replaySpec(name), secretIds: string[] = []) => {
    authorization.expectStart(name, { taskId: TASK, approvalDigest: DIGEST, spec, secretIds });
    return start(spec);
  };
  return { authorization, start, expectedStart, signal, prepareSecretSetup, approve };
}

describe('Who may start a clean copy', () => {
  it('refuses a replay start Task Monki did not register, even under a lease', async () => {
    const { authorization, start } = harness();
    authorization.grant(TASK, DIGEST);

    expect(await start(replaySpec(nameOf(1)))).toBe(false);
  });

  it('refuses a start whose spec differs from the one Task Monki derived, and never accepts that name again', async () => {
    const { authorization, start } = harness();
    authorization.grant(TASK, DIGEST);
    const name = nameOf(1);
    const derived = replaySpec(name);
    authorization.expectStart(name, { taskId: TASK, approvalDigest: DIGEST, spec: derived, secretIds: [] });

    expect(await start(replaySpec(name, {}, ['node', 'server.js', '--inspect=0.0.0.0:9229']))).toBe(false);
    // The registration was for one start, and that start was refused.
    expect(await start(derived)).toBe(false);
  });

  it('refuses a start that reads a secret the derived spec did not declare, and approves the secrets it did', async () => {
    const { authorization, expectedStart, prepareSecretSetup, approve } = harness();
    authorization.grant(TASK, DIGEST);
    const env = { DB_PASSWORD: { secret: 'shop-db-password' } };

    expect(await expectedStart(nameOf(1), replaySpec(nameOf(1), env), [])).toBe(false);
    expect(prepareSecretSetup).not.toHaveBeenCalled();

    expect(await expectedStart(nameOf(2), replaySpec(nameOf(2), env), ['shop-db-password'])).toBe(true);
    expect(prepareSecretSetup).toHaveBeenCalledWith(parsePreviewSpec(replaySpec(nameOf(2), env)), expect.anything());
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('never replaces a replay or opens its secret setup', async () => {
    const { authorization, signal } = harness();
    authorization.grant(TASK, DIGEST);
    const name = nameOf(1);
    authorization.expectStart(name, { taskId: TASK, approvalDigest: DIGEST, spec: replaySpec(name), secretIds: [] });
    const spec = parsePreviewSpec(replaySpec(name));

    expect(await authorization.authorize({ operation: 'replace', spec, signal } as AuthorizationRequest)).toBe(false);
    expect(await authorization.authorize({ operation: 'secrets-setup', mode: 'missing', ids: ['shop-db-password'], spec, signal } as AuthorizationRequest)).toBe(false);
  });

  it('deletes and recovers data only under names Task Monki owns', async () => {
    const { authorization, signal } = harness();
    const owned = nameOf(1);
    authorization.own(owned);
    const data = (operation: 'delete-data' | 'recover-data', name: string) =>
      authorization.authorize({ operation, name, resources: [], signal } as unknown as AuthorizationRequest);

    expect(await data('delete-data', owned)).toBe(true);
    expect(await data('recover-data', owned)).toBe(true);
    expect(await data('delete-data', nameOf(2))).toBe(false);

    authorization.disown(owned);
    expect(await data('delete-data', owned)).toBe(false);
  });

  it('leaves every other name to its own approval', async () => {
    const { authorization, start, signal } = harness();
    authorization.grant(TASK, DIGEST);

    expect(await start(replaySpec('checkout'))).toBeUndefined();
    expect(await authorization.authorize({ operation: 'delete-data', name: 'checkout', resources: [], signal } as unknown as AuthorizationRequest)).toBeUndefined();
    expect(await authorization.authorize({ operation: 'allow-sources', directories: ['/work/shop'], signal } as AuthorizationRequest)).toBeUndefined();
  });
});

describe('How long an approval lasts', () => {
  it('lets an approval for now start a bounded number of clean copies', async () => {
    const { authorization, expectedStart } = harness();
    authorization.grant(TASK, DIGEST);

    for (let index = 0; index < REPLAY_LEASE_STARTS; index += 1) expect(await expectedStart(nameOf(index))).toBe(true);

    expect(authorization.covers(TASK, DIGEST)).toBe(false);
    expect(await expectedStart(nameOf(REPLAY_LEASE_STARTS))).toBe(false);
  });

  it('lets a kept approval start clean copies without a bound, until it is revoked, and a revoked one cannot come back', async () => {
    const { authorization, expectedStart } = harness();
    authorization.grant(TASK, DIGEST, 'kept-1');

    for (let index = 0; index <= REPLAY_LEASE_STARTS; index += 1) expect(await expectedStart(nameOf(index))).toBe(true);
    expect(authorization.covers(TASK, DIGEST)).toBe(true);

    authorization.revokeKept('kept-1');
    expect(authorization.covers(TASK, DIGEST)).toBe(false);
    expect(await expectedStart(nameOf(100))).toBe(false);

    // A read of the kept approval that raced its revocation grants nothing.
    authorization.grant(TASK, DIGEST, 'kept-1');
    expect(authorization.covers(TASK, DIGEST)).toBe(false);
    expect(await expectedStart(nameOf(101))).toBe(false);
  });
});
