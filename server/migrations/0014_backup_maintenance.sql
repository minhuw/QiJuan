-- Repository checks and restore tests share backup_jobs. SQLite cannot change
-- the kind CHECK in place, so the table is rebuilt. Transfer sizes are kept
-- when restic reports them. Secrets stay out of this database.

ALTER TABLE backup_settings ADD COLUMN check_interval_hours INTEGER NOT NULL DEFAULT 168
  CHECK (check_interval_hours >= 1 AND check_interval_hours <= 8760);
ALTER TABLE backup_settings ADD COLUMN next_check_at TEXT;

CREATE TABLE backup_jobs_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('backup', 'check', 'restore-test')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  scope TEXT NOT NULL,
  phase TEXT,
  reason TEXT,
  snapshot_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  bytes_added INTEGER,
  bytes_processed INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

INSERT INTO backup_jobs_next (
  id, kind, status, scope, phase, reason, snapshot_id, detail,
  bytes_added, bytes_processed, created_at, updated_at, started_at, finished_at
)
SELECT
  id, kind, status, scope, phase, reason, snapshot_id, detail,
  NULL, NULL, created_at, updated_at, started_at, finished_at
FROM backup_jobs;

DROP TABLE backup_jobs;
ALTER TABLE backup_jobs_next RENAME TO backup_jobs;

CREATE INDEX IF NOT EXISTS backup_jobs_status_idx ON backup_jobs (status, id);
CREATE INDEX IF NOT EXISTS backup_jobs_kind_idx ON backup_jobs (kind, id);

UPDATE sqlite_sequence
SET seq = (SELECT COALESCE(MAX(id), 0) FROM backup_jobs)
WHERE name = 'backup_jobs';
