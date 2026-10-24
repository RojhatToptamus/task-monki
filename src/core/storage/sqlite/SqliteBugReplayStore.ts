import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase, AppDatabaseTransaction, SqlReader } from './AppDatabase';
import type { ManagedFileStore } from './ManagedFileStore';
import type {
  BugCaptureRecord,
  BugCaseDecisionRecord,
  BugCaseRecord,
  BugCaseVersionRecord,
  BugReplayFileKind,
  BugReplayFileRecord,
  BugReplayKeptApprovalRecord,
  StoredBugReplayRun
} from '../../bugReplay/BugReplayRecords';

/**
 * Query-on-demand store for Bug Replay. Records are not startup-loaded: evidence bytes are
 * verified when they are read, so a missing or corrupt screenshot shows as unavailable and never
 * blocks startup. Every write takes the caller's transaction, so a ledger change commits together
 * with the task event that projects it.
 */

const FILE_DOMAIN = 'TASK';
const STORAGE_PREFIX = 'replay';
/** A repository keeps the approvals of its newest recipes; older ones ask again. */
export const KEPT_APPROVALS_PER_REPOSITORY = 10;

export const BUG_REPLAY_FILE_LIMITS: Record<BugReplayFileKind, number> = {
  ACTION_LOG: 2 * 1024 * 1024,
  NETWORK_LOG: 1024 * 1024,
  CONSOLE_LOG: 256 * 1024,
  SCREENSHOT: 1024 * 1024,
  RUN_FRAMES: 1024 * 1024
};

export class BugReplayStoreConflictError extends Error {
  constructor(message = 'The bug changed while it was being saved.') {
    super(message);
    this.name = 'BugReplayStoreConflictError';
  }
}

export class SqliteBugReplayStore {
  constructor(
    private readonly database: AppDatabase,
    private readonly managedFiles: ManagedFileStore
  ) {}

  /** Retries deletions a crash interrupted and removes replay bytes no row references. */
  async init(): Promise<void> {
    await this.retryPendingGarbageCollection();
    const referenced = new Set(
      await this.database.read((reader) =>
        reader
          .all<{ storage_key: string }>(`SELECT storage_key FROM managed_files WHERE storage_key LIKE 'replay/%'`)
          .map((row) => row.storage_key)
      )
    );
    for (const key of await this.storedKeys()) {
      if (!referenced.has(key)) await this.managedFiles.deleteAfterReferenceCommit(key).catch(() => undefined);
    }
  }

  write<T>(callback: (transaction: AppDatabaseTransaction) => T | Promise<T>): Promise<T> {
    return this.database.write(callback);
  }

  read<T>(callback: (reader: SqlReader) => T | Promise<T>): Promise<T> {
    return this.database.read(callback);
  }

  // Captures

  insertCapture(transaction: AppDatabaseTransaction, record: BugCaptureRecord): void {
    transaction.run(
      `INSERT INTO bug_captures (id, task_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
      [record.id, record.taskId, JSON.stringify(record), record.createdAt]
    );
  }

  getCapture(reader: SqlReader, id: string): BugCaptureRecord | undefined {
    const row = reader.get<{ id: string; task_id: string; payload_json: string }>(
      `SELECT id, task_id, payload_json FROM bug_captures WHERE id = ?`,
      [id]
    );
    return row ? checked(parse<BugCaptureRecord>(row.payload_json), { id: row.id, taskId: row.task_id }) : undefined;
  }

  // Cases

  insertCase(transaction: AppDatabaseTransaction, record: BugCaseRecord): void {
    transaction.run(
      `INSERT INTO bug_cases (id, task_id, capture_id, status, payload_json, record_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.captureId, record.status, JSON.stringify(record), record.revision, record.createdAt, record.updatedAt]
    );
  }

