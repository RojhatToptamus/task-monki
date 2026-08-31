export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** "TMKI". Registered locally to reject unrelated SQLite files. */
export const APP_DATABASE_APPLICATION_ID = 0x544d4b49;

const INITIAL_SCHEMA_SQL = String.raw`
CREATE TABLE app_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  updated_at TEXT
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('USER_REGISTERED', 'DESIGN_MANAGED')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  head_sha TEXT,
  branch TEXT,
  remotes_json TEXT NOT NULL CHECK (json_valid(remotes_json)),
  error TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  checked_at TEXT
) STRICT;

CREATE INDEX repositories_status_updated_idx ON repositories(status, updated_at DESC, id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE board_repositories (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (board_id, repository_id),
  UNIQUE (board_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE board_workflow_phases (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  workflow_phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (board_id, workflow_phase),
  UNIQUE (board_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('NORMAL', 'DESIGN')),
  runtime_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  creation_token TEXT UNIQUE,
  creation_request_fingerprint TEXT,
  workflow_phase TEXT NOT NULL,
  resolution TEXT NOT NULL,
  completion_policy TEXT NOT NULL,
  phase_version INTEGER NOT NULL CHECK (phase_version >= 0),
  current_run_id TEXT,
  current_session_id TEXT,
  current_iteration_id TEXT,
  current_worktree_id TEXT,
  forked_from_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  forked_from_run_id TEXT,
  source_design_id TEXT,
  source_design_revision_id TEXT,
  agent_settings_json TEXT NOT NULL CHECK (json_valid(agent_settings_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (creation_token IS NULL AND creation_request_fingerprint IS NULL) OR
    (creation_token IS NOT NULL AND creation_request_fingerprint IS NOT NULL)
  )
) STRICT;

CREATE INDEX tasks_repository_phase_updated_idx
  ON tasks(repository_id, workflow_phase, updated_at DESC, id);
CREATE INDEX tasks_phase_updated_idx ON tasks(workflow_phase, updated_at DESC, id);
CREATE INDEX tasks_current_run_idx ON tasks(current_run_id) WHERE current_run_id IS NOT NULL;

CREATE TABLE task_alternatives (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  alternative_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (task_id, alternative_task_id),
  UNIQUE (task_id, ordinal),
  CHECK (task_id <> alternative_task_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE task_iterations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  generation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_ref TEXT,
  base_sha TEXT NOT NULL,
  worktree_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_iterations_task_status_idx ON task_iterations(task_id, status, updated_at DESC);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_ref TEXT,
  base_sha TEXT NOT NULL,
  head_sha TEXT,
  status TEXT NOT NULL,
  error TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  UNIQUE (iteration_id)
) STRICT;

CREATE INDEX worktrees_task_status_idx ON worktrees(task_id, status, updated_at DESC);
CREATE INDEX worktrees_repository_status_idx ON worktrees(repository_id, status, updated_at DESC);

CREATE TABLE task_domain_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT,
  run_id TEXT,
  session_id TEXT,
  server_instance_id TEXT,
  agent_item_id TEXT,
  interaction_request_id TEXT,
  worktree_id TEXT,
  preview_plan_id TEXT,
  preview_generation_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX task_domain_events_task_time_idx
  ON task_domain_events(task_id, occurred_at DESC, id);
CREATE INDEX task_domain_events_run_idx
  ON task_domain_events(run_id, occurred_at DESC) WHERE run_id IS NOT NULL;

CREATE TABLE managed_files (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  role TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  media_type TEXT,
  state TEXT NOT NULL DEFAULT 'LIVE' CHECK (state IN ('LIVE', 'GC_PENDING', 'QUARANTINED')),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX managed_files_owner_idx ON managed_files(domain, owner_id, role, id);
CREATE INDEX managed_files_state_idx ON managed_files(state, updated_at, id);

CREATE TABLE managed_file_gc (
  storage_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  managed_file_id TEXT NOT NULL UNIQUE REFERENCES managed_files(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_attachments_task_idx ON task_attachments(task_id, ordinal, id);

CREATE TABLE attachment_drafts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE TABLE staged_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES attachment_drafts(id) ON DELETE CASCADE,
  managed_file_id TEXT NOT NULL UNIQUE REFERENCES managed_files(id) ON DELETE RESTRICT,
  client_token TEXT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (draft_id, ordinal),
  UNIQUE (draft_id, client_token)
) STRICT;

CREATE INDEX staged_attachments_draft_idx ON staged_attachments(draft_id, ordinal, id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  managed_file_id TEXT NOT NULL REFERENCES managed_files(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  client_operation_id TEXT,
  request_fingerprint TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, revision),
  UNIQUE (managed_file_id)
) STRICT;

CREATE INDEX artifacts_owner_idx ON artifacts(domain, owner_id, kind, revision DESC);
CREATE INDEX artifacts_run_idx ON artifacts(run_id, kind, revision DESC) WHERE run_id IS NOT NULL;

CREATE TABLE store_metadata (
  domain TEXT PRIMARY KEY,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  next_event_ordinal INTEGER CHECK (next_event_ordinal IS NULL OR next_event_ordinal >= 0),
  next_queue_ordinal INTEGER CHECK (next_queue_ordinal IS NULL OR next_queue_ordinal >= 0),
  shutdown_latched INTEGER CHECK (shutdown_latched IS NULL OR shutdown_latched IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT
) STRICT;

CREATE TABLE design_turns (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  turn_ordinal INTEGER NOT NULL CHECK (turn_ordinal >= 0),
  run_id TEXT,
  outcome TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (design_id, client_message_id),
  UNIQUE (design_id, turn_ordinal)
) STRICT;

CREATE INDEX design_turns_design_idx ON design_turns(design_id, turn_ordinal DESC, id);
CREATE INDEX design_turns_run_idx ON design_turns(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE design_references (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX design_references_design_state_idx
  ON design_references(design_id, state, created_at, id);

CREATE TABLE design_revisions (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision_ordinal INTEGER NOT NULL CHECK (revision_ordinal >= 0),
  commit_sha TEXT NOT NULL,
  change_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (design_id, revision_ordinal)
) STRICT;

CREATE INDEX design_revisions_design_idx
  ON design_revisions(design_id, revision_ordinal DESC, id);

CREATE TABLE design_source_actions (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  client_action_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  target_design_id TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (design_id, client_action_id)
) STRICT;

CREATE INDEX design_source_actions_design_checkpoint_idx
  ON design_source_actions(design_id, checkpoint, updated_at DESC, id);

CREATE TABLE design_drafts (
  design_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  attachment_draft_id TEXT UNIQUE,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE TABLE git_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  head_sha TEXT,
  captured_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX git_snapshots_task_time_idx ON git_snapshots(task_id, captured_at DESC, id);
CREATE INDEX git_snapshots_worktree_time_idx ON git_snapshots(worktree_id, captured_at DESC, id);

CREATE TABLE github_repository_observations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX github_repository_task_time_idx
  ON github_repository_observations(task_id, checked_at DESC, id);

CREATE TABLE branch_publications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  head_sha TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX branch_publications_task_status_idx
  ON branch_publications(task_id, status, updated_at DESC, id);

CREATE TABLE pull_request_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  pull_request_number INTEGER,
  status TEXT NOT NULL,
  head_sha TEXT,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX pull_requests_task_time_idx ON pull_request_snapshots(task_id, observed_at DESC, id);

CREATE TABLE ci_rollups (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  pull_request_number INTEGER,
  head_sha TEXT,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX ci_rollups_task_time_idx ON ci_rollups(task_id, observed_at DESC, id);

CREATE TABLE review_rollups (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  pull_request_number INTEGER,
  head_sha TEXT,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX review_rollups_task_time_idx ON review_rollups(task_id, observed_at DESC, id);

CREATE TABLE merge_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  pull_request_number INTEGER,
  head_sha TEXT,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX merge_snapshots_task_time_idx ON merge_snapshots(task_id, observed_at DESC, id);

CREATE TABLE runtime_servers (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  started_at TEXT NOT NULL,
  updated_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_servers_runtime_status_idx
  ON runtime_servers(runtime_id, status, started_at DESC, id);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('TASK', 'PROMPT_REFINEMENT', 'DISCOURSE')),
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  provider_session_id TEXT,
  status TEXT NOT NULL,
  role TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (runtime_id, provider_session_id),
  CHECK (
    (owner_kind = 'TASK' AND task_id IS NOT NULL AND request_id IS NULL AND conversation_id IS NULL AND stable_participant_id IS NULL) OR
    (owner_kind = 'PROMPT_REFINEMENT' AND task_id IS NULL AND request_id IS NOT NULL AND conversation_id IS NULL AND stable_participant_id IS NULL) OR
    (owner_kind = 'DISCOURSE' AND task_id IS NULL AND request_id IS NULL AND conversation_id IS NOT NULL AND stable_participant_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX runtime_sessions_owner_idx
  ON runtime_sessions(owner_kind, task_id, request_id, conversation_id, stable_participant_id, status, updated_at DESC);
CREATE INDEX runtime_sessions_runtime_status_idx
  ON runtime_sessions(runtime_id, status, updated_at DESC, id);
CREATE UNIQUE INDEX runtime_sessions_owner_operation_idx ON runtime_sessions(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_runs (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('TASK', 'PROMPT_REFINEMENT', 'DISCOURSE')),
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  iteration_id TEXT,
  worktree_id TEXT,
  wave_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  server_instance_id TEXT,
  provider_turn_id TEXT,
  status TEXT NOT NULL,
  recovery_state TEXT NOT NULL,
  generation_key TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  last_event_at TEXT,
  ended_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (
    (owner_kind = 'TASK' AND task_id IS NOT NULL AND request_id IS NULL AND conversation_id IS NULL AND stable_participant_id IS NULL) OR
    (owner_kind = 'PROMPT_REFINEMENT' AND task_id IS NULL AND request_id IS NOT NULL AND conversation_id IS NULL AND stable_participant_id IS NULL) OR
    (owner_kind = 'DISCOURSE' AND task_id IS NULL AND request_id IS NULL AND conversation_id IS NOT NULL AND stable_participant_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX runtime_runs_owner_status_idx
  ON runtime_runs(
    owner_kind,
    task_id,
    request_id,
    conversation_id,
    stable_participant_id,
    status,
    created_at DESC,
    id
  );
CREATE INDEX runtime_runs_session_status_idx
  ON runtime_runs(session_id, status, created_at DESC, id);
CREATE INDEX runtime_runs_runtime_status_idx
  ON runtime_runs(runtime_id, status, created_at DESC, id);
CREATE INDEX runtime_runs_provider_turn_idx
  ON runtime_runs(runtime_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL;
CREATE UNIQUE INDEX runtime_runs_owner_operation_idx ON runtime_runs(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_artifacts (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  managed_file_id TEXT NOT NULL UNIQUE REFERENCES managed_files(id) ON DELETE RESTRICT,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_artifacts_run_kind_idx
  ON runtime_artifacts(run_id, kind, record_revision DESC, id);
CREATE UNIQUE INDEX runtime_artifacts_owner_operation_idx ON runtime_artifacts(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_queue_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueue_ordinal INTEGER NOT NULL UNIQUE CHECK (enqueue_ordinal >= 0),
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  enqueued_at TEXT NOT NULL,
  not_before TEXT,
  leased_at TEXT,
  settled_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_queue_status_priority_idx
  ON runtime_queue_entries(status, priority, not_before, enqueue_ordinal);
CREATE INDEX runtime_queue_owner_idx
  ON runtime_queue_entries(owner_kind, task_id, request_id, conversation_id, stable_participant_id, status);
CREATE UNIQUE INDEX runtime_queue_owner_operation_idx ON runtime_queue_entries(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_items (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  provider_item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (run_id, provider_item_id)
) STRICT;

CREATE INDEX runtime_items_run_status_idx ON runtime_items(run_id, status, updated_at DESC, id);
CREATE UNIQUE INDEX runtime_items_owner_operation_idx ON runtime_items(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_interactions (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  server_instance_id TEXT NOT NULL REFERENCES runtime_servers(id) ON DELETE CASCADE,
  provider_request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  resolved_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (server_instance_id, provider_request_id)
) STRICT;

CREATE INDEX runtime_interactions_run_status_idx
  ON runtime_interactions(run_id, status, requested_at DESC, id);
CREATE UNIQUE INDEX runtime_interactions_owner_operation_idx ON runtime_interactions(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_goal_snapshots (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  status TEXT,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_goals_session_time_idx
  ON runtime_goal_snapshots(session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_goals_owner_operation_idx ON runtime_goal_snapshots(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_plan_revisions (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (run_id, revision)
) STRICT;

CREATE INDEX runtime_plans_session_time_idx
  ON runtime_plan_revisions(session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_plans_owner_operation_idx ON runtime_plan_revisions(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_usage_snapshots (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_usage_session_time_idx
  ON runtime_usage_snapshots(session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_usage_owner_operation_idx ON runtime_usage_snapshots(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_settings_observations (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  run_id TEXT REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_settings_session_time_idx
  ON runtime_settings_observations(session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_settings_owner_operation_idx ON runtime_settings_observations(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_subagent_observations (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT,
  provider_child_session_id TEXT NOT NULL,
  status TEXT,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_subagents_parent_time_idx
  ON runtime_subagent_observations(parent_session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_subagents_owner_operation_idx ON runtime_subagent_observations(
  owner_kind,
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_telemetry (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_kind TEXT,
  task_id TEXT,
  request_id TEXT,
  conversation_id TEXT,
  stable_participant_id TEXT,
  session_id TEXT REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runtime_runs(id) ON DELETE CASCADE,
  server_instance_id TEXT REFERENCES runtime_servers(id) ON DELETE CASCADE,
  provider_identity TEXT,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_telemetry_run_time_idx ON runtime_telemetry(run_id, observed_at DESC, id);
CREATE INDEX runtime_telemetry_session_time_idx
  ON runtime_telemetry(session_id, observed_at DESC, id);
CREATE UNIQUE INDEX runtime_telemetry_owner_operation_idx ON runtime_telemetry(
  coalesce(owner_kind, 'APP'),
  coalesce(task_id, ''),
  coalesce(request_id, ''),
  coalesce(conversation_id, ''),
  coalesce(stable_participant_id, ''),
  client_operation_id
);

CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY,
  event_ordinal INTEGER NOT NULL UNIQUE CHECK (event_ordinal >= 0),
  type TEXT NOT NULL,
  run_id TEXT REFERENCES runtime_runs(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  queue_entry_id TEXT REFERENCES runtime_queue_entries(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES runtime_artifacts(id) ON DELETE SET NULL,
  operation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX runtime_events_run_ordinal_idx ON runtime_events(run_id, event_ordinal DESC, id);
CREATE INDEX runtime_events_session_ordinal_idx
  ON runtime_events(session_id, event_ordinal DESC, id);
CREATE INDEX runtime_events_operation_idx ON runtime_events(operation_id, event_ordinal, id);

CREATE TABLE operation_receipts (
  domain TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (domain, owner_id, client_operation_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX operation_receipts_owner_idx
  ON operation_receipts(domain, owner_id, created_at DESC, client_operation_id);

CREATE TABLE discourse_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  default_policy TEXT NOT NULL,
  latest_ordinal INTEGER NOT NULL CHECK (latest_ordinal >= 0),
  read_ordinal INTEGER NOT NULL CHECK (read_ordinal >= 0),
  latest_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_event_sequence >= 0),
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (read_ordinal <= latest_ordinal)
) STRICT;

CREATE INDEX discourse_conversations_status_updated_idx
  ON discourse_conversations(status, updated_at DESC, id);

CREATE TABLE discourse_participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  agent_profile_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, id),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_participants_conversation_enabled_idx
  ON discourse_participants(conversation_id, enabled, id);

CREATE TABLE discourse_participant_revisions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  stable_participant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, stable_participant_id, revision)
) STRICT;

CREATE INDEX discourse_participant_revisions_idx
  ON discourse_participant_revisions(conversation_id, stable_participant_id, revision DESC);

CREATE TABLE discourse_accepted_sends (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  client_message_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  canceled_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_sends_conversation_status_idx
  ON discourse_accepted_sends(conversation_id, status, created_at DESC, id);

CREATE TABLE discourse_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  client_message_id TEXT,
  message_ordinal INTEGER NOT NULL CHECK (message_ordinal >= 0),
  author_kind TEXT NOT NULL,
  parent_message_id TEXT REFERENCES discourse_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, message_ordinal),
  UNIQUE (conversation_id, client_message_id)
) STRICT;

CREATE INDEX discourse_messages_conversation_ordinal_idx
  ON discourse_messages(conversation_id, message_ordinal DESC, id);

CREATE TABLE discourse_context_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  created_by_message_id TEXT REFERENCES discourse_messages(id) ON DELETE SET NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  availability TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_context_links_conversation_idx
  ON discourse_context_links(conversation_id, scope, entity_kind, entity_id, id);

CREATE TABLE discourse_context_revisions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, revision)
) STRICT;

CREATE TABLE discourse_context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  wave_id TEXT NOT NULL,
  context_revision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_context_snapshots_conversation_idx
  ON discourse_context_snapshots(conversation_id, created_at DESC, id);

CREATE TABLE discourse_context_sources (
  context_snapshot_id TEXT NOT NULL REFERENCES discourse_context_snapshots(id) ON DELETE CASCADE,
  context_link_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (context_snapshot_id, source_ordinal),
  UNIQUE (context_snapshot_id, context_link_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE discourse_waves (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  context_snapshot_id TEXT REFERENCES discourse_context_snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  phase TEXT,
  outcome TEXT,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, client_operation_id),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_waves_conversation_status_idx
  ON discourse_waves(conversation_id, status, created_at DESC, id);

CREATE TABLE discourse_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  wave_id TEXT NOT NULL REFERENCES discourse_waves(id) ON DELETE CASCADE,
  stable_participant_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  generation_key TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (wave_id, stable_participant_id, attempt_id),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_jobs_wave_status_idx ON discourse_jobs(wave_id, status, created_at DESC, id);
CREATE INDEX discourse_jobs_runtime_run_idx ON discourse_jobs(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE discourse_concerns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  aggregate_ordinal INTEGER NOT NULL CHECK (aggregate_ordinal >= 0),
  wave_id TEXT NOT NULL REFERENCES discourse_waves(id) ON DELETE CASCADE,
  review_job_id TEXT NOT NULL REFERENCES discourse_jobs(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, aggregate_ordinal)
) STRICT;

CREATE INDEX discourse_concerns_wave_status_idx
  ON discourse_concerns(wave_id, severity, created_at, id);

CREATE TABLE discourse_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  covered_ordinal_start INTEGER NOT NULL CHECK (covered_ordinal_start >= 0),
  covered_ordinal_end INTEGER NOT NULL CHECK (covered_ordinal_end >= covered_ordinal_start),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, revision)
) STRICT;

CREATE TABLE discourse_drafts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES discourse_conversations(id) ON DELETE CASCADE,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id)
) STRICT;

CREATE TABLE discourse_tombstones (
  conversation_id TEXT PRIMARY KEY,
  client_operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
  deleted_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (conversation_id, client_operation_id)
) STRICT;

CREATE TABLE preview_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  execution_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX preview_plans_task_time_idx ON preview_plans(task_id, created_at DESC, id);

CREATE TABLE preview_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES preview_plans(id) ON DELETE CASCADE,
  execution_digest TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  invalidated_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX preview_approvals_task_time_idx ON preview_approvals(task_id, approved_at DESC, id);

CREATE TABLE preview_generations (
  id TEXT PRIMARY KEY,
  preview_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  iteration_id TEXT NOT NULL REFERENCES task_iterations(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES preview_plans(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  routing_state TEXT NOT NULL,
  adapter TEXT,
  replaces_generation_id TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  cutover_at TEXT,
  stopped_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX preview_generations_task_state_idx
  ON preview_generations(task_id, state, updated_at DESC, id);
CREATE INDEX preview_generations_key_routing_idx
  ON preview_generations(preview_key, routing_state, updated_at DESC, id);

CREATE TABLE preview_compose_projects (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  preview_key TEXT NOT NULL,
  state TEXT NOT NULL,
  active_generation_id TEXT REFERENCES preview_generations(id) ON DELETE SET NULL,
  pending_generation_id TEXT REFERENCES preview_generations(id) ON DELETE SET NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (task_id, preview_key)
) STRICT;

CREATE INDEX preview_compose_state_idx ON preview_compose_projects(state, updated_at, id);

CREATE TABLE preview_managed_environments (
  id TEXT PRIMARY KEY,
  preview_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX preview_environments_task_state_idx
  ON preview_managed_environments(task_id, state, updated_at DESC, id);
CREATE UNIQUE INDEX preview_environments_one_live_per_task_idx
  ON preview_managed_environments(task_id)
  WHERE state <> 'STOPPED';

CREATE TABLE preview_managed_resources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES preview_managed_environments(id) ON DELETE CASCADE,
  logical_resource_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  binding_id TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (environment_id, logical_resource_id)
) STRICT;

CREATE INDEX preview_resources_environment_state_idx
  ON preview_managed_resources(environment_id, state, updated_at DESC, id);
CREATE INDEX preview_resources_task_state_idx
  ON preview_managed_resources(task_id, state, updated_at DESC, id);

CREATE TABLE preview_generation_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES preview_generations(id) ON DELETE CASCADE,
  managed_resource_id TEXT NOT NULL REFERENCES preview_managed_resources(id) ON DELETE CASCADE,
  logical_resource_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (generation_id, managed_resource_id)
) STRICT;

CREATE INDEX preview_generation_attachments_generation_idx
  ON preview_generation_attachments(generation_id, attached_at, id);

CREATE TABLE preview_local_bindings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (task_id, attachment_id)
) STRICT;

CREATE INDEX preview_local_bindings_task_idx ON preview_local_bindings(task_id, id);

CREATE TABLE preview_native_resources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES preview_generations(id) ON DELETE CASCADE,
  logical_node_id TEXT NOT NULL,
  state TEXT NOT NULL,
  record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX preview_native_resources_generation_state_idx
  ON preview_native_resources(generation_id, state, updated_at DESC, id);

CREATE TABLE preview_node_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES preview_generations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (generation_id, node_id, attempt)
) STRICT;

CREATE INDEX preview_attempts_generation_state_idx
  ON preview_node_attempts(generation_id, state, attempt DESC, id);

CREATE TABLE preview_private_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL,
  managed_file_id TEXT NOT NULL UNIQUE REFERENCES managed_files(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, input_id, id)
) STRICT;

CREATE INDEX preview_private_revisions_owner_idx
  ON preview_private_revisions(task_id, input_id, created_at DESC, id);

CREATE TABLE preview_private_current (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES preview_private_revisions(id) ON DELETE RESTRICT,
  PRIMARY KEY (task_id, input_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE preview_private_references (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('GENERATION', 'MANAGED_RESOURCE')),
  owner_record_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES preview_private_revisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_record_id, revision_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX preview_private_references_revision_idx
  ON preview_private_references(revision_id, owner_kind, owner_record_id);
`;

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: 'initial-normalized-storage',
    sql: INITIAL_SCHEMA_SQL
  }
] as const;

export const APP_DATABASE_SCHEMA_VERSION =
  DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1]?.version ?? 0;

export function validateDatabaseMigrations(
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS
): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    if (!migration || migration.version !== expectedVersion) {
      throw new Error(`Database migrations must be contiguous from version 1; missing ${expectedVersion}.`);
    }
    if (!migration.name.trim()) {
      throw new Error(`Database migration ${migration.version} must have a name.`);
    }
    if (!migration.sql.trim()) {
      throw new Error(`Database migration ${migration.version} must have SQL.`);
    }
  }
}
