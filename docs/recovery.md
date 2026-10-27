# Recovery

Restore is for an administrator. On a machine that still runs QiJuan, open Backup, enter the destination and the recovery password, list snapshots, and check one. QiJuan restores that snapshot into an empty staging directory, reads `manifest.json`, and refuses a snapshot from another app or a newer schema than this server. It opens the database and checks that managed books and covers referenced there are present in the snapshot, unless the manifest says `metadata-only`.

The check lists what activation will replace: the database (users, grants, shelves, annotations, and reading positions), the application secret, and, for a full backup, managed books and custom covers. Nothing is replaced until you confirm activation.

Test restore, on the same screen, is not this step. It restores into a temporary directory and leaves the current library in place. An integrity check does not restore anything. Neither one is a successful replacement of this installation.

Activation replaces the data directory's database and application secret, runs any pending migrations, and points managed libraries at the new data directory. A full snapshot also replaces managed books and custom covers. A metadata-only snapshot does not delete or replace those files, because that backup did not include them. Sign in again with an account from the snapshot. The temporary administrator created on an empty install is replaced by the snapshot.

## Fresh install

1. Install QiJuan and the pinned restic binary. Leave the data directory empty, or let first-run setup create a temporary administrator.
2. You need the destination endpoint, region, path-style flag, bucket, prefix, access key, secret key, and the recovery password from `qijuan-recovery.txt`. Those values are not recovered from the empty database.
3. Sign in as an administrator (the temporary one is enough).
4. Open Backup. Enter the destination. You do not need to run a backup.
5. Under Restore, enter the recovery password, list snapshots, check the snapshot, read the summary, confirm, and activate.
6. Sign in with a user from the snapshot. Managed books, shelves, highlights, and reading positions from that snapshot are back.

The acceptance test is this clean-install path against a local S3 server (MinIO). It does not call Cloudflare, and it does not build a Docker image. Live R2 is not claimed as tested.

## If QiJuan cannot start

Use the pinned restic binary and the recovery file. The file's `repository` line is the restic `-r` URL. `recovery-password` is `RESTIC_PASSWORD`. The access key and secret key are `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Set `AWS_DEFAULT_REGION` from the file. For path-style destinations, including the R2 preset, pass `-o s3.bucket-lookup=path`.

```bash
export RESTIC_PASSWORD='the recovery password from the file'
export AWS_ACCESS_KEY_ID='the access key'
export AWS_SECRET_ACCESS_KEY='the secret key'
export AWS_DEFAULT_REGION='auto'
restic -o s3.bucket-lookup=path -o s3.region="$AWS_DEFAULT_REGION" \
  -r 's3:https://accountid.r2.cloudflarestorage.com/bucket/prefix' \
  snapshots
restic -o s3.bucket-lookup=path -o s3.region="$AWS_DEFAULT_REGION" \
  -r 's3:https://accountid.r2.cloudflarestorage.com/bucket/prefix' \
  restore SNAPSHOT_ID --target /tmp/qijuan-restore
```

The target must be an empty directory you created. Inside it, find `manifest.json`, `qijuan.sqlite`, and `session.secret`. A full snapshot also contains `blobs/`. A metadata-only snapshot does not. Stop QiJuan. Replace the data directory's `qijuan.sqlite` (and its `-wal` and `-shm` files) with the restored database, and replace `session.secret` (mode `0600`). For a full snapshot, replace `blobs/` with the restored blobs. For a metadata-only snapshot, leave the existing `blobs/` directory in place. Start QiJuan again. Managed library folders are recreated under the data directory; indexed folders are only in the snapshot when they were selected, under `indexed/<library id>/`.

Keep the recovery file outside the server. It is not in the SQLite database.
