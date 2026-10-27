-- Widen jobs.source. SQLite cannot drop a CHECK in place, so rebuild the table
-- and copy existing import rows. payload is the worker input. result is a small
-- JSON document the client reads from GET /api/jobs/:id.

CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'folder', 'lookup', 'apply', 'refresh', 'rescan')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  payload TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

INSERT INTO jobs_new (
  id, library_id, created_by, source, status, payload, result,
  created_at, updated_at, started_at, finished_at
)
SELECT
  id, library_id, created_by, source, status, NULL, NULL,
  created_at, updated_at, started_at, finished_at
FROM jobs;

CREATE TABLE job_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs_new(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'duplicate')),
  error TEXT,
  edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, position)
);

INSERT INTO job_items_new (
  id, job_id, position, filename, source_path, status, error,
  edition_id, asset_id, sha256, created_at, updated_at
)
SELECT
  id, job_id, position, filename, source_path, status, error,
  edition_id, asset_id, sha256, created_at, updated_at
FROM job_items;

DROP TABLE job_items;
DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE job_items_new RENAME TO job_items;

CREATE INDEX IF NOT EXISTS jobs_status_id_idx ON jobs (status, id);
CREATE INDEX IF NOT EXISTS jobs_library_id_idx ON jobs (library_id);
CREATE INDEX IF NOT EXISTS job_items_job_id_idx ON job_items (job_id, position);

UPDATE sqlite_sequence
SET seq = (SELECT COALESCE(MAX(id), 0) FROM jobs)
WHERE name = 'jobs';

UPDATE sqlite_sequence
SET seq = (SELECT COALESCE(MAX(id), 0) FROM job_items)
WHERE name = 'job_items';
