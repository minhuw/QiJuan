-- The catalogue orders by a sort key derived from sort_title (see server/src/sort-key.ts): Chinese
-- characters carry their pinyin initial, so Chinese and Latin titles share one A–Z. SQL cannot
-- compute pinyin, so the server fills the key for existing editions at start ('' until then)
-- and keeps it with sort_title on every write.

ALTER TABLE editions ADD COLUMN sort_key TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS editions_library_sort_idx;
CREATE INDEX editions_library_sort_idx ON editions (library_id, trashed_at, sort_key, id);
