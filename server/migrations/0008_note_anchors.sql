-- Notes taken while reading are anchored to an EPUB CFI, like highlights.
-- Older notes stay valid with a null locator.
ALTER TABLE notes ADD COLUMN asset_id INTEGER REFERENCES file_assets(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN locator TEXT CHECK (locator IS NULL OR length(locator) > 0);
