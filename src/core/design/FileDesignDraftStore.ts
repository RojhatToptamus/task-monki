import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DeleteDesignDraftRequest,
  DesignDraftRecord,
  SaveDesignDraftRequest
} from '../../shared/contracts';
import { DESIGN_LIMITS } from '../../shared/design';
import {
  ensurePrivateDirectory,
  readPrivateFile,
  syncDirectoryIfSupported,
  writePrivateFileAtomically
} from '../filesystem/secureFilesystem';

const DESIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_DRAFT_FILE_BYTES = DESIGN_LIMITS.draftBytes + 4 * 1024;

/** Stores high-frequency composer text outside the durable task snapshot. */
export class FileDesignDraftStore {
  private initialization?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  init(): Promise<void> {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  async get(designId: string): Promise<DesignDraftRecord | undefined> {
    await this.init();
    return this.read(designId);
  }

  save(input: SaveDesignDraftRequest): Promise<DesignDraftRecord> {
    return this.enqueue(async () => {
      await this.init();
      assertDesignId(input.designId);
      assertRevision(input.expectedRevision);
      if (Buffer.byteLength(input.body, 'utf8') > DESIGN_LIMITS.draftBytes) {
        throw new Error('Design draft exceeds its text-size limit.');
      }
      const existing = await this.read(input.designId);
      if ((existing?.recordRevision ?? 0) !== input.expectedRevision) {
        throw new Error('Design draft changed before it could be saved.');
      }
      const draft: DesignDraftRecord = {
        designId: input.designId,
        recordRevision: input.expectedRevision + 1,
        body: input.body,
        updatedAt: new Date().toISOString()
      };
      await writePrivateFileAtomically(
        this.draftPath(input.designId),
        `${JSON.stringify(draft)}\n`
      );
      return draft;
    });
  }

  delete(input: DeleteDesignDraftRequest): Promise<void> {
    return this.enqueue(async () => {
      await this.init();
      assertDesignId(input.designId);
      assertRevision(input.expectedRevision);
      const existing = await this.read(input.designId);
      if (!existing) return;
      if (existing.recordRevision !== input.expectedRevision) {
        throw new Error('Design draft changed before it could be deleted.');
      }
      await fs.unlink(this.draftPath(input.designId));
      await syncDirectoryIfSupported(this.rootDirectory);
    });
  }

  deleteForDesign(designId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.init();
      assertDesignId(designId);
      await fs.unlink(this.draftPath(designId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await syncDirectoryIfSupported(this.rootDirectory);
    });
  }

  private async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.rootDirectory);
    const entries = await fs.readdir(this.rootDirectory);
    const stale = entries.filter((entry) => /^.+\.json\.\d+\.[0-9a-f-]+\.tmp$/u.test(entry));
    await Promise.all(
      stale.map((entry) => fs.unlink(path.join(this.rootDirectory, entry)))
    );
    if (stale.length > 0) await syncDirectoryIfSupported(this.rootDirectory);
  }

  private async read(designId: string): Promise<DesignDraftRecord | undefined> {
    assertDesignId(designId);
    let bytes: Buffer;
    try {
      bytes = await readPrivateFile(this.draftPath(designId), MAX_DRAFT_FILE_BYTES, {
        permissionPolicy: 'REQUIRE'
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('Design draft file is invalid.');
    }
    if (!isDraftRecord(value, designId)) {
      throw new Error('Design draft file is invalid.');
    }
    return value;
  }

  private draftPath(designId: string): string {
    assertDesignId(designId);
    return path.join(this.rootDirectory, `${designId}.json`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function assertDesignId(designId: string): void {
  if (!DESIGN_ID.test(designId)) throw new Error('Design id is invalid.');
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Design draft revision is invalid.');
  }
}

function isDraftRecord(value: unknown, designId: string): value is DesignDraftRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Partial<DesignDraftRecord>;
  return (
    draft.designId === designId &&
    typeof draft.body === 'string' &&
    Buffer.byteLength(draft.body, 'utf8') <= DESIGN_LIMITS.draftBytes &&
    Number.isSafeInteger(draft.recordRevision) &&
    (draft.recordRevision ?? 0) >= 1 &&
    typeof draft.updatedAt === 'string' &&
    isCanonicalTimestamp(draft.updatedAt)
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
