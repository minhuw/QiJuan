CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'folder')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS jobs_status_id_idx ON jobs (status, id);
CREATE INDEX IF NOT EXISTS jobs_library_id_idx ON jobs (library_id);
CREATE INDEX IF NOT EXISTS job_items_job_id_idx ON job_items (job_id, position);
