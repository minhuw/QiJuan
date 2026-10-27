-- Backup schedules and job history. Destination secrets and the restic recovery
-- password are not stored here; they live outside the database.
CREATE TABLE IF NOT EXISTS backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1)),
  interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours >= 1 AND interval_hours <= 8760),
  next_run_at TEXT,
  retention_daily INTEGER NOT NULL DEFAULT 7 CHECK (retention_daily >= 0 AND retention_daily <= 10000),
  retention_weekly INTEGER NOT NULL DEFAULT 4 CHECK (retention_weekly >= 0 AND retention_weekly <= 10000),
  retention_monthly INTEGER NOT NULL DEFAULT 6 CHECK (retention_monthly >= 0 AND retention_monthly <= 10000),
  scope TEXT NOT NULL DEFAULT 'managed' CHECK (scope IN ('metadata-only', 'managed')),
  indexed_library_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

INSERT INTO backup_settings (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS backup_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind = 'backup'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  scope TEXT NOT NULL,
  phase TEXT,
  reason TEXT,
  snapshot_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS backup_jobs_status_idx ON backup_jobs (status, id);
