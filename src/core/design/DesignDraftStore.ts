import type {
  DeleteDesignDraftRequest,
  DesignDraftRecord,
  SaveDesignDraftRequest
} from '../../shared/contracts';
import { DESIGN_LIMITS } from '../../shared/design';
import type { AppDatabaseTransaction, SqlRowValue } from '../storage/sqlite/AppDatabase';
import { AppDatabase } from '../storage/sqlite/AppDatabase';

const DESIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ATTACHMENT_DRAFT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface DesignDraftStore {
  init(): Promise<void>;
  get(designId: string): Promise<DesignDraftRecord | undefined>;
  list(): Promise<DesignDraftRecord[]>;
  save(input: SaveDesignDraftRequest): Promise<DesignDraftRecord>;
  delete(input: DeleteDesignDraftRequest): Promise<void>;
  deleteForDesign(designId: string): Promise<void>;
}

/** Stores Design composer drafts as structured application data in SQLite. */
export class SqliteDesignDraftStore implements DesignDraftStore {
  constructor(
    private readonly database: AppDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  init(): Promise<void> {
    return Promise.resolve();
  }

  async get(designId: string): Promise<DesignDraftRecord | undefined> {
    assertDesignId(designId);
    return this.database.read((reader) => {
      const row = reader.get<DesignDraftRow>(
        `SELECT design_id, attachment_draft_id, record_revision, updated_at, payload_json
         FROM design_drafts
         WHERE design_id = ?`,
        [designId]
      );
      return row ? decodeDraft(row) : undefined;
    });
  }

  async list(): Promise<DesignDraftRecord[]> {
    return this.database.read((reader) =>
      reader
        .all<DesignDraftRow>(
          `SELECT design_id, attachment_draft_id, record_revision, updated_at, payload_json
           FROM design_drafts
           ORDER BY updated_at ASC, design_id ASC`
        )
        .map(decodeDraft)
    );
  }

  save(input: SaveDesignDraftRequest): Promise<DesignDraftRecord> {
    assertDesignId(input.designId);
    assertRevision(input.expectedRevision);
    if (Buffer.byteLength(input.body, 'utf8') > DESIGN_LIMITS.draftBytes) {
      return Promise.reject(new Error('Design draft exceeds its text-size limit.'));
    }
    assertReferenceIds(input.referenceIds);
    if (input.attachmentDraftId !== undefined) {
      assertAttachmentDraftId(input.attachmentDraftId);
    }

    return this.database.write((transaction) => {
      const existing = readDraft(transaction, input.designId);
      if ((existing?.recordRevision ?? 0) !== input.expectedRevision) {
        throw new Error('Design draft changed before it could be saved.');
      }
      if (input.attachmentDraftId) {
        const owner = transaction.get<{ design_id: SqlRowValue }>(
          `SELECT design_id
           FROM design_drafts
           WHERE attachment_draft_id = ? AND design_id <> ?`,
          [input.attachmentDraftId, input.designId]
        );
        if (owner) {
          throw new Error('Attachment draft already belongs to another Design draft.');
        }
      }

      const draft: DesignDraftRecord = {
        designId: input.designId,
        recordRevision: input.expectedRevision + 1,
        body: input.body,
        referenceIds: [...input.referenceIds],
        attachmentDraftId: input.attachmentDraftId,
        updatedAt: this.now()
      };
      const payloadJson = JSON.stringify({
        body: draft.body,
        referenceIds: draft.referenceIds
      });
      if (existing) {
        const result = transaction.run(
          `UPDATE design_drafts
           SET attachment_draft_id = ?, record_revision = ?, updated_at = ?, payload_json = ?
           WHERE design_id = ? AND record_revision = ?`,
          [
            draft.attachmentDraftId ?? null,
            draft.recordRevision,
            draft.updatedAt,
            payloadJson,
            draft.designId,
            input.expectedRevision
          ]
        );
        if (Number(result.changes) !== 1) {
          throw new Error('Design draft changed before it could be saved.');
        }
      } else {
        transaction.run(
          `INSERT INTO design_drafts (
             design_id, attachment_draft_id, record_revision, updated_at, payload_json
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            draft.designId,
            draft.attachmentDraftId ?? null,
            draft.recordRevision,
            draft.updatedAt,
            payloadJson
          ]
        );
      }
      return cloneDraft(draft);
    });
  }

  delete(input: DeleteDesignDraftRequest): Promise<void> {
    assertDesignId(input.designId);
    assertRevision(input.expectedRevision);
    return this.database.write((transaction) => {
      const existing = readDraft(transaction, input.designId);
      if (!existing) return;
      if (existing.recordRevision !== input.expectedRevision) {
        throw new Error('Design draft changed before it could be deleted.');
      }
      const result = transaction.run(
        'DELETE FROM design_drafts WHERE design_id = ? AND record_revision = ?',
        [input.designId, input.expectedRevision]
      );
      if (Number(result.changes) !== 1) {
        throw new Error('Design draft changed before it could be deleted.');
      }
    });
  }

  deleteForDesign(designId: string): Promise<void> {
    assertDesignId(designId);
    return this.database.write((transaction) => {
      transaction.run('DELETE FROM design_drafts WHERE design_id = ?', [designId]);
    });
  }
}

interface DesignDraftRow {
  design_id: SqlRowValue;
  attachment_draft_id: SqlRowValue;
  record_revision: SqlRowValue;
  updated_at: SqlRowValue;
  payload_json: SqlRowValue;
}

function readDraft(
  transaction: AppDatabaseTransaction,
  designId: string
): DesignDraftRecord | undefined {
  const row = transaction.get<DesignDraftRow>(
    `SELECT design_id, attachment_draft_id, record_revision, updated_at, payload_json
     FROM design_drafts
     WHERE design_id = ?`,
    [designId]
  );
  return row ? decodeDraft(row) : undefined;
}

function decodeDraft(row: DesignDraftRow): DesignDraftRecord {
  if (
    typeof row.design_id !== 'string' ||
    !DESIGN_ID.test(row.design_id) ||
    (row.attachment_draft_id !== null &&
      (typeof row.attachment_draft_id !== 'string' ||
        !ATTACHMENT_DRAFT_ID.test(row.attachment_draft_id))) ||
    typeof row.record_revision !== 'number' ||
    !Number.isSafeInteger(row.record_revision) ||
    row.record_revision < 1 ||
    typeof row.updated_at !== 'string' ||
    !isCanonicalTimestamp(row.updated_at) ||
    typeof row.payload_json !== 'string'
  ) {
    throw new Error('Stored Design draft metadata is invalid.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error('Stored Design draft payload is invalid.');
  }
  if (!isDraftPayload(payload)) {
    throw new Error('Stored Design draft payload is invalid.');
  }
  return {
    designId: row.design_id,
    recordRevision: row.record_revision,
    body: payload.body,
    referenceIds: [...payload.referenceIds],
    attachmentDraftId: row.attachment_draft_id ?? undefined,
    updatedAt: row.updated_at
  };
}

function isDraftPayload(value: unknown): value is { body: string; referenceIds: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as { body?: unknown; referenceIds?: unknown };
  return (
    typeof payload.body === 'string' &&
    Buffer.byteLength(payload.body, 'utf8') <= DESIGN_LIMITS.draftBytes &&
    Array.isArray(payload.referenceIds) &&
    payload.referenceIds.length <= 10 &&
    new Set(payload.referenceIds).size === payload.referenceIds.length &&
    payload.referenceIds.every(
      (referenceId): referenceId is string =>
        typeof referenceId === 'string' && DESIGN_ID.test(referenceId)
    )
  );
}

function cloneDraft(draft: DesignDraftRecord): DesignDraftRecord {
  return { ...draft, referenceIds: [...draft.referenceIds] };
}

function assertDesignId(designId: string): void {
  if (!DESIGN_ID.test(designId)) throw new Error('Design id is invalid.');
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Design draft revision is invalid.');
  }
}

function assertAttachmentDraftId(draftId: string): void {
  if (!ATTACHMENT_DRAFT_ID.test(draftId)) {
    throw new Error('Attachment draft id is invalid.');
  }
}

function assertReferenceIds(referenceIds: readonly string[]): void {
  if (
    !Array.isArray(referenceIds) ||
    referenceIds.length > 10 ||
    new Set(referenceIds).size !== referenceIds.length ||
    referenceIds.some((referenceId) => !DESIGN_ID.test(referenceId))
  ) {
    throw new Error('Design draft reference selection is invalid.');
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
