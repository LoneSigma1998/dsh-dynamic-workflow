/**
 * The `dwf_*` journal tables (ZCode `adapters/.../schema.baseline.sql`, Apache-2.0),
 * opened in the plugin's own SQLite file under `$DSH_HOME/state/dynamic-workflow/`.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS dwf_run (
  id text primary key,
  parent_session_id text,
  cwd text,
  name text,
  script_text text,
  script_hash text,
  args_json text,
  tool_call_id text,
  resumed_from text,
  caps_max_concurrency integer not null,
  spent_tokens integer not null default 0,
  status text not null check(status in ('pending','running','completed','failed','cancelled')),
  result_json text,
  failure_json text,
  time_created integer not null,
  time_updated integer not null
);
CREATE TABLE IF NOT EXISTS dwf_actor (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  name text,
  persona_json text,
  resolved_model text,
  session_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);
CREATE TABLE IF NOT EXISTS dwf_event (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  sequence integer not null,
  type text not null,
  payload_json text not null,
  time_created integer not null,
  unique(run_id, sequence)
);
CREATE TABLE IF NOT EXISTS dwf_node (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  kind text not null check(kind in ('ask','world-read','world-run','report','artifact')),
  actor_site_id text,
  actor_ordinal integer,
  actor_seq integer,
  input_hash text not null,
  input_json text,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  error_json text,
  stats_json text,
  message_boundary integer,
  artifact_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);
CREATE INDEX IF NOT EXISTS dwf_actor_run_idx on dwf_actor(run_id);
CREATE INDEX IF NOT EXISTS dwf_event_artifact_idx on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
CREATE INDEX IF NOT EXISTS dwf_node_artifact_idx on dwf_node(run_id, artifact_id);
CREATE INDEX IF NOT EXISTS dwf_node_run_idx on dwf_node(run_id);
CREATE INDEX IF NOT EXISTS dwf_run_cwd_idx on dwf_run(cwd, time_updated);
CREATE INDEX IF NOT EXISTS dwf_run_parent_idx on dwf_run(parent_session_id, time_updated);
-- Which process executes a run (DSH: several Hosts may share one DSH_HOME, e.g. desktop + CLI).
-- A cold-start orphan scan only interrupts runs whose owner is gone.
-- Files a subagent changed through file tools: the content before its first change and after its
-- latest one (NULL text + missing = the file did not exist; NULL text + too_large = not kept).
CREATE TABLE IF NOT EXISTS dsh_dwf_file_change (
  run_id text not null,
  session_id text not null,
  actor text,
  path text not null,
  before_text text,
  before_missing integer not null default 0,
  after_text text,
  after_missing integer not null default 0,
  too_large integer not null default 0,
  edits integer not null default 0,
  time_created integer not null,
  time_updated integer not null,
  primary key (run_id, session_id, path)
);
CREATE TABLE IF NOT EXISTS dsh_dwf_run_owner (
  run_id text primary key,
  pid integer not null,
  instance text not null,
  heartbeat integer not null
);
`

/** Open (creating when absent) the journal database with WAL and foreign keys. */
export function openJournalDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(JOURNAL_SCHEMA)
  return db
}
