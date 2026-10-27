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

The schedule is stored in SQLite. The in-process loop runs a due backup when it starts, including one that became due while QiJuan was stopped. It does not start a second backup, a repository check, a restore test, or a retention pass while one of those is already running. Import, rescan, metadata refresh, and the other library jobs wait while a backup task holds the process, and a backup waits while one of those jobs is running.

Retention defaults to 7 daily, 4 weekly, and 6 monthly snapshots. Those counts are editable. `restic forget` runs only after a backup that finished successfully. A failed backup does not forget snapshots, so the last successful snapshot stays. Deleted books remain in the snapshots that retention keeps; forgetting a snapshot is what removes them. If restic itself created a partial snapshot because a file could not be read, QiJuan forgets that partial snapshot only.

Do not put an S3 lifecycle expiration, a storage-class transition, or object lock on the bucket. Those rules delete or freeze objects the repository still needs, and they fight `restic forget`. The connection test reads the lifecycle and object-lock configuration and refuses the bucket when it finds those rules, or when the key is not allowed to read them. Aborting incomplete multipart uploads is fine. QiJuan does not create lifecycle rules of its own.

A network failure during upload is tried three times. A missing file, a changed file, a missing mount, or a wrong recovery password is not retried; the job fails and the last successful snapshot stays.

## Failures

The job is failed, with a reason, when:

- a selected managed file or indexed file cannot be read
- a managed blob, custom cover, or included indexed file no longer matches its catalog hash
- a selected indexed library root is missing
- the destination cannot be reached
- the restic process is killed or exits with an error

The reason says what to fix and that a retry is safe. When a file's bytes changed, the reason names that file. QiJuan does not update the catalog hash during backup. Starting another backup after the failure can succeed. A retry unlocks a stale restic lock left by an interrupted process.

## History, size, and checks

After a successful backup, QiJuan asks restic for the snapshot list and for `stats --mode raw-data`. The Backup screen shows that history, the repository size, and the last run's added and processed bytes when restic reported them. If restic does not report a number, the screen says it was not reported. The history is not a second copy of the secret keys.

An integrity check is `restic check`. It is scheduled after the first successful backup (the default interval is 168 hours) and can be run from the screen. Passing means the repository structure could be read. It does not restore a snapshot and does not show that a restore will succeed.

A restore test is separate. It restores the newest snapshot into a temporary directory, reads the manifest, and checks the database and managed files. It then deletes that directory. The library is not replaced. Use Restore on the same screen when you mean to replace this installation, and only after the preview.

The Dockerfile installs the pinned restic binary and checks its SHA-256 during the image build. That pin is the amd64 build. Set `QIJUAN_RESTIC_BIN` when you run QiJuan outside that image.
