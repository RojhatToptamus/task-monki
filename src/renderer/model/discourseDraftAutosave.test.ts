import { describe, expect, it } from 'vitest';
import type { DiscourseDraftRecord } from '../../shared/discourse';
import { DiscourseDraftAutosaveCoordinator } from './discourseDraftAutosave';

describe('DiscourseDraftAutosaveCoordinator', () => {
  it('keeps an unresolved save scoped when the user switches conversations', async () => {
    const coordinator = new DiscourseDraftAutosaveCoordinator();
    const originalA = draft('draft-a', 'conversation-a', 1);
    const originalB = draft('draft-b', 'conversation-b', 4);
    const savedA = draft('draft-a', 'conversation-a', 2);
    const savedB = draft('draft-b', 'conversation-b', 5);
    const saveA = deferred<DiscourseDraftRecord>();
    const saveB = deferred<DiscourseDraftRecord>();
    const seenExisting: Array<DiscourseDraftRecord | undefined> = [];

    const scopeA = coordinator.activate('conversation-a', originalA);
    const pendingA = coordinator.enqueue(scopeA, async (existing) => {
      seenExisting.push(existing);
      return saveA.promise;
    });
    await Promise.resolve();

    const scopeB = coordinator.activate('conversation-b', originalB);
    const pendingB = coordinator.enqueue(scopeB, async (existing) => {
      seenExisting.push(existing);
      return saveB.promise;
    });

    saveA.resolve(savedA);
    const resultA = await pendingA;
    expect(resultA).toEqual({ scope: scopeA, saved: savedA });
    expect(coordinator.isActive(scopeA)).toBe(false);
    expect(coordinator.currentDraft()).toBe(originalB);
    coordinator.clear(scopeA);
    expect(coordinator.currentDraft()).toBe(originalB);

    await Promise.resolve();
    expect(seenExisting).toEqual([originalA, originalB]);
    saveB.resolve(savedB);
    await expect(pendingB).resolves.toEqual({ scope: scopeB, saved: savedB });
    expect(coordinator.isActive(scopeB)).toBe(true);
    expect(coordinator.currentDraft()).toBe(savedB);
  });

  it('feeds a saved revision to the next queued save in the same generation', async () => {
    const coordinator = new DiscourseDraftAutosaveCoordinator();
    const savedFirst = draft('draft-a', 'conversation-a', 1);
    const savedSecond = draft('draft-a', 'conversation-a', 2);
    const firstSave = deferred<DiscourseDraftRecord>();
    const seenExisting: Array<DiscourseDraftRecord | undefined> = [];
    const scope = coordinator.activate('conversation-a', undefined);

    const first = coordinator.enqueue(scope, async (existing) => {
      seenExisting.push(existing);
      return firstSave.promise;
    });
    const second = coordinator.enqueue(scope, async (existing) => {
      seenExisting.push(existing);
      return savedSecond;
    });

    firstSave.resolve(savedFirst);
    await first;
    await second;

    expect(seenExisting).toEqual([undefined, savedFirst]);
    expect(coordinator.currentDraft()).toBe(savedSecond);
  });
});

function draft(
  id: string,
  conversationId: string,
  recordRevision: number
): DiscourseDraftRecord {
  return {
    id,
    conversationId,
    recordRevision,
    body: `body-${recordRevision}`,
    policy: 'NONE',
    tokens: [],
    updatedAt: '2026-07-15T08:00:00.000Z'
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
