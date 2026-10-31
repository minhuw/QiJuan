-- Identifiers with provenance, identifier-based import merging, and trajectory notes.
--
-- edition_identifiers replaces identifiers. Every old row is copied. Scheme names
-- are lowercased and common aliases mapped (isbn13 -> isbn). Valid ISBNs become
-- ISBN-13 (ISBN-10 converted), DOIs lose their resolver prefix and are
-- lowercased. A value that does not validate is kept as it was. Rows that
-- normalize to an identifier the edition already has collapse into one.
--
-- Provenance of old rows is inferred: 'manual' when the edition's identifiers
-- were locked by an edit, 'agent' for editions created by an upload job, and
-- 'embedded' otherwise. created_at is the edition's.
--
-- Existing editions are never merged here. Live editions in one library that
-- share an identifier whose match would merge an import get a similar-editions
-- suggestion instead.

CREATE TABLE edition_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL CHECK (length(scheme) BETWEEN 1 AND 40),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
  source TEXT NOT NULL CHECK (source IN ('embedded', 'agent', 'manual')),
  source_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (edition_id, scheme, value)
);

CREATE INDEX edition_identifiers_lookup_idx ON edition_identifiers (scheme, value);
CREATE INDEX edition_identifiers_edition_idx ON edition_identifiers (edition_id);