  /** Compare-and-swap on the record revision. */
  updateCase(transaction: AppDatabaseTransaction, record: BugCaseRecord, expectedRevision: number): BugCaseRecord {
    const next = { ...record, revision: expectedRevision + 1 };
    const result = transaction.run(
      `UPDATE bug_cases SET status = ?, payload_json = ?, record_revision = ?, updated_at = ?
       WHERE id = ? AND record_revision = ?`,
      [next.status, JSON.stringify(next), next.revision, next.updatedAt, next.id, expectedRevision]
    );
    if (Number(result.changes) !== 1) throw new BugReplayStoreConflictError();
    return next;
  }

  getCase(reader: SqlReader, id: string): BugCaseRecord | undefined {
    const row = reader.get<{ id: string; task_id: string; status: string; record_revision: number; payload_json: string }>(
      `SELECT id, task_id, status, record_revision, payload_json FROM bug_cases WHERE id = ?`,
      [id]
    );
    return row ? caseFromRow(row) : undefined;
  }

  activeCase(reader: SqlReader, taskId: string): BugCaseRecord | undefined {
    const row = reader.get<{ id: string; task_id: string; status: string; record_revision: number; payload_json: string }>(
      `SELECT id, task_id, status, record_revision, payload_json FROM bug_cases WHERE task_id = ? AND status = 'ACTIVE'`,
      [taskId]
    );
    return row ? caseFromRow(row) : undefined;
  }

  listCases(reader: SqlReader, taskId: string): BugCaseRecord[] {
    return reader
      .all<{ id: string; task_id: string; status: string; record_revision: number; payload_json: string }>(
        `SELECT id, task_id, status, record_revision, payload_json FROM bug_cases WHERE task_id = ? ORDER BY created_at DESC, id`,
        [taskId]
      )
      .map(caseFromRow);
  }

  tasksWithActiveCases(reader: SqlReader): string[] {
    return reader.all<{ task_id: string }>(`SELECT task_id FROM bug_cases WHERE status = 'ACTIVE'`).map((row) => row.task_id);
  }

  // Versions and decisions

  insertVersion(transaction: AppDatabaseTransaction, record: BugCaseVersionRecord): void {
    transaction.run(
      `INSERT INTO bug_case_versions (id, case_id, task_id, version, digest, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.caseId, record.taskId, record.version, record.digest, JSON.stringify(record), record.createdAt]
    );
  }

  listVersions(reader: SqlReader, caseId: string): BugCaseVersionRecord[] {
    return reader
      .all<{ id: string; case_id: string; version: number; digest: string; payload_json: string }>(
        `SELECT id, case_id, version, digest, payload_json FROM bug_case_versions WHERE case_id = ? ORDER BY version`,
        [caseId]
      )
      .map((row) => {
        const record = parse<BugCaseVersionRecord>(row.payload_json);
        if (record.id !== row.id || record.caseId !== row.case_id || record.version !== row.version || record.digest !== row.digest) {
          throw new Error('A bug case version failed its integrity check.');
        }
        return record;
      });
  }

  insertDecision(transaction: AppDatabaseTransaction, record: BugCaseDecisionRecord): void {
    const count = transaction.get<{ count: number }>(`SELECT COUNT(*) AS count FROM bug_case_decisions WHERE case_id = ?`, [record.caseId]);
    if ((count?.count ?? 0) >= 200) throw new Error('This bug has too many changes. Record it again.');
    transaction.run(
      `INSERT INTO bug_case_decisions (id, case_id, task_id, kind, version_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.caseId, record.taskId, record.kind, record.versionId ?? null, JSON.stringify(record), record.createdAt]
    );
  }

