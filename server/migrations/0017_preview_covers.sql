-- A metadata lookup preview may stage a cover image: the bytes the agent found (or Open
-- Library returned), stored as an immutable blob like a cover and shown to the admin before
-- anything is applied. The blob is released when the preview is replaced or applied, unless
-- a cover or file still references the same hash.

ALTER TABLE metadata_previews ADD COLUMN cover_sha256 TEXT;
ALTER TABLE metadata_previews ADD COLUMN cover_bytes INTEGER;
ALTER TABLE metadata_previews ADD COLUMN cover_media_type TEXT;
ALTER TABLE metadata_previews ADD COLUMN cover_relative_path TEXT;
ALTER TABLE metadata_previews ADD COLUMN cover_width INTEGER;
ALTER TABLE metadata_previews ADD COLUMN cover_height INTEGER;
ALTER TABLE metadata_previews ADD COLUMN cover_url TEXT;
ALTER TABLE metadata_previews ADD COLUMN cover_source_url TEXT;
ALTER TABLE metadata_previews ADD COLUMN cover_origin TEXT CHECK (cover_origin IN ('agent', 'open_library'));

CREATE INDEX metadata_previews_cover_idx ON metadata_previews (cover_sha256);
