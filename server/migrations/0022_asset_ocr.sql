-- Text recognition (OCR) of a PDF file: an administrator's request, its progress, and the
-- recognized copy. The copy is the same PDF with an invisible text layer added by OCRmyPDF,
-- stored as a content-addressed blob next to the original, which is never changed. The copy is
-- derived and can be made again, so backups leave it out; a row whose copy is missing after a
-- restore falls back to the original.

CREATE TABLE asset_ocr (
  asset_id INTEGER PRIMARY KEY REFERENCES file_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
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

CREATE INDEX asset_ocr_status_idx ON asset_ocr (status, requested_at);
CREATE INDEX asset_ocr_sha256_idx ON asset_ocr (sha256);
