import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAgentRuntimeStore } from './SqliteAgentRuntimeStore';
import { AppDatabase } from './sqlite/AppDatabase';
import { ManagedFileStore } from './sqlite/ManagedFileStore';

const SEEDED_RECORDS = 100_000;
const TAIL_APPENDS = 1_000;
const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);

describe('SqliteAgentRuntimeStore accumulated-history scale', () => {
  it(
    'cold-loads one hundred thousand telemetry events and keeps tail appends row-native',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-scale-'));
      const databasePath = path.join(root, 'task-monki.sqlite3');
      let database = await AppDatabase.open(databasePath, { acquireLease: false });
      await seedTelemetryHistory(database, SEEDED_RECORDS);
      await database.close();

      const heapBefore = process.memoryUsage().heapUsed;
      database = await AppDatabase.open(databasePath, { acquireLease: false });
      const managedFiles = new ManagedFileStore(path.join(root, 'files'));
      let eventId = SEEDED_RECORDS;
      const store = new SqliteAgentRuntimeStore(
        database,
        managedFiles,
        path.join(root, 'protocol-journals'),
        {
          now: () => TIMESTAMP,
          createId: () => `tail-event-${++eventId}`
        }
      );

      const loaded = await store.snapshot();
      expect(loaded.telemetryRecords).toHaveLength(SEEDED_RECORDS);
      expect(loaded.events).toHaveLength(SEEDED_RECORDS);
      expect(loaded.nextEventOrdinal).toBe(SEEDED_RECORDS + 1);

      for (let index = 0; index < TAIL_APPENDS; index += 1) {
        await store.recordTelemetry({
          id: `tail-telemetry-${index}`,
          kind: 'SERVER',
          clientOperationId: `tail-operation-${index}`,
          payload: { sequence: SEEDED_RECORDS + index },
          observedAt: TIMESTAMP
        });
      }

      const aggregateMutationStartedAt = performance.now();
      await store.setShutdownLatched(true, 'scale-shutdown-latch');
      const aggregateMutationMilliseconds = performance.now() - aggregateMutationStartedAt;

      const complete = await store.snapshot();
      expect(complete.telemetryRecords).toHaveLength(SEEDED_RECORDS + TAIL_APPENDS);
      expect(complete.events).toHaveLength(SEEDED_RECORDS + TAIL_APPENDS + 1);
      expect(complete.shutdownLatched).toBe(true);
      expect(aggregateMutationMilliseconds).toBeLessThan(10_000);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(512 * 1024 * 1024);

      await store.close();
      await database.close();
      await fs.rm(root, { recursive: true });
    },
    60_000
  );
});

async function seedTelemetryHistory(database: AppDatabase, count: number): Promise<void> {
  await database.write((transaction) => {
    transaction.run(
      `INSERT INTO store_metadata (
         domain, record_revision, next_event_ordinal, next_queue_ordinal,
         shutdown_latched, payload_json, updated_at
       ) VALUES ('RUNTIME', ?, ?, 1, 0, '{}', ?)`,
      [count, count + 1, TIMESTAMP]
    );
    for (let index = 0; index < count; index += 1) {
      const telemetry = {
        id: `seed-telemetry-${index}`,
        kind: 'SERVER',
        clientOperationId: `seed-operation-${index}`,
        requestFingerprint: FINGERPRINT,
        payload: { sequence: index },
        observedAt: TIMESTAMP,
        createdAt: TIMESTAMP
      };
      const event = {
        id: `seed-event-${index}`,
        ordinal: index + 1,
        type: 'TELEMETRY_RECORDED',
        operationId: telemetry.clientOperationId,
        occurredAt: TIMESTAMP,
        payload: {
          telemetryId: telemetry.id,
          kind: telemetry.kind,
          requestFingerprint: FINGERPRINT
        }
      };
      transaction.run(
        `INSERT INTO runtime_telemetry (
           id, kind, owner_kind, task_id, request_id, conversation_id,
           stable_participant_id, session_id, run_id, server_instance_id,
           provider_identity, client_operation_id, request_fingerprint,
           observed_at, created_at, payload_json
         ) VALUES (?, 'SERVER', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, ?, ?, ?, ?, ?)`,
        [
          telemetry.id,
          telemetry.clientOperationId,
          telemetry.requestFingerprint,
          telemetry.observedAt,
          telemetry.createdAt,
          JSON.stringify(telemetry)
        ]
      );
      transaction.run(
        `INSERT INTO runtime_events (
           id, event_ordinal, type, run_id, session_id, queue_entry_id,
           artifact_id, operation_id, occurred_at, payload_json
         ) VALUES (?, ?, 'TELEMETRY_RECORDED', NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [event.id, event.ordinal, event.operationId, event.occurredAt, JSON.stringify(event)]
      );
    }
  });
}
