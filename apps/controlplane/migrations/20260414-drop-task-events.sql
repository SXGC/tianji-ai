-- Drop legacy task_events table (superseded by event_log).
DROP INDEX IF EXISTS idx_task_events_task;
DROP TABLE IF EXISTS task_events;