  listDecisions(reader: SqlReader, caseId: string): BugCaseDecisionRecord[] {
    return reader
      .all<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM bug_case_decisions WHERE case_id = ? ORDER BY created_at, rowid`, [caseId])
      .map(decisionFromRow);
  }

  // Runs

  insertRun(transaction: AppDatabaseTransaction, run: StoredBugReplayRun): void {
    transaction.run(
      `INSERT INTO bug_replay_runs (id, task_id, case_id, version_id, set_id, kind, state, name, payload_json, record_revision, queued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id, run.taskId, run.caseId ?? null, run.versionId ?? null, run.setId ?? null, run.kind, run.state, run.name,
        JSON.stringify(run), run.revision, run.queuedAt, run.settledAt ?? run.startedAt ?? run.queuedAt
      ]
    );
  }

  /** Compare-and-swap on the run revision; returns the stored run. */
  updateRun(transaction: AppDatabaseTransaction, run: StoredBugReplayRun, expectedRevision: number): StoredBugReplayRun {
    const next = { ...run, revision: expectedRevision + 1 };
    const result = transaction.run(
      `UPDATE bug_replay_runs SET state = ?, set_id = ?, payload_json = ?, record_revision = ?, updated_at = ?
       WHERE id = ? AND record_revision = ?`,
      [next.state, next.setId ?? null, JSON.stringify(next), next.revision, new Date().toISOString(), next.id, expectedRevision]
    );
    if (Number(result.changes) !== 1) throw new BugReplayStoreConflictError('The clean run changed while it was being updated.');
    return next;
  }

  getRun(reader: SqlReader, id: string): StoredBugReplayRun | undefined {
    const row = reader.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM bug_replay_runs WHERE id = ?`, [id]);
    return row ? runFromRow(row) : undefined;
  }

  listRuns(reader: SqlReader, filter: { taskId?: string; caseId?: string; setId?: string; open?: boolean; limit?: number }): StoredBugReplayRun[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.taskId) {
      clauses.push('task_id = ?');
      parameters.push(filter.taskId);
    }
    if (filter.caseId) {
      clauses.push('case_id = ?');
      parameters.push(filter.caseId);
    }
    if (filter.setId) {
      clauses.push('set_id = ?');
      parameters.push(filter.setId);
    }
    if (filter.open) clauses.push(`state <> 'SETTLED'`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.min(500, Math.floor(filter.limit)))}` : '';
    return reader
      .all<RunRow>(`SELECT ${RUN_COLUMNS} FROM bug_replay_runs ${where} ORDER BY queued_at DESC, id ${limit}`, parameters)
      .map(runFromRow);
  }

  /** Removes settled run records; their files must already be deleted. */
  deleteRuns(transaction: AppDatabaseTransaction, ids: string[]): void {
    for (const id of ids) transaction.run(`DELETE FROM bug_replay_runs WHERE id = ? AND state = 'SETTLED'`, [id]);
  }

  // Files

  /**
   * Publishes immutable bytes, then records them in the caller's transaction. Bytes published for
   * a transaction that rolls back are deleted again.
   */
  async publishFile(input: {
    taskId: string;
    ownerKind: 'CAPTURE' | 'RUN';
    ownerId: string;
    kind: BugReplayFileKind;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<BugReplayFileRecord> {
    const limit = BUG_REPLAY_FILE_LIMITS[input.kind];
    if (input.bytes.byteLength > limit) throw new Error(`Bug evidence exceeds its ${Math.round(limit / 1024)} KiB limit.`);
    const id = randomUUID();
    const extension = input.mediaType === 'image/png' ? 'png' : input.mediaType.includes('json') ? 'json' : 'txt';
    const storageKey = `${STORAGE_PREFIX}/${input.taskId}/${input.ownerId}/${id}.${extension}`;
    const reference = await this.managedFiles.publish(storageKey, input.bytes);
    return {
      id,
      taskId: input.taskId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      managedFileId: `bug-replay-file:${id}`,
      kind: input.kind,
      mediaType: input.mediaType,
      storageKey,
      byteCount: reference.byteCount,
      sha256: reference.sha256,
      createdAt: new Date().toISOString()
    };
  }

  recordFile(transaction: AppDatabaseTransaction, file: BugReplayFileRecord): void {
    transaction.run(
      `INSERT INTO managed_files (id, domain, owner_id, role, storage_key, content_sha256, byte_count, media_type, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LIVE', ?, ?)`,
      [file.managedFileId, FILE_DOMAIN, file.taskId, `BUG_REPLAY:${file.kind}`, file.storageKey, file.sha256, file.byteCount, file.mediaType, file.createdAt, file.createdAt]
    );
    transaction.run(
      `INSERT INTO bug_replay_files (id, task_id, owner_kind, owner_id, managed_file_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [file.id, file.taskId, file.ownerKind, file.ownerId, file.managedFileId, file.kind, JSON.stringify(file), file.createdAt]
    );
    transaction.afterRollbackDeferred(() => this.managedFiles.deleteAfterReferenceCommit(file.storageKey).then(() => undefined, () => undefined));
  }

  /** Deletes bytes that were published for a write that never recorded them. */
  async discardPublished(files: BugReplayFileRecord[]): Promise<void> {
    await Promise.allSettled(files.map((file) => this.managedFiles.deleteAfterReferenceCommit(file.storageKey)));
  }

  getFile(reader: SqlReader, id: string): BugReplayFileRecord | undefined {
    const row = reader.get<FileRow>(`SELECT ${FILE_COLUMNS} FROM bug_replay_files WHERE id = ?`, [id]);
    return row ? fileFromRow(row) : undefined;
  }

  filesFor(reader: SqlReader, ownerKind: 'CAPTURE' | 'RUN', ownerId: string): BugReplayFileRecord[] {
    return reader
      .all<FileRow>(`SELECT ${FILE_COLUMNS} FROM bug_replay_files WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at, id`, [ownerKind, ownerId])
      .map(fileFromRow);
  }

  /** Verified bytes of one evidence file; throws when they are missing or corrupt. */
  async readFile(file: BugReplayFileRecord): Promise<Buffer> {
    return this.managedFiles.read({ storageKey: file.storageKey, byteCount: file.byteCount, sha256: file.sha256 }, BUG_REPLAY_FILE_LIMITS[file.kind]);
  }

  usedBytes(reader: SqlReader): number {
    return Number(reader.get<{ total: number | null }>(`SELECT SUM(byte_count) AS total FROM managed_files WHERE storage_key LIKE 'replay/%' AND state = 'LIVE'`)?.total ?? 0);
  }

  /** What one bug's capture and runs keep on disk. */
  bytesForCase(reader: SqlReader, caseId: string, captureId: string): number {
    return Number(
      reader.get<{ total: number | null }>(
        `SELECT SUM(m.byte_count) AS total FROM bug_replay_files f JOIN managed_files m ON m.id = f.managed_file_id
         WHERE (f.owner_kind = 'CAPTURE' AND f.owner_id = ?)
            OR (f.owner_kind = 'RUN' AND f.owner_id IN (SELECT id FROM bug_replay_runs WHERE case_id = ?))`,
        [captureId, caseId]
      )?.total ?? 0
    );
  }

  /** Deletes the given files' rows and queues their bytes for collection after commit. */
  deleteFiles(transaction: AppDatabaseTransaction, files: BugReplayFileRecord[]): void {
    const now = new Date().toISOString();
    for (const file of files) {
      transaction.run(`DELETE FROM bug_replay_files WHERE id = ?`, [file.id]);
      transaction.run(`DELETE FROM managed_files WHERE id = ?`, [file.managedFileId]);
      transaction.run(
        `INSERT OR IGNORE INTO managed_file_gc (storage_key, reason, queued_at) VALUES (?, 'BUG_REPLAY_DELETED', ?)`,
        [file.storageKey, now]
      );
    }
    if (files.length > 0) transaction.afterCommitDeferred(() => this.retryPendingGarbageCollection());
  }

  /** Removes every Bug Replay row of a task inside the task deletion transaction. */
  deleteForTask(transaction: AppDatabaseTransaction, taskId: string): void {
    const files = transaction.all<FileRow>(`SELECT ${FILE_COLUMNS} FROM bug_replay_files WHERE task_id = ?`, [taskId]).map(fileFromRow);
    this.deleteFiles(transaction, files);
    transaction.run(`DELETE FROM bug_replay_runs WHERE task_id = ?`, [taskId]);
    transaction.run(`DELETE FROM bug_case_decisions WHERE task_id = ?`, [taskId]);
    transaction.run(`DELETE FROM bug_case_versions WHERE task_id = ?`, [taskId]);
    transaction.run(`DELETE FROM bug_cases WHERE task_id = ?`, [taskId]);
    transaction.run(`DELETE FROM bug_captures WHERE task_id = ?`, [taskId]);
  }

  // Kept approvals

  /** The approval the person kept for this recipe in the repository, if they kept one. */
  keptApproval(reader: SqlReader, repositoryId: string, approvalDigest: string): BugReplayKeptApprovalRecord | undefined {
    const row = reader.get<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM bug_replay_approvals WHERE repository_id = ? AND approval_digest = ?`,
      [repositoryId, approvalDigest]
    );
    return row ? approvalFromRow(row) : undefined;
  }

  hasKeptApprovals(reader: SqlReader, repositoryId: string): boolean {
    return Boolean(reader.get(`SELECT 1 AS kept FROM bug_replay_approvals WHERE repository_id = ? LIMIT 1`, [repositoryId]));
  }

  /** Every kept approval, newest first. */
  listKeptApprovals(reader: SqlReader): BugReplayKeptApprovalRecord[] {
    return reader.all<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM bug_replay_approvals ORDER BY created_at DESC, id`).map(approvalFromRow);
  }

  /**
   * Keeps an approval for its repository; keeping the same recipe again returns the first one.
   * Returns the approval and the ids of the oldest ones the repository's bound let go.
   */
  keepApproval(transaction: AppDatabaseTransaction, record: BugReplayKeptApprovalRecord): { approval: BugReplayKeptApprovalRecord; released: string[] } {
    const existing = this.keptApproval(transaction, record.repositoryId, record.approvalDigest);
    if (existing) return { approval: existing, released: [] };
    transaction.run(
      `INSERT INTO bug_replay_approvals (id, repository_id, approval_digest, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      [record.id, record.repositoryId, record.approvalDigest, JSON.stringify(record), record.keptAt]
    );
    const released = transaction
      .all<{ id: string }>(
        `SELECT id FROM bug_replay_approvals WHERE repository_id = ? ORDER BY created_at DESC, id LIMIT -1 OFFSET ?`,
        [record.repositoryId, KEPT_APPROVALS_PER_REPOSITORY]
      )
      .map((row) => row.id);
    for (const id of released) transaction.run(`DELETE FROM bug_replay_approvals WHERE id = ?`, [id]);
    return { approval: record, released };
  }

  /** Deletes a kept approval, whatever its payload holds; false when it was already gone. */
  revokeApproval(transaction: AppDatabaseTransaction, id: string): boolean {
    return Number(transaction.run(`DELETE FROM bug_replay_approvals WHERE id = ?`, [id]).changes) === 1;
  }

  // Receipts

  private async retryPendingGarbageCollection(): Promise<void> {
    const keys = await this.database.read((reader) =>
      reader.all<{ storage_key: string }>(`SELECT storage_key FROM managed_file_gc WHERE storage_key LIKE 'replay/%'`).map((row) => row.storage_key)
    );
    for (const key of keys) {
      try {
        await this.managedFiles.deleteAfterReferenceCommit(key);
        await this.database.write((transaction) => {
          transaction.run(`DELETE FROM managed_file_gc WHERE storage_key = ?`, [key]);
        });
      } catch (error) {
        await this.database.write((transaction) => {
          transaction.run(
            `UPDATE managed_file_gc SET attempts = attempts + 1, last_error = ? WHERE storage_key = ?`,
            [String(error instanceof Error ? error.message : error).slice(0, 500), key]
          );
        }).catch(() => undefined);
      }
    }
  }

  private async storedKeys(): Promise<string[]> {
    const root = path.join(this.managedFiles.rootPath, STORAGE_PREFIX);
    const keys: string[] = [];
    const walk = async (directory: string, segments: string[]): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), [...segments, entry.name]);
        else if (entry.isFile() && !entry.name.startsWith('.')) keys.push([STORAGE_PREFIX, ...segments, entry.name].join('/'));
      }
    };
    await walk(root, []);
    return keys;
  }
}

