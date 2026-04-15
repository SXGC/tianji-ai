/**
 * SQLite schema definitions for controlplane.
 *
 * 所有时间字段为 unix 毫秒（INTEGER）。
 * 设计文档：第 9 节。
 *
 * @module db/schema
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK(status IN ('online', 'offline')),
  execution_state TEXT NOT NULL DEFAULT 'idle'
    CHECK(execution_state IN ('idle', 'busy')),
  access_token_hash TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  enrollment_token TEXT NOT NULL REFERENCES enrollment_tokens(token),
  pid INTEGER,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('native', 'third-party')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, agent_id)
);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'leased', 'running', 'completed', 'failed', 'observation_lost')),
  leased_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commands_node_state ON commands(node_id, state);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'observation_lost')),
  latest_run_id TEXT,
  failure_reason TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  agent_id TEXT NOT NULL,
  title TEXT,
  created_by TEXT NOT NULL CHECK(created_by IN ('user', 'task')),
  last_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(node_id, agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_sessions (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  attached_at INTEGER NOT NULL,
  attached_by TEXT NOT NULL CHECK(attached_by IN ('user', 'agent')),
  PRIMARY KEY (task_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(session_id, attached_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('lifecycle', 'agent')),
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, sequence)
);

CREATE TABLE IF NOT EXISTS event_log (
  event_id       TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id   TEXT,
  sequence       INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  source_json    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_event_log_correlation ON event_log(correlation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_aggregate ON event_log(aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_occurred_at ON event_log(occurred_at);
`
