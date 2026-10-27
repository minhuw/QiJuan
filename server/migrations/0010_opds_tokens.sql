-- OPDS clients authenticate with a per-client token. Only the SHA-256 hex digest is stored.
-- The account password is not a token. A revoked row rejects the next catalog request.
CREATE TABLE IF NOT EXISTS opds_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS opds_tokens_user_id_idx ON opds_tokens (user_id);
