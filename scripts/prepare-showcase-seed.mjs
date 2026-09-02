import { createHash } from 'node:crypto';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORY_PROMPT = `Update the checkout API request-body parser.

Return a clear 400 validation response when an application/json body is null, an array, or another non-object value. Preserve the existing malformed-JSON response and add focused tests for the new cases.`;

const STORY_TASKS = {
  'agent-running': 'Handle null JSON request bodies',
  'preview-missing-recipe': 'Validate the checkout API change',
  'preview-compose-approval-required': 'Prepare the checkout API preview',
  'preview-oci-ready': 'Test checkout validation in preview',
  'review-needs-changes': 'Review null JSON request handling',
  'review-follow-up-active': 'Fix null JSON validation',
  'delivery-draft-pr': 'Open null JSON validation PR',
  'delivery-ready-to-merge': 'Ship null JSON validation'
};

const REVIEW_SUMMARY = 'One edge case should be fixed before this change is accepted.';
const REVIEW_FINDING = {
  id: 'null-json-body',
  severity: 'MAJOR',
  title: 'Null JSON body returns the wrong error',
  explanation:
    'typeof null is object, so the current guard accepts null and the handler fails later with a misleading internal error.',
  path: 'src/http/parseJsonBody.ts',
  line: 14,
  recommendation:
    'Reject null and arrays in the request-body guard, then add focused regression tests for both values.'
};

const REVIEW_DIFF = `diff --git a/src/http/parseJsonBody.ts b/src/http/parseJsonBody.ts
index b83ad2f..55ab5a9 100644
--- a/src/http/parseJsonBody.ts
+++ b/src/http/parseJsonBody.ts
@@ -8,7 +8,7 @@ export function requireJsonObject(body: unknown) {
-  if (typeof body !== 'object') {
+  if (typeof body !== 'object' || Array.isArray(body)) {
     throw new ValidationError('Expected a JSON object');
   }

diff --git a/src/http/parseJsonBody.test.ts b/src/http/parseJsonBody.test.ts
index 6aa1d37..e736cc9 100644
--- a/src/http/parseJsonBody.test.ts
+++ b/src/http/parseJsonBody.test.ts
@@ -21,3 +21,8 @@ describe('requireJsonObject', () => {
+  it('rejects array request bodies', () => {
+    expect(() => requireJsonObject([])).toThrow('Expected a JSON object');
+  });
 });
`;