interface RunRow {
  id: string;
  task_id: string;
  kind: string;
  state: string;
  name: string;
  record_revision: number;
  payload_json: string;
}

const RUN_COLUMNS = 'id, task_id, kind, state, name, record_revision, payload_json';

function runFromRow(row: RunRow): StoredBugReplayRun {
  const run = parse<StoredBugReplayRun>(row.payload_json);
  if (run.id !== row.id || run.taskId !== row.task_id || run.kind !== row.kind || run.state !== row.state || run.name !== row.name || run.revision !== row.record_revision) {
    throw new Error('A clean run record failed its integrity check.');
  }
  return run;
}

interface DecisionRow {
  id: string;
  case_id: string;
  task_id: string;
  kind: string;
  version_id: string | null;
  payload_json: string;
}

const DECISION_COLUMNS = 'id, case_id, task_id, kind, version_id, payload_json';

/** A decision picks the version the bug runs, so its payload must agree with its row. */
function decisionFromRow(row: DecisionRow): BugCaseDecisionRecord {
  const record = parse<BugCaseDecisionRecord>(row.payload_json);
  if (record.id !== row.id || record.caseId !== row.case_id || record.taskId !== row.task_id || record.kind !== row.kind || (record.versionId ?? null) !== row.version_id) {
    throw new Error('A bug case decision failed its integrity check.');
  }
  return record;
}

