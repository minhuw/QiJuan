-- First library page: live editions in one library, ordered by sort title.
CREATE INDEX IF NOT EXISTS editions_library_sort_idx
ON editions (library_id, trashed_at, sort_title, id);
