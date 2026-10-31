-- External ratings read from public pages and APIs (Douban, Goodreads, Open Library, Google
-- Books). Each provider keeps its own scale; values are never normalized across providers.
-- One row per edition and provider. A provider that resolved to a page without a score is
-- 'no_rating' and keeps its URL.

CREATE TABLE edition_ratings (
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('douban', 'goodreads', 'open_library', 'google_books')),
  url TEXT,
  rating REAL,
  scale INTEGER NOT NULL CHECK (scale > 0),
  count INTEGER CHECK (count IS NULL OR count >= 0),
  status TEXT NOT NULL CHECK (status IN ('ok', 'no_rating', 'not_found', 'error')),
  error TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (edition_id, provider),
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= scale))
);

-- Editions whose ratings should be fetched. queued_at is the request time: a provider row
-- fetched before it is refreshed. not_before defers the edition while a provider backs off.
-- No foreign key: the identifier triggers below also fire while an edition is deleted, and the
-- worker drops rows whose edition is gone or trashed.
CREATE TABLE edition_ratings_queue (
  edition_id INTEGER PRIMARY KEY,
  queued_at TEXT NOT NULL,
  not_before TEXT
);

CREATE INDEX edition_ratings_queue_order_idx ON edition_ratings_queue (queued_at);

-- An edition that gains, loses, or changes an ISBN or a provider id is queued, whatever wrote it
-- (import, metadata apply, rescan, or a manual edit), inside the writer's own transaction.
CREATE TRIGGER edition_identifiers_ai_ratings AFTER INSERT ON edition_identifiers
WHEN NEW.scheme IN ('isbn', 'douban', 'olid', 'google_books')
BEGIN
  INSERT INTO edition_ratings_queue (edition_id, queued_at, not_before)
  VALUES (NEW.edition_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
  ON CONFLICT (edition_id) DO UPDATE SET queued_at = excluded.queued_at, not_before = NULL;
END;

CREATE TRIGGER edition_identifiers_au_ratings AFTER UPDATE ON edition_identifiers
WHEN NEW.scheme IN ('isbn', 'douban', 'olid', 'google_books') OR OLD.scheme IN ('isbn', 'douban', 'olid', 'google_books')
BEGIN
  INSERT INTO edition_ratings_queue (edition_id, queued_at, not_before)
  VALUES (NEW.edition_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
  ON CONFLICT (edition_id) DO UPDATE SET queued_at = excluded.queued_at, not_before = NULL;
END;

CREATE TRIGGER edition_identifiers_ad_ratings AFTER DELETE ON edition_identifiers
WHEN OLD.scheme IN ('isbn', 'douban', 'olid', 'google_books')
BEGIN
  INSERT INTO edition_ratings_queue (edition_id, queued_at, not_before)
  VALUES (OLD.edition_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
  ON CONFLICT (edition_id) DO UPDATE SET queued_at = excluded.queued_at, not_before = NULL;
END;
