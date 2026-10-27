-- Trigram search over the original metadata. Chinese conversion happens at query time
-- and is never written back into these columns or the catalog tables.
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
    FROM identifiers AS i
    WHERE i.edition_id = e.id AND instr(lower(i.scheme), 'isbn') > 0
  ), '') AS isbn
FROM editions AS e
WHERE e.trashed_at IS NULL;

CREATE VIRTUAL TABLE edition_fts USING fts5(
  title,
  alternate_titles,
  authors,
  translators,
  series,
  tags,
  isbn,
  tokenize = 'trigram'
);

CREATE TRIGGER editions_ai_fts AFTER INSERT ON editions
BEGIN
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.id;
END;

CREATE TRIGGER editions_au_fts AFTER UPDATE ON editions
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.id;
END;

CREATE TRIGGER editions_ad_fts AFTER DELETE ON editions
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER alternate_titles_ai_fts AFTER INSERT ON alternate_titles
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER alternate_titles_au_fts AFTER UPDATE ON alternate_titles
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER alternate_titles_ad_fts AFTER DELETE ON alternate_titles
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = OLD.edition_id;
END;

CREATE TRIGGER edition_contributors_ai_fts AFTER INSERT ON edition_contributors
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER edition_contributors_au_fts AFTER UPDATE ON edition_contributors
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER edition_contributors_ad_fts AFTER DELETE ON edition_contributors
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = OLD.edition_id;
END;

CREATE TRIGGER tags_ai_fts AFTER INSERT ON tags
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER tags_au_fts AFTER UPDATE ON tags
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER tags_ad_fts AFTER DELETE ON tags
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = OLD.edition_id;
END;

CREATE TRIGGER identifiers_ai_fts AFTER INSERT ON identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER identifiers_au_fts AFTER UPDATE ON identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = NEW.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = NEW.edition_id;
END;

CREATE TRIGGER identifiers_ad_fts AFTER DELETE ON identifiers
BEGIN
  DELETE FROM edition_fts WHERE rowid = OLD.edition_id;
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id = OLD.edition_id;
END;

CREATE TRIGGER series_au_fts AFTER UPDATE OF name ON series
BEGIN
  DELETE FROM edition_fts WHERE rowid IN (SELECT id FROM editions WHERE series_id = NEW.id);
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id IN (SELECT id FROM editions WHERE series_id = NEW.id);
END;

CREATE TRIGGER persons_au_fts AFTER UPDATE OF name ON persons
BEGIN
  DELETE FROM edition_fts WHERE rowid IN (
    SELECT edition_id FROM edition_contributors WHERE person_id = NEW.id
  );
  INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
  SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
  FROM edition_search_doc
  WHERE edition_id IN (SELECT edition_id FROM edition_contributors WHERE person_id = NEW.id);
END;

INSERT INTO edition_fts(rowid, title, alternate_titles, authors, translators, series, tags, isbn)
SELECT edition_id, title, alternate_titles, authors, translators, series, tags, isbn
FROM edition_search_doc;
