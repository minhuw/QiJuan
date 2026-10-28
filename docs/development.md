# Development

QiJuan is one Node.js process. Fastify serves the API and, after a production build, the client. The client is Vite and React. The catalog is SQLite through better-sqlite3 and Drizzle. Background import, metadata agent lookups, refresh, rescan, and backup jobs run in that same process. There is no Redis, Postgres, or second service.

Docker is not required to develop, test, or run QiJuan.

## Requirements

Node.js 22 or newer, and npm. The repository is an npm workspaces project named `qijuan`, with workspaces `server` and `client`.

## Setup

From the repository root:

```bash
npm install
npm run migrate
```

`npm run migrate` applies the SQL files in `server/migrations` to the SQLite database in the data directory. The default data directory is `./data`, resolved from the working directory. Run the commands from the repository root so that directory is created here. `QIJUAN_DATA_DIR` selects another directory.

| Variable | Default | Use |
| --- | --- | --- |
| `QIJUAN_DATA_DIR` | `./data` | Database, session secret, books, backup settings, metadata agent settings. |
| `QIJUAN_PORT` | `8080` | HTTP port. |
| `QIJUAN_TRUST_PROXY` | off | `true`, a hop count, or a proxy address. |
| `QIJUAN_SESSION_SECRET` | `session.secret` in the data directory | Set this only to supply your own. |
| `QIJUAN_LIBRARY_PATHS` | `<data dir>/library` | Extra library roots, separated by `:` on Linux. |
| `QIJUAN_MAX_UPLOAD_BYTES` | 128 MiB | One file in a multipart import. |
| `QIJUAN_OPEN_LIBRARY_ORIGIN` | `https://openlibrary.org` | Search and record origin for the metadata agent's Open Library tools. Folder imports do not use it. |
| `QIJUAN_RESTIC_BIN` | `restic` on `PATH` | The Docker image already installs the pinned binary. |

Passwords, backup credentials, and the metadata agent's API key are not written to logs.

Uploading books requires the metadata agent. An administrator configures it under **Settings** -> **Metadata agent** with a base URL, a model, and optionally an API key. Save at least the base URL and model before the first upload; a local server may need no key. Folder imports on an indexed library use embedded metadata and do not need the agent. The configuration is stored in `<data dir>/metadata-assistant.json` with file mode `0600`, not in SQLite. The settings API returns only a masked key hint. See [metadata.md](metadata.md) for configuration examples, the fields sent to the model, the three allowed tools, the bounds, and the rejection path.

On first launch, when no administrator exists, the web UI asks for an administrator username, a password, and a library name.

## Run

```bash
npm run dev
```

This starts the API and the Vite client together.

- API and health check: http://127.0.0.1:8080/health
- Client: http://127.0.0.1:5173

The Vite server proxies `/api` and `/health` to the API.

Production, still one process:

```bash
npm run build
npm start
```

`npm start` listens on `QIJUAN_PORT` (default 8080) and serves `client/dist` when that build exists.

## Checks

```bash
npm run ci
npm run test:acceptance
```

`npm run ci` typechecks, runs the fast test suite, and builds the client and server. `npm test` does not run `server/test/acceptance/`. Acceptance covers backup, restore, and the 10,000-edition performance check. That check rewrites [performance.md](performance.md) with the timings, the dataset, the Node.js version, and `process.arch`.

GitHub Actions runs the same `npm run ci` command, then builds the amd64 image. It pushes that image to GHCR only for a branch push, a `v*.*.*` tag, or a manual run. Pull requests do not push.

The metadata agent tests stub the model transport and Open Library. They do not call a live model provider, so no API key or local model server is needed for the test suite.

Screenshots of the library, a book, the EPUB reader, and backup, at 1280, 768, and 390 pixels wide, are in [screenshots/](screenshots/).

## Further reading

Migrations and a failed upgrade: [upgrades.md](upgrades.md). The metadata agent: [metadata.md](metadata.md). Backup and restore: [backup.md](backup.md) and [recovery.md](recovery.md). What this version does not do: [limitations.md](limitations.md).
