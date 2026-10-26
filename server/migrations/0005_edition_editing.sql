CREATE TABLE IF NOT EXISTS field_locks (
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN (
    'title',
    'sort_title',
    'alternate_titles',
    'authors',
    'translators',
    'description',
    'series',
    'series_order',
    'publisher',
    'published_date',
    'language',
    'identifiers',
    'tags',
    'cover'
  )),
  locked_at TEXT NOT NULL,
  PRIMARY KEY (edition_id, field)
);

CREATE TABLE IF NOT EXISTS edition_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  matched_edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  CHECK (edition_id <> matched_edition_id),
  UNIQUE (edition_id, matched_edition_id)
);

CREATE INDEX IF NOT EXISTS edition_suggestions_matched_idx ON edition_suggestions (matched_edition_id);
CREATE INDEX IF NOT EXISTS edition_suggestions_library_idx ON edition_suggestions (library_id);

CREATE TABLE IF NOT EXISTS metadata_previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  proposal TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS metadata_previews_edition_idx ON metadata_previews (edition_id);
