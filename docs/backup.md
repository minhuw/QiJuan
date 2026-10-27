# Backup

QiJuan backups are restic repositories on an S3-compatible destination. Only an administrator can configure them. The server runs backup and retention in the same process as the library. It does not use a second queue.

The restic release is pinned in `server/restic-release.json` (version and SHA-256). Set `QIJUAN_RESTIC_BIN` to that binary, or install the same version as `restic` on `PATH`. The acceptance test downloads the official linux amd64 build and checks the checksum. A checksum mismatch fails the test; it is not skipped.

Live Cloudflare R2 was not tested. The tests use a local S3 server.

## Destination

In Backup, save:

- endpoint, with no path (for example `http://127.0.0.1:9000` or `https://accountid.r2.cloudflarestorage.com`)
- region
- path-style addressing
- bucket
- prefix (restic stores the repository under this prefix)
- access key and secret key

The Cloudflare R2 preset only fills three values: the endpoint `https://accountid.r2.cloudflarestorage.com`, region `auto`, and path-style addressing. Replace `accountid` with the Cloudflare account id. Then enter the bucket, prefix, and keys yourself. Do not point QiJuan at live R2 until you have tried that account yourself.

Connection test writes and deletes the objects restic needs, under the configured prefix: a single upload with Content-MD5, a list, a head, a get, a multipart upload, and a delete. If the bucket already exists, or creating it is denied, the test continues when listing that bucket succeeds. A key that can only write under the prefix is enough. The test then opens or creates the restic repository with the recovery password. It does not call Cloudflare.

Secrets stay in `backup/destination.json` and `backup/recovery-password` under the data directory (mode `0600`). They are not stored in SQLite. Logs redact recovery passwords, access keys, and secret keys.

## Recovery password

The recovery password is the restic repository password. Setup shows it once and offers `qijuan-recovery.txt`. Download that file and keep it outside the server. The server copy is only so later backups can run. If that file and your download are both lost, the repository cannot be opened.

## What a backup contains

A backup is a consistent copy made with SQLite's online backup API, plus:

- users and library grants
- shelves
- reading state and positions
- annotations (bookmarks, highlights, and notes)
- managed book blobs and custom covers, unless the run is metadata-only
- the application secret (`session.secret`)
- `recover.json`, with the storage layout and library map
- `manifest.json`, with the app version, schema version, storage map, and scope

Indexed folders are copied only when their libraries are explicitly selected. A metadata-only run does not include book files or indexed folders. Its manifest `scope` is `metadata-only`, and the Backup screen shows that same label.

## Schedule and retention

The schedule is stored in SQLite. The in-process loop runs a due backup when it starts, including one that became due while QiJuan was stopped. It does not start a second backup or a retention pass while one is already running.

Retention defaults to 7 daily, 4 weekly, and 6 monthly snapshots. Those counts are editable. `restic forget` runs only after a backup that finished successfully. A failed backup does not forget snapshots, so the last successful snapshot stays. If restic itself created a partial snapshot because a file could not be read, QiJuan forgets that partial snapshot only.

## Failures

The job is failed, with a reason, when:

- a selected managed file or indexed file cannot be read
- a selected indexed library root is missing
- the destination cannot be reached
- the restic process is killed or exits with an error

The reason says what to fix and that a retry is safe. Starting another backup after the failure can succeed. A retry unlocks a stale restic lock left by an interrupted process.
