import type {
  DiscourseAgentSelectionInput,
  DiscourseDefaultPolicy,
  DiscourseMessageRecord
} from '../../shared/discourse';

export function deriveDiscourseConversationTitle(body: string): string {
  const first =
    body.split(/\r?\n/u).find((line) => line.trim())?.trim() ??
    'New conversation';
  return first.length <= 72 ? first : `${first.slice(0, 69).trimEnd()}…`;
}

export function discoursePendingConversationFingerprint(
  title: string,
  policy: DiscourseDefaultPolicy,
  selections: DiscourseAgentSelectionInput[]
): string {
  return JSON.stringify({
    title,
    policy,
    agents: [...selections]
      .sort((left, right) => left.agentProfileId.localeCompare(right.agentProfileId))
      .map((selection) => ({
        agentProfileId: selection.agentProfileId,
        runtimeId: selection.runtimeId ?? '',
        modelId: selection.modelId ?? '',
        reasoningEffort: selection.reasoningEffort ?? ''
      }))
  });
}

export function dedupeDiscourseMessages(
  messages: DiscourseMessageRecord[]
): DiscourseMessageRecord[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()].sort(
    (left, right) => left.ordinal - right.ordinal
  );
}

export function dedupeDiscourseContextSelections<
  T extends { entityKind: string; entityId: string }
>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.entityKind}:${value.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
