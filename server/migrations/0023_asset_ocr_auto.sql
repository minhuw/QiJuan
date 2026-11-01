-- Automatic OCR. The server checks each PDF once and remembers the answer:
--   not_needed: the PDF already has a text layer, so it is never recognized automatically;
--   off: an administrator removed its OCR, so it is not recognized again unless asked.
-- SQLite cannot widen a CHECK in place, so the table is rebuilt; it holds one row per PDF.

CREATE TABLE asset_ocr_next (
  asset_id INTEGER PRIMARY KEY REFERENCES file_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'not_needed', 'off')),
  languages TEXT NOT NULL,
  error TEXT,
  sha256 TEXT,
  bytes INTEGER,
  relative_path TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO asset_ocr_next SELECT * FROM asset_ocr;
DROP TABLE asset_ocr;
ALTER TABLE asset_ocr_next RENAME TO asset_ocr;

CREATE INDEX asset_ocr_status_idx ON asset_ocr (status, requested_at);
CREATE INDEX asset_ocr_sha256_idx ON asset_ocr (sha256);
