-- Per-edition spelling. persons.name stays the first stored form and is shared.
ALTER TABLE edition_contributors ADD COLUMN display_name TEXT;

UPDATE edition_contributors
SET display_name = (
  SELECT persons.name
  FROM persons
  WHERE persons.id = edition_contributors.person_id
)
WHERE display_name IS NULL;
