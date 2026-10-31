-- One metadata assistant run: what the model was given, each tool call and
-- result, and how it ended. Admins read it; readers never do. Rows older than
-- 30 days are pruned. Book text and the API key are never stored here.
-- job_item_id has no foreign key: job_items is rebuilt by table copy (0013), and
-- a reference to it would block that. Rows still go with their job via job_id.

CREATE TABLE metadata_trajectories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_item_id INTEGER,
  edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  preview_id INTEGER REFERENCES metadata_previews(id) ON DELETE SET NULL,
  model TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('accepted', 'failed', 'timeout', 'limit')),
  error TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE metadata_trajectory_steps (
  trajectory_id INTEGER NOT NULL REFERENCES metadata_trajectories(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'model', 'tool_call', 'tool_result', 'submit', 'end')),
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (trajectory_id, seq)
);

CREATE INDEX metadata_trajectories_job_idx ON metadata_trajectories (job_id, job_item_id);
CREATE INDEX metadata_trajectories_created_idx ON metadata_trajectories (created_at);