interface FileRow {
  id: string;
  task_id: string;
  owner_kind: string;
  owner_id: string;
  managed_file_id: string;
  kind: string;
  payload_json: string;
}

const FILE_COLUMNS = 'id, task_id, owner_kind, owner_id, managed_file_id, kind, payload_json';

/** A file's payload names the bytes deleting it removes, so it must agree with its row and key. */
function fileFromRow(row: FileRow): BugReplayFileRecord {
  const record = parse<BugReplayFileRecord>(row.payload_json);
  if (
    record.id !== row.id || record.taskId !== row.task_id || record.ownerKind !== row.owner_kind || record.ownerId !== row.owner_id ||
    record.managedFileId !== row.managed_file_id || record.kind !== row.kind ||
    !record.storageKey.startsWith(`${STORAGE_PREFIX}/${record.taskId}/${record.ownerId}/${record.id}.`)
  ) {
    throw new Error('A bug evidence file failed its integrity check.');
  }
  return record;
}

function caseFromRow(row: { id: string; task_id: string; status: string; record_revision: number; payload_json: string }): BugCaseRecord {
  const record = parse<BugCaseRecord>(row.payload_json);
  if (record.id !== row.id || record.taskId !== row.task_id || record.status !== row.status || record.revision !== row.record_revision) {
    throw new Error('A bug case record failed its integrity check.');
  }
  return record;
}

interface ApprovalRow {
  id: string;
  repository_id: string;
  approval_digest: string;
  payload_json: string;
}

const APPROVAL_COLUMNS = 'id, repository_id, approval_digest, payload_json';

/** A kept approval is read by its columns; a payload that says otherwise approves nothing. */
function approvalFromRow(row: ApprovalRow): BugReplayKeptApprovalRecord {
  const record = parse<BugReplayKeptApprovalRecord>(row.payload_json);
  if (record.id !== row.id || record.repositoryId !== row.repository_id || record.approvalDigest !== row.approval_digest) {
    throw new Error('A kept replay approval failed its integrity check.');
  }
  return record;
}

function checked<T extends { id: string; taskId: string }>(record: T, row: { id: string; taskId: string }): T {
  if (record.id !== row.id || record.taskId !== row.taskId) throw new Error('A bug record failed its integrity check.');
  return record;
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}
