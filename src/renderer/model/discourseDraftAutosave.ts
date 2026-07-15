import type { DiscourseDraftRecord } from '../../shared/discourse';

export interface DiscourseDraftAutosaveScope {
  readonly generation: number;
  readonly conversationId?: string;
  draft?: DiscourseDraftRecord;
}

export interface DiscourseDraftAutosaveResult {
  scope: DiscourseDraftAutosaveScope;
  saved?: DiscourseDraftRecord;
}

/**
 * Serializes draft revisions while keeping their identity scoped to the
 * conversation generation that scheduled them. A late save may still update
 * that conversation's draft list, but it can never become the active draft for
 * a conversation selected in the meantime.
 */
export class DiscourseDraftAutosaveCoordinator {
  private generation = 0;
  private activeScope?: DiscourseDraftAutosaveScope;
  private tail: Promise<void> = Promise.resolve();

  activate(
    conversationId: string | undefined,
    draft: DiscourseDraftRecord | undefined
  ): DiscourseDraftAutosaveScope {
    const scope = {
      generation: ++this.generation,
      ...(conversationId ? { conversationId } : {}),
      ...(draft ? { draft } : {})
    };
    this.activeScope = scope;
    return scope;
  }

  currentScope(): DiscourseDraftAutosaveScope | undefined {
    return this.activeScope;
  }

  currentDraft(): DiscourseDraftRecord | undefined {
    return this.activeScope?.draft;
  }

  draftFor(scope: DiscourseDraftAutosaveScope): DiscourseDraftRecord | undefined {
    return scope.draft;
  }

  isActive(scope: DiscourseDraftAutosaveScope): boolean {
    return this.activeScope === scope;
  }

  clear(scope: DiscourseDraftAutosaveScope): void {
    scope.draft = undefined;
  }

  enqueue(
    scope: DiscourseDraftAutosaveScope,
    save: (
      existing: DiscourseDraftRecord | undefined
    ) => Promise<DiscourseDraftRecord | undefined>
  ): Promise<DiscourseDraftAutosaveResult> {
    const pending = this.tail.then(async () => {
      const saved = await save(scope.draft);
      if (saved) scope.draft = saved;
      return { scope, ...(saved ? { saved } : {}) };
    });
    // A rejected save must not strand later conversations behind it. The
    // caller still receives the original rejection and can surface the error.
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