WITH
raw AS (
  SELECT
    i.id,
    i.edition_id,
    CASE lower(trim(i.scheme))
      WHEN 'isbn10' THEN 'isbn' WHEN 'isbn13' THEN 'isbn' WHEN 'isbn-10' THEN 'isbn'
      WHEN 'isbn-13' THEN 'isbn' WHEN 'isbn_10' THEN 'isbn' WHEN 'isbn_13' THEN 'isbn'
      WHEN 'eissn' THEN 'issn' WHEN 'oclcnum' THEN 'oclc' WHEN 'worldcat' THEN 'oclc'
      WHEN 'openlibrary' THEN 'olid' WHEN 'open_library' THEN 'olid'
      WHEN 'googlebooks' THEN 'google_books' WHEN 'google-books' THEN 'google_books'
      ELSE lower(trim(i.scheme))
    END AS scheme,
    trim(i.value) AS value
  FROM identifiers AS i
),
isbn AS (
  SELECT
    id,
    upper(replace(replace(replace(replace(
      CASE
        WHEN lower(value) LIKE 'urn:isbn:%' THEN substr(value, 10)
        WHEN lower(value) LIKE 'isbn:%' THEN substr(value, 6)
        ELSE value
      END, '-', ''), ' ', ''), char(8211), ''), char(8212), '')) AS c
  FROM raw
  WHERE scheme = 'isbn'
),
isbn_valid AS (
  SELECT
    id,
    CASE
      WHEN length(c) = 13 AND c GLOB '97[89]*' AND c NOT GLOB '*[^0-9]*'
        AND (
          CAST(substr(c, 1, 1) AS INTEGER) + 3 * CAST(substr(c, 2, 1) AS INTEGER)
          + CAST(substr(c, 3, 1) AS INTEGER) + 3 * CAST(substr(c, 4, 1) AS INTEGER)
          + CAST(substr(c, 5, 1) AS INTEGER) + 3 * CAST(substr(c, 6, 1) AS INTEGER)
          + CAST(substr(c, 7, 1) AS INTEGER) + 3 * CAST(substr(c, 8, 1) AS INTEGER)
          + CAST(substr(c, 9, 1) AS INTEGER) + 3 * CAST(substr(c, 10, 1) AS INTEGER)
          + CAST(substr(c, 11, 1) AS INTEGER) + 3 * CAST(substr(c, 12, 1) AS INTEGER)
          + CAST(substr(c, 13, 1) AS INTEGER)
        ) % 10 = 0
        THEN c
      WHEN length(c) = 10 AND substr(c, 1, 9) NOT GLOB '*[^0-9]*' AND substr(c, 10, 1) GLOB '[0-9X]'
        AND (
          10 * CAST(substr(c, 1, 1) AS INTEGER) + 9 * CAST(substr(c, 2, 1) AS INTEGER)
          + 8 * CAST(substr(c, 3, 1) AS INTEGER) + 7 * CAST(substr(c, 4, 1) AS INTEGER)
          + 6 * CAST(substr(c, 5, 1) AS INTEGER) + 5 * CAST(substr(c, 6, 1) AS INTEGER)
          + 4 * CAST(substr(c, 7, 1) AS INTEGER) + 3 * CAST(substr(c, 8, 1) AS INTEGER)
          + 2 * CAST(substr(c, 9, 1) AS INTEGER)
          + CASE substr(c, 10, 1) WHEN 'X' THEN 10 ELSE CAST(substr(c, 10, 1) AS INTEGER) END
        ) % 11 = 0
        THEN '978' || substr(c, 1, 9) || ((10 - (
          38 + 3 * CAST(substr(c, 1, 1) AS INTEGER) + CAST(substr(c, 2, 1) AS INTEGER)
          + 3 * CAST(substr(c, 3, 1) AS INTEGER) + CAST(substr(c, 4, 1) AS INTEGER)
          + 3 * CAST(substr(c, 5, 1) AS INTEGER) + CAST(substr(c, 6, 1) AS INTEGER)
          + 3 * CAST(substr(c, 7, 1) AS INTEGER) + CAST(substr(c, 8, 1) AS INTEGER)
          + 3 * CAST(substr(c, 9, 1) AS INTEGER)
        ) % 10) % 10)
      ELSE NULL
    END AS isbn13
  FROM isbn
),
doi AS (
  SELECT
    id,
    lower(
      CASE
        WHEN lower(value) LIKE 'https://doi.org/%' THEN substr(value, 17)
        WHEN lower(value) LIKE 'http://doi.org/%' THEN substr(value, 16)
        WHEN lower(value) LIKE 'https://dx.doi.org/%' THEN substr(value, 20)
        WHEN lower(value) LIKE 'http://dx.doi.org/%' THEN substr(value, 19)
        WHEN lower(value) LIKE 'urn:doi:%' THEN substr(value, 9)
        WHEN lower(value) LIKE 'doi:%' THEN trim(substr(value, 5))
        ELSE value
      END
    ) AS d
  FROM raw
  WHERE scheme = 'doi'
),
normalized AS (
  SELECT
    r.id,
    r.edition_id,
    r.scheme,
    CASE
      WHEN r.scheme = 'isbn' AND iv.isbn13 IS NOT NULL THEN iv.isbn13
      WHEN r.scheme = 'doi' AND d.d LIKE '10.%/%' THEN d.d
      ELSE r.value
    END AS value
  FROM raw AS r
  LEFT JOIN isbn_valid AS iv ON iv.id = r.id
  LEFT JOIN doi AS d ON d.id = r.id
)
INSERT OR IGNORE INTO edition_identifiers (edition_id, scheme, value, source, source_url, created_at)
SELECT
  n.edition_id,
  n.scheme,
  n.value,
  CASE
    WHEN EXISTS (SELECT 1 FROM field_locks fl WHERE fl.edition_id = n.edition_id AND fl.field = 'identifiers') THEN 'manual'
    WHEN EXISTS (
      SELECT 1 FROM job_items ji JOIN jobs j ON j.id = ji.job_id
      WHERE ji.edition_id = n.edition_id AND j.source = 'upload'
    ) THEN 'agent'
    ELSE 'embedded'
  END,
  NULL,
  e.created_at
FROM normalized AS n
JOIN editions AS e ON e.id = n.edition_id
WHERE length(n.scheme) BETWEEN 1 AND 40 AND length(n.value) BETWEEN 1 AND 500
ORDER BY n.id;

-- Search reads identifiers through edition_search_doc. Rebuild it on the new table.
DROP TRIGGER IF EXISTS identifiers_ai_fts;
DROP TRIGGER IF EXISTS identifiers_au_fts;
DROP TRIGGER IF EXISTS identifiers_ad_fts;
DROP TABLE identifiers;
DROP VIEW edition_search_doc;

