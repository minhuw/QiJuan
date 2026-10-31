-- A private edition is never sent to the metadata assistant: no lookup, no agent run on upload.
-- job_items carries the import batch's choice until the file has an edition.

ALTER TABLE editions ADD COLUMN metadata_private INTEGER NOT NULL DEFAULT 0 CHECK (metadata_private IN (0, 1));
ALTER TABLE job_items ADD COLUMN metadata_private INTEGER NOT NULL DEFAULT 0 CHECK (metadata_private IN (0, 1));
