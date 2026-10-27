# 栖卷 QiJuan

书有归处，人有闲读。

QiJuan is a self-hosted personal ebook library. One Node.js process serves the API and the built client.

## Install

From the repository root:

```bash
npm install
```

Requires Node.js 22 or newer.

## Migrate

Apply SQL migrations in `server/migrations` to the SQLite database under the data directory:

```bash
npm run migrate
```

If the database file already exists and a migration is pending, QiJuan copies it beside the database as a pre-migration backup before changing the schema. The server also migrates on startup.

## First run

When no administrator exists, the web UI shows setup instead of sign-in. Setup asks for an administrator username, a password, and a library name. It creates that administrator and one managed library inside the data directory, then starts a session. Setup is refused once an administrator exists. An administrator can create readers and grant or revoke libraries from Settings.

## Development

`npm run dev` starts the API server and the Vite client together:

```bash
npm run dev
```

- API and health check: http://127.0.0.1:8080/health
- Client (Vite): http://127.0.0.1:5173

Run these commands from the repository root so the default `./data` directory is created there.

## Production

```bash
npm run build
npm start
```

The production server listens on `QIJUAN_PORT` (default 8080) and serves `client/dist` when that build is present.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QIJUAN_DATA_DIR` | `./data` | Database, session secret, and other persistent files. Relative paths use the working directory. |
| `QIJUAN_PORT` | `8080` | HTTP port. |
| `QIJUAN_TRUST_PROXY` | unset (off) | `true` trusts the forwarding proxy. An integer trusts that many hops. Any other value is a proxy address or list passed to Fastify. |
| `QIJUAN_SESSION_SECRET` | persisted file | When unset, a secret is written to `session.secret` inside the data directory (mode `0600`) and reused. |
| `QIJUAN_LIBRARY_PATHS` | `<data dir>/library` | Book library locations, separated by the platform path delimiter (`:` on Linux). |
| `QIJUAN_MAX_UPLOAD_BYTES` | `134217728` (128 MiB) | Maximum size of one file in a multipart import. |
| `QIJUAN_OPEN_LIBRARY_ORIGIN` | `https://openlibrary.org` | Optional metadata provider. Browsing, opening a stored book, and saving progress do not call it. No backup destination is required. |

Secrets, cookies, passwords, and recovery passwords are redacted in logs.

## Docker

The image uses the multi-arch `node:22-bookworm` base, exposes port 8080, and checks `GET /health`. Compose runs a service named `qijuan` with a persistent data volume:

```bash
docker compose up --build
```

## Checks

```bash
npm run ci
npm run test:acceptance
```

`npm run ci` typechecks, runs the fast test suite, and builds the client and server. Acceptance tests cover backup, restore, and performance only, and do not run during `npm test`.

## Architecture

QiJuan runs as one Node.js process. The catalog lives in SQLite on the data volume, and background jobs run in-process (no separate queue or cache). Backup to restic comes later. Open Library is an optional metadata source, not required to keep or read a library.

## Library

Search matches title, alternate titles, authors, translators, series, tags, and ISBN. An ISBN matches with or without hyphens. Queries of three characters or more use an FTS5 trigram index that is rebuilt when those fields change. Shorter queries match the same fields with a substring comparison. A Chinese query is also searched in the other of Simplified or Traditional Chinese. Stored metadata is left in the script it was saved in.

The home screen shows continue reading from that user's position, recently added books, and that user's shelves. The same search can be shown as a cover grid or a compact list. Reading status, rating, favorite, shelves, and the queue belong to the signed-in user.

## OPDS

`GET /opds/catalog` is an OPDS 1.2 catalog. The client signs in with HTTP Basic: the QiJuan username and a revocable per-client token, not the account password. The feed lists only libraries that account can read. Reading-progress synchronization is not implemented. Details are in [docs/opds.md](docs/opds.md).

## Import

Upload EPUB and PDF files into a managed library, or import a directory that stays inside an indexed library root. The request only stores the uploads and enqueues a job. A loop in the same process claims the job. If the process stops while a job is running, that job is queued again on the next startup.

A batch keeps going when one file is malformed or has an unsupported extension. Byte-for-byte duplicates attach to the existing asset and do not create a second edition. A different file with a similar title becomes its own edition. The import screen shows queued, running, succeeded, and failed files, then a completion summary.

## Metadata

A book page edits title, alternate titles, sort title, authors, translators, description, series and series order, publisher, publication date, language, identifiers, and tags. Saving a field locks it. Replacing a cover stores a new image and does not change the book file. Rescan and metadata refresh skip locked fields, including the cover.

Batch edit sets language, publisher, tags, or series on several editions and locks those fields.

Open Library is optional. Lookup uses `https://openlibrary.org/search.json`, the ISBN API, and the Covers API, with a User-Agent identifying QiJuan and no API key. The preview marks locked fields as kept. Apply writes only the fields an administrator confirms, and only when they are not locked.

A new file with the same normalized title and main author, but different bytes, stays its own edition. QiJuan stores a suggestion that can be dismissed. It does not merge or delete either edition. A different language or translator is a different edition.