CREATE VIEW edition_search_doc AS
SELECT
  e.id AS edition_id,
  e.title AS title,
  COALESCE((
    SELECT group_concat(a.title, ' ')
    FROM alternate_titles AS a
    WHERE a.edition_id = e.id
  ), '') AS alternate_titles,
  COALESCE((
    SELECT group_concat(COALESCE(ec.display_name, p.name), ' ')
    FROM edition_contributors AS ec
    JOIN persons AS p ON p.id = ec.person_id
    WHERE ec.edition_id = e.id AND ec.role = 'author'
  ), '') AS authors,
  COALESCE((
    SELECT group_concat(COALESCE(ec.display_name, p.name), ' ')
    FROM edition_contributors AS ec
    JOIN persons AS p ON p.id = ec.person_id
    WHERE ec.edition_id = e.id AND ec.role = 'translator'
  ), '') AS translators,
  COALESCE((
    SELECT s.name FROM series AS s WHERE s.id = e.series_id
  ), '') AS series,
  COALESCE((
    SELECT group_concat(t.name, ' ')
    FROM tags AS t
    WHERE t.edition_id = e.id
  ), '') AS tags,
  COALESCE((
    SELECT group_concat(
      lower(replace(replace(replace(replace(i.value, '-', ''), ' ', ''), char(8211), ''), char(8212), '')),
      ' '
    )
    FROM edition_identifiers AS i
    WHERE i.edition_id = e.id AND instr(lower(i.scheme), 'isbn') > 0
  ), '') AS isbn
FROM editions AS e
WHERE e.trashed_at IS NULL;

CREATE TRIGGER edition_identifiers_ai_fts AFTER INSERT ON edition_identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER edition_identifiers_au_fts AFTER UPDATE ON edition_identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER edition_identifiers_ad_fts AFTER DELETE ON edition_identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = OLD.edition_id;
END;

DELETE FROM edition_fts;
INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
FROM edition_search_doc;

-- Same-identifier pairs among existing editions become suggestions, not merges.
INSERT OR IGNORE INTO edition_suggestions (library_id, edition_id, matched_edition_id, created_at)
SELECT DISTINCT a.library_id, a.id, b.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM edition_identifiers AS ia
JOIN edition_identifiers AS ib
  ON ib.scheme = ia.scheme AND ib.value = ia.value AND ib.edition_id < ia.edition_id
JOIN editions AS a ON a.id = ia.edition_id
JOIN editions AS b ON b.id = ib.edition_id
WHERE a.library_id = b.library_id
  AND a.trashed_at IS NULL
  AND b.trashed_at IS NULL
  AND ia.scheme IN ('isbn', 'issn', 'doi', 'oclc', 'lccn', 'olid', 'google_books', 'douban');

-- Job items gain a needs_confirmation state. candidate_edition_id is the edition
-- an incoming file matched by identifier; conflicts lists why it was not merged
-- (JSON array). pending keeps an upload's agent proposal until an admin decides;
-- resolution is that decision. merged marks a file that joined an existing edition.

CREATE TABLE job_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'duplicate', 'needs_confirmation')),
  error TEXT,
  edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL,
  sha256 TEXT,
  candidate_edition_id INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  conflicts TEXT,
  pending TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('merge', 'separate')),
  merged INTEGER NOT NULL DEFAULT 0 CHECK (merged IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, position)
);

INSERT INTO job_items_new (
  id, job_id, position, filename, source_path, status, error,
  edition_id, asset_id, sha256, created_at, updated_at
)
SELECT
  id, job_id, position, filename, source_path, status, error,
  edition_id, asset_id, sha256, created_at, updated_at
FROM job_items;

DROP TABLE job_items;
ALTER TABLE job_items_new RENAME TO job_items;
CREATE INDEX IF NOT EXISTS job_items_job_id_idx ON job_items (job_id, position);

UPDATE sqlite_sequence
SET seq = (SELECT COALESCE(MAX(id), 0) FROM job_items)
WHERE name = 'job_items';

-- Trajectories gain a 'note' step: for example, identifiers dropped as invalid.

CREATE TABLE metadata_trajectory_steps_new (
  trajectory_id INTEGER NOT NULL REFERENCES metadata_trajectories(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'model', 'tool_call', 'tool_result', 'submit', 'note', 'end')),
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (trajectory_id, seq)
);

INSERT INTO metadata_trajectory_steps_new (trajectory_id, seq, kind, created_at, data)
SELECT trajectory_id, seq, kind, created_at, data FROM metadata_trajectory_steps;

DROP TABLE metadata_trajectory_steps;
ALTER TABLE metadata_trajectory_steps_new RENAME TO metadata_trajectory_steps;
