# Upgrades and migrations

Schema changes are SQL files in `server/migrations`, applied in filename order. Apply them with:

```bash
npm run migrate
```

The server runs the same step when it starts, before it listens. A migration that is already recorded in `schema_migrations` is not applied again.

The schema version stored in a backup manifest is the name of the latest migration file, for example `0013_job_sources.sql`. Restore refuses a snapshot whose schema version this server does not include, and a snapshot newer than this server. Upgrade QiJuan before restoring that snapshot. See [recovery.md](recovery.md).

## Pre-migration copy

If the database file already exists and at least one migration is pending, QiJuan copies that file beside the database before it changes the schema. The copy is named:

```text
qijuan.sqlite.<timestamp>.pre-migration
```

The timestamp is UTC, with `:` and `.` replaced by `-`. It sits in the same directory as `qijuan.sqlite`. When a `-wal` file is present, QiJuan runs `wal_checkpoint(TRUNCATE)` first, then copies the database file. The copy is the database from before this upgrade. It does not contain the migrations that are about to run.

`npm run migrate` prints `Pre-migration backup: <path>` when it made that copy. Startup logs the same path as `wrote pre-migration backup`.

A database file that did not exist yet is not copied. There was no previous file to keep.

Each pending file then runs in its own transaction. Its name is inserted into `schema_migrations` only if that file finishes. Later files still run. A later failure leaves the earlier files of this upgrade committed, and leaves the pre-migration copy untouched.

## If an upgrade fails

The process stops with `Migration <name> failed: ...`. A failed startup does not stay up and serve the half-migrated database.

When a pre-migration copy exists:

1. Stop QiJuan if it is still running.
2. Leave the `.pre-migration` file where it is. Do not delete it.
3. Move `qijuan.sqlite`, `qijuan.sqlite-wal`, and `qijuan.sqlite-shm` out of the data directory.
4. Copy the `.pre-migration` file back to `qijuan.sqlite`.
5. Start the previous QiJuan build, which matches that database. Or fix the failing migration and run `npm run migrate` again against a spare copy of the file, not against the only backup.
6. After the upgraded server has started, and you have another copy of the data, you can remove the `.pre-migration` file.

The copy is the state from before the upgrade. It is not a merge. Do not copy it over a database that already has newer writes you need to keep.

If the data directory was empty and the first migration failed, there is no pre-migration copy. Delete the partial `qijuan.sqlite` and any `-wal` or `-shm` file, then start again.

Taking a restic backup before an upgrade is separate from this copy. The copy is local and happens only when a migration is about to run. Retention of those restic snapshots is described in [backup.md](backup.md).
