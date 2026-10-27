-- Each bookmark, highlight, and note remembers the revision the client last saw.
-- A later write must name that revision; a stale body is not applied.
ALTER TABLE bookmarks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE highlights ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