export async function prepareShowcaseSeed(rootDir) {
  const manifestPath = path.join(rootDir, '.local', 'task-monki-dev-seed', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const db = new DatabaseSync(manifest.databasePath);

  try {
    db.exec('BEGIN IMMEDIATE');
    renameRepository(db, 'repo', 'Checkout API');
    renameRepository(db, 'repo-secondary', 'Web Client');
    cleanSeedTitles(db);

    const scenarioIds = new Map(
      manifest.scenarios
        .filter((scenario) => scenario.taskId)
        .map((scenario) => [scenario.slug, scenario.taskId])
    );

    for (const [slug, title] of Object.entries(STORY_TASKS)) {
      const taskId = scenarioIds.get(slug);
      if (!taskId) throw new Error(`Missing showcase seed scenario: ${slug}`);
      updateTask(db, taskId, (task) => ({
        ...task,
        title,
        prompt: STORY_PROMPT
      }));
      updateTaskBranch(db, taskId, 'codex/null-json-validation');
    }

    patchAgentProgress(db, scenarioIds.get('agent-running'));
    patchReview(db, scenarioIds.get('review-needs-changes'));
    patchReview(db, scenarioIds.get('review-follow-up-active'));
    patchReviewDiff(db, manifest.profileRoot, scenarioIds.get('review-needs-changes'));
    patchDesign(db);
    patchDiscourse(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }

  return manifest;
}

function cleanSeedTitles(db) {
  const rows = db.prepare('SELECT id, title, prompt, payload_json FROM tasks').all();
  const update = db.prepare(
    'UPDATE tasks SET title = ?, prompt = ?, payload_json = ? WHERE id = ?'
  );
  for (const row of rows) {
    const title = stripSeedPrefix(row.title);
    const prompt = stripSeedPrefix(row.prompt);
    const payload = JSON.parse(row.payload_json);
    payload.title = title;
    payload.prompt = prompt;
    update.run(title, prompt, JSON.stringify(payload), row.id);
  }

  const conversations = db
    .prepare('SELECT id, title, payload_json FROM discourse_conversations')
    .all();
  const updateConversation = db.prepare(
    'UPDATE discourse_conversations SET title = ?, payload_json = ? WHERE id = ?'
  );
  for (const row of conversations) {
    const title = stripSeedPrefix(row.title);
    const payload = JSON.parse(row.payload_json);
    payload.title = title;
    updateConversation.run(title, JSON.stringify(payload), row.id);
  }
}

function renameRepository(db, currentName, nextName) {
  const row = db
    .prepare('SELECT id, payload_json FROM repositories WHERE name = ?')
    .get(currentName);
  if (!row) return;
  const payload = JSON.parse(row.payload_json);
  payload.name = nextName;
  db.prepare('UPDATE repositories SET name = ?, payload_json = ? WHERE id = ?').run(
    nextName,
    JSON.stringify(payload),
    row.id
  );
}

function updateTask(db, taskId, update) {
  if (!taskId) throw new Error('Showcase task id is required.');
  const row = db
    .prepare('SELECT title, prompt, payload_json FROM tasks WHERE id = ?')
    .get(taskId);
  if (!row) throw new Error(`Showcase task not found: ${taskId}`);
  const payload = update(JSON.parse(row.payload_json));
  db.prepare('UPDATE tasks SET title = ?, prompt = ?, payload_json = ? WHERE id = ?').run(
    payload.title,
    payload.prompt,
    JSON.stringify(payload),
    taskId
  );
}

function updateTaskBranch(db, taskId, branchName) {
  const iterations = db
    .prepare('SELECT id, payload_json FROM task_iterations WHERE task_id = ?')
    .all(taskId);
  const updateIteration = db.prepare(
    'UPDATE task_iterations SET branch_name = ?, payload_json = ? WHERE id = ?'
  );
  for (const row of iterations) {
    const payload = JSON.parse(row.payload_json);
    payload.branchName = branchName;
    updateIteration.run(branchName, JSON.stringify(payload), row.id);
  }

  const snapshots = db
    .prepare('SELECT id, payload_json FROM git_snapshots WHERE task_id = ?')
    .all(taskId);
  const updateSnapshot = db.prepare('UPDATE git_snapshots SET payload_json = ? WHERE id = ?');
  for (const row of snapshots) {
    const payload = JSON.parse(row.payload_json);
    payload.branch = branchName;
    updateSnapshot.run(JSON.stringify(payload), row.id);
  }
}

function patchAgentProgress(db, taskId) {
  if (!taskId) return;
  const plans = db
    .prepare(
      'SELECT id, payload_json FROM runtime_plan_revisions WHERE run_id IN (SELECT id FROM runtime_runs WHERE task_id = ?)'
    )
    .all(taskId);
  const updatePlan = db.prepare('UPDATE runtime_plan_revisions SET payload_json = ? WHERE id = ?');
  for (const row of plans) {
    const payload = JSON.parse(row.payload_json);
    payload.explanation = 'Request-body validation is being updated and verified.';
    payload.steps = [
      { step: 'Inspect request body parser', status: 'COMPLETED' },
      { step: 'Handle null JSON bodies', status: 'IN_PROGRESS' },
      { step: 'Run focused API tests', status: 'PENDING' }
    ];
    updatePlan.run(JSON.stringify(payload), row.id);
  }

  const items = db
    .prepare(
      'SELECT id, payload_json FROM runtime_items WHERE run_id IN (SELECT id FROM runtime_runs WHERE task_id = ?)'
    )
    .all(taskId);
  const updateItem = db.prepare('UPDATE runtime_items SET payload_json = ? WHERE id = ?');
  for (const row of items) {
    const payload = JSON.parse(row.payload_json);
    if (payload.type === 'COMMAND_EXECUTION' && payload.payload?.command?.includes('sed ')) {
      payload.payload.command = "sed -n '1,120p' src/http/parseJsonBody.ts";
      payload.payload.commandActions = [
        {
          type: 'read',
          command: payload.payload.command,
          name: 'parseJsonBody.ts',
          path: 'src/http/parseJsonBody.ts'
        }
      ];
    } else if (payload.type === 'FILE_CHANGE') {
      payload.payload.changes = [
        {
          path: 'src/http/parseJsonBody.ts',
          kind: { type: 'update', move_path: null },
          diff: "-  if (typeof body !== 'object') {\n+  if (body === null || typeof body !== 'object' || Array.isArray(body)) {"
        }
      ];
    } else if (payload.type === 'AGENT_MESSAGE') {
      payload.payload.text =
        'Updated the request-body guard and added regression coverage for null and array values.';
    }
    updateItem.run(JSON.stringify(payload), row.id);
  }
}

function patchReview(db, taskId) {
  if (!taskId) return;
  updateTask(db, taskId, (task) => {
    const agentReview = task.projection?.agentReview;
    if (agentReview?.result) {
      agentReview.summary = REVIEW_SUMMARY;
      agentReview.result = {
        ...agentReview.result,
        summary: REVIEW_SUMMARY,
        findings: [REVIEW_FINDING]
      };
      task.projection.summary = REVIEW_SUMMARY;
    }
    return task;
  });
}

function patchReviewDiff(db, profileRoot, taskId) {
  if (!taskId) return;
  const artifact = db
    .prepare(
      `SELECT a.id, a.payload_json, m.id AS managed_file_id, m.storage_key
       FROM artifacts a
       JOIN managed_files m ON m.id = a.managed_file_id
       WHERE a.task_id = ? AND a.kind = 'diff'`
    )
    .get(taskId);
  if (!artifact) return;

  const buffer = Buffer.from(REVIEW_DIFF, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const filePath = path.join(profileRoot, 'storage', 'files', artifact.storage_key);
  const nextStorageKey = artifact.storage_key.replace(
    /-[a-f0-9]{64}\.log$/u,
    `-${sha256}.log`
  );
  const nextFilePath = path.join(profileRoot, 'storage', 'files', nextStorageKey);
  chmodSync(filePath, 0o600);
  writeFileSync(filePath, buffer);
  chmodSync(filePath, 0o400);
  renameSync(filePath, nextFilePath);

  db.prepare(
    'UPDATE managed_files SET storage_key = ?, content_sha256 = ?, byte_count = ? WHERE id = ?'
  ).run(nextStorageKey, sha256, buffer.length, artifact.managed_file_id);
  const artifactPayload = JSON.parse(artifact.payload_json);
  artifactPayload.byteCount = buffer.length;
  db.prepare('UPDATE artifacts SET payload_json = ? WHERE id = ?').run(
    JSON.stringify(artifactPayload),
    artifact.id
  );

  const snapshots = db
    .prepare('SELECT id, payload_json FROM git_snapshots WHERE task_id = ?')
    .all(taskId);
  const updateSnapshot = db.prepare('UPDATE git_snapshots SET payload_json = ? WHERE id = ?');
  for (const row of snapshots) {
    const payload = JSON.parse(row.payload_json);
    payload.committedDiffFileCount = 2;
    payload.diffStat =
      'src/http/parseJsonBody.ts      | 2 +-\n src/http/parseJsonBody.test.ts | 5 +++++\n 2 files changed, 6 insertions(+), 1 deletion(-)';
    updateSnapshot.run(JSON.stringify(payload), row.id);
  }
}

function patchDesign(db) {
  const row = db
    .prepare("SELECT id FROM tasks WHERE kind = 'DESIGN' ORDER BY created_at LIMIT 1")
    .get();
  if (!row) return;
  const prompt =
    'Design a polished consumer travel planner for a five-day trip to Lisbon. Show the daily itinerary, saved places, travel times, and an interactive map. Let people add places and move them between days. Make the route understandable at a glance, with an editorial travel feel rather than dashboard styling.';
  updateTask(db, row.id, (task) => ({
    ...task,
    title: 'Plan five days in Lisbon',
    prompt
  }));
}

function patchDiscourse(db) {
  const conversationId = 'seed-discourse-author-correction';
  const conversation = db
    .prepare('SELECT payload_json FROM discourse_conversations WHERE id = ?')
    .get(conversationId);
  if (!conversation) return;
  const title = 'Should preview environments share state?';
  const conversationPayload = JSON.parse(conversation.payload_json);
  conversationPayload.title = title;
  db.prepare(
    'UPDATE discourse_conversations SET title = ?, payload_json = ? WHERE id = ?'
  ).run(title, JSON.stringify(conversationPayload), conversationId);

  const messages = db
    .prepare(
      'SELECT id, message_ordinal, payload_json FROM discourse_messages WHERE conversation_id = ? ORDER BY message_ordinal'
    )
    .all(conversationId);
  const bodies = [
    'Should preview environments share one database to reduce startup time?',
    'Yes. Sharing one managed database would make previews faster to start.',
    'Correction: each preview needs an isolated database. Startup time should improve through reusable images, not shared state.'
  ];
  const updateMessage = db.prepare('UPDATE discourse_messages SET payload_json = ? WHERE id = ?');
  for (const row of messages) {
    const payload = JSON.parse(row.payload_json);
    payload.body = bodies[row.message_ordinal - 1] ?? payload.body;
    updateMessage.run(JSON.stringify(payload), row.id);
  }

  const concerns = db
    .prepare('SELECT id, payload_json FROM discourse_concerns WHERE conversation_id = ?')
    .all(conversationId);
  const updateConcern = db.prepare('UPDATE discourse_concerns SET payload_json = ? WHERE id = ?');
  for (const row of concerns) {
    const payload = JSON.parse(row.payload_json);
    payload.targetClaim = 'Sharing one managed database would make previews faster to start.';
    payload.category = 'preview isolation';
    payload.reason =
      'A shared database makes concurrent previews nondeterministic and lets one task alter another task’s test state.';
    payload.evidence = 'Each preview is expected to own a clean environment and database.';
    payload.suggestedResolution =
      'Keep databases isolated and optimize startup through reusable images.';
    updateConcern.run(JSON.stringify(payload), row.id);
  }
}

function stripSeedPrefix(value) {
  return String(value ?? '').replace(/^\[seed:[^\]]+\]\s*/, '');
}
