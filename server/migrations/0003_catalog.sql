CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  sort_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (library_id, name)
);

CREATE TABLE IF NOT EXISTS editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_title TEXT NOT NULL,
  language TEXT,
  publisher TEXT,
  published_date TEXT,
  description TEXT,
  series_id INTEGER REFERENCES series(id) ON DELETE SET NULL,
  series_order REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT
);

CREATE TABLE IF NOT EXISTS alternate_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  title TEXT NOT NULL COLLATE NOCASE,
  sort_title TEXT,
  UNIQUE (edition_id, title)
);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sort_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edition_contributors (
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('author', 'translator')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (edition_id, person_id, role)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (edition_id, name)
);

CREATE TABLE IF NOT EXISTS identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL COLLATE NOCASE,
  value TEXT NOT NULL,
  UNIQUE (edition_id, scheme, value)
);

CREATE TABLE IF NOT EXISTS file_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf')),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  original_filename TEXT NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('managed', 'indexed')),
  relative_path TEXT NOT NULL CHECK (
    length(relative_path) > 0
    AND relative_path NOT LIKE '/%'
    AND relative_path NOT LIKE '%\\%'
  ),
  availability TEXT NOT NULL DEFAULT 'present' CHECK (availability IN ('present', 'missing')),
  trashed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS covers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL CHECK (
    length(relative_path) > 0
    AND relative_path NOT LIKE '/%'
    AND relative_path NOT LIKE '%\\%'
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS shelf_items (
  shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (shelf_id, edition_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS reading_queues (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS reading_statuses (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('want', 'reading', 'finished', 'on_hold')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL,
  locator TEXT NOT NULL CHECK (length(locator) > 0),
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL,
  locator TEXT NOT NULL CHECK (length(locator) > 0),
  quote TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL,
  locator TEXT NOT NULL CHECK (length(locator) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, edition_id)
);

CREATE INDEX IF NOT EXISTS editions_library_trashed_idx ON editions (library_id, trashed_at);
CREATE INDEX IF NOT EXISTS editions_series_id_idx ON editions (series_id);
CREATE INDEX IF NOT EXISTS alternate_titles_edition_id_idx ON alternate_titles (edition_id);
CREATE INDEX IF NOT EXISTS edition_contributors_person_id_idx ON edition_contributors (person_id);
CREATE INDEX IF NOT EXISTS tags_edition_id_idx ON tags (edition_id);
CREATE INDEX IF NOT EXISTS identifiers_edition_id_idx ON identifiers (edition_id);
CREATE INDEX IF NOT EXISTS identifiers_scheme_value_idx ON identifiers (scheme, value);
CREATE INDEX IF NOT EXISTS file_assets_edition_id_idx ON file_assets (edition_id);
CREATE INDEX IF NOT EXISTS file_assets_sha256_idx ON file_assets (sha256);
CREATE INDEX IF NOT EXISTS covers_edition_id_idx ON covers (edition_id);
CREATE INDEX IF NOT EXISTS covers_sha256_idx ON covers (sha256);
CREATE INDEX IF NOT EXISTS shelves_user_id_idx ON shelves (user_id);
CREATE INDEX IF NOT EXISTS shelf_items_edition_id_idx ON shelf_items (edition_id);
CREATE INDEX IF NOT EXISTS reading_queues_user_position_idx ON reading_queues (user_id, position);
CREATE INDEX IF NOT EXISTS bookmarks_user_edition_idx ON bookmarks (user_id, edition_id);
CREATE INDEX IF NOT EXISTS highlights_user_edition_idx ON highlights (user_id, edition_id);
CREATE INDEX IF NOT EXISTS notes_user_edition_idx ON notes (user_id, edition_id);
