import type {
  DiscourseConversationAggregateRecord,
  DiscourseConversationPage,
  DiscourseConversationRecord,
  DiscourseConversationTombstoneRecord,
  DiscourseDefaultPolicy,
  DiscourseMessagePage,
  DiscourseMessageRecord,
  DiscourseAgentJobRecord,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord,
  DiscourseMessageFreshness,
  DiscourseDraftRecord,
  DiscourseDraftTokenInput,
  DiscourseContextSelectionSnapshot,
  ConversationContextRevisionRecord,
  ContextSnapshotRecord,
  DiscourseConcernRecord
} from '../../shared/discourse';

export interface CreateDiscourseConversationInput {
  id?: string;
  title: string;
  defaultPolicy: DiscourseDefaultPolicy;
  participants: DiscourseParticipantRecord[];
  participantRevisions: DiscourseParticipantRevisionRecord[];
  clientOperationId: string;
}

export interface AppendHumanDiscourseMessageInput {
  conversationId: string;
  body: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds?: string[];
  context?: DiscourseContextSelectionSnapshot[];
  clientMessageId: string;
}

export interface AppendAgentDiscourseMessageInput {
  conversationId: string;
  body: string;
  stableParticipantId: string;
  participantRevisionId: string;
  displayNameSnapshot: string;
  waveId: string;
  jobId: string;
  contextSnapshotId?: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds: string[];
  freshnessAtCompletion: DiscourseMessageFreshness;
  clientOperationId: string;
}

export interface CreateDiscourseWaveInput {
  conversationId: string;
  expectedConversationRevision: number;
  wave: DiscourseResponseWaveRecord;
  jobs: DiscourseAgentJobRecord[];
  contextSnapshot: ContextSnapshotRecord;
  clientOperationId: string;
}

export interface DiscourseStore {
  init(): Promise<void>;
  close(): Promise<void>;
  createConversation(
    input: CreateDiscourseConversationInput
  ): Promise<DiscourseConversationRecord>;
  getConversation(conversationId: string): Promise<DiscourseConversationAggregateRecord>;
  listConversations(input?: {
    status?: 'OPEN' | 'ARCHIVED';
    cursor?: string;
    limit?: number;
  }): Promise<DiscourseConversationPage>;
  addParticipants(input: {
    conversationId: string;
    participants: DiscourseParticipantRecord[];
    participantRevisions: DiscourseParticipantRevisionRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationAggregateRecord>;
  appendHumanMessage(
    input: AppendHumanDiscourseMessageInput
  ): Promise<DiscourseMessageRecord>;
  appendAgentMessage(
    input: AppendAgentDiscourseMessageInput
  ): Promise<DiscourseMessageRecord>;
  tombstoneMessage(input: {
    conversationId: string;
    messageId: string;
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord>;
  listMessages(input: {
    conversationId: string;
    beforeCursor?: string;
    limit?: number;
  }): Promise<DiscourseMessagePage>;
  renameConversation(input: {
    conversationId: string;
    title: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord>;
  setConversationReadOrdinal(input: {
    conversationId: string;
    readOrdinal: number;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord>;
  setConversationArchived(input: {
    conversationId: string;
    archived: boolean;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationRecord>;
  deleteConversation(input: {
    conversationId: string;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseConversationTombstoneRecord>;
  getConversationTombstone(
    conversationId: string
  ): Promise<DiscourseConversationTombstoneRecord | undefined>;
  setPinnedContext(input: {
    conversationId: string;
    context: DiscourseContextSelectionSnapshot[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<ConversationContextRevisionRecord>;
  saveDraft(input: {
    draftId?: string;
    conversationId?: string;
    expectedRevision?: number;
    body: string;
    replyToMessageId?: string;
    policy: DiscourseDefaultPolicy;
    recipientParticipantIds: string[];
    tokens: DiscourseDraftTokenInput[];
  }): Promise<DiscourseDraftRecord>;
  getDraft(draftId: string): Promise<DiscourseDraftRecord | undefined>;
  listDrafts(): Promise<DiscourseDraftRecord[]>;
  deleteDraft(input: { draftId: string; expectedRevision: number }): Promise<void>;
  createWave(input: CreateDiscourseWaveInput): Promise<{
    wave: DiscourseResponseWaveRecord;
    jobs: DiscourseAgentJobRecord[];
  }>;
  addJobsToWave(input: {
    conversationId: string;
    waveId: string;
    jobs: DiscourseAgentJobRecord[];
    expectedConversationRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord[]>;
  completeReviewJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concerns: DiscourseConcernRecord[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord>;
  completeCorrectionJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    concernIds: string[];
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord>;
  updateWave(input: {
    conversationId: string;
    wave: DiscourseResponseWaveRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseResponseWaveRecord>;
  updateJob(input: {
    conversationId: string;
    job: DiscourseAgentJobRecord;
    expectedRevision: number;
    clientOperationId: string;
  }): Promise<DiscourseAgentJobRecord>;
}
