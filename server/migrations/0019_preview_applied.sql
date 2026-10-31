-- A lookup preview is pending until an admin applies or dismisses it. Applying marks it here;
-- dismissing deletes the row. A verified cover may already be written to a coverless edition
-- when the preview is created, without marking the preview applied.

ALTER TABLE metadata_previews ADD COLUMN applied_at TEXT;
