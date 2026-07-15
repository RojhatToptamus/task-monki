import type { TaskManagerApi } from '../../shared/contracts';
import {
  DISCOURSE_LIMITS,
  type DiscourseConversationStatus,
  type DiscourseConversationSummary
} from '../../shared/discourse';

/** Load the renderer's bounded summary snapshot without silently dropping later pages. */
export async function listDiscourseConversationSnapshot(
  api: Pick<TaskManagerApi, 'listDiscourseConversations'>,
  status?: DiscourseConversationStatus
): Promise<DiscourseConversationSummary[]> {
  const conversations: DiscourseConversationSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await api.listDiscourseConversations({
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      limit: Math.min(
        100,
        DISCOURSE_LIMITS.maxConversationSummariesInSnapshot - conversations.length
      )
    });
    conversations.push(...page.conversations);
    cursor = page.nextCursor;
  } while (
    cursor &&
    conversations.length < DISCOURSE_LIMITS.maxConversationSummariesInSnapshot
  );

  return conversations;
}
