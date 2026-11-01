-- How far a reader is in a book, for the Reading tab: a fraction from 0 to 1, and for PDFs the
-- page and page count. The reader sends them with each saved position; NULL until then.

ALTER TABLE reading_positions ADD COLUMN progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1));
ALTER TABLE reading_positions ADD COLUMN page INTEGER CHECK (page IS NULL OR page >= 1);
ALTER TABLE reading_positions ADD COLUMN page_count INTEGER CHECK (page_count IS NULL OR page_count >= 1);
