import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { R2_PRESET } from '../src/backup/model.js';
import { readResticRelease, type ResticRunResult, type ResticRunner } from '../src/backup/restic-run.js';
import { release, tryAcquire } from '../src/work-gate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const recoveryPassword = 'phrase-kept-outside-sqlite-9f3a';
const secretKey = 'aws-secret-key-value';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function result(partial: Partial<ResticRunResult> & Pick<ResticRunResult, 'code'>): ResticRunResult {
  return { signal: null, stdout: '', stderr: '', ...partial };
}

async function startApp(runner: ResticRunner, pollMs = 20) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false, restic: runner, backupPollMs: pollMs });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return { app, config, cookie: cookieFrom(setup), libraryId: setup.json().library.id as number };
}

async function configure(app: Awaited<ReturnType<typeof buildApp>>, cookie: string) {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/backup/destination',
    headers: { cookie },
    payload: {
      preset: 'custom',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      pathStyle: true,
      bucket: 'qijuan-backups',
      prefix: 'library',
      accessKeyId: 'backup-access-key',
      secretAccessKey: secretKey,
    },
  });
  expect(saved.statusCode).toBe(200);
  const recovery = await app.inject({
    method: 'POST',
    url: '/api/backup/recovery',
    headers: { cookie },
    payload: { password: recoveryPassword },
  });
  expect(recovery.statusCode).toBe(201);
  expect(recovery.json().recoveryPassword).toBe(recoveryPassword);
}

async function waitJob(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  status: 'succeeded' | 'failed',
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const job = response.json().job as { status: string; scope: string; reason: string | null; phase: string | null } | null;
    if (job && job.status === status) return { body: response.json(), job };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backup did not reach ${status}`);
}

async function waitStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  ready: (body: {
    integrityCheck?: { status?: string | null; reason?: string | null };
    restoreTest?: { status?: string | null; reason?: string | null };
    lastSuccess?: { snapshotId?: string | null };
  }) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/api/backup', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('backup status did not become ready');
}

describe('backup pin and screen data', () => {
  it('pins a restic version and sha256', () => {
    const release = readResticRelease();
    expect(release.version).toBe('0.19.1');
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.url).toContain(`v${release.version}`);
  });

  it('fills the R2 preset and keeps the recovery password out of sqlite', async () => {
    const calls: string[][] = [];
    const runner: ResticRunner = {
      async run(args) {
        calls.push(args);
        if (args.includes('snapshots')) return result({ code: 0, stdout: '[]' });
        if (args.includes('init')) return result({ code: 0, stdout: 'created' });
        return result({ code: 0 });
      },
    };
    const started = await startApp(runner);
    const preset = await started.app.inject({
      method: 'PUT',
      url: '/api/backup/destination',
      headers: { cookie: started.cookie },
      payload: {
        preset: 'r2',
        bucket: 'qijuan-backups',
        prefix: 'library',
        accessKeyId: 'backup-access-key',
        secretAccessKey: secretKey,
      },
    });
    expect(preset.statusCode).toBe(200);
    expect(preset.json().destination).toMatchObject({
      preset: 'r2',
      endpoint: R2_PRESET.endpoint,
      region: 'auto',
      pathStyle: true,
      secretConfigured: true,
    });
    expect(JSON.stringify(preset.json())).not.toContain(secretKey);

    const recovery = await started.app.inject({
      method: 'POST',
      url: '/api/backup/recovery',
      headers: { cookie: started.cookie },
      payload: { password: recoveryPassword },
    });
    expect(recovery.json().recoveryPassword).toBe(recoveryPassword);
    const status = await started.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie: started.cookie } });
    expect(status.statusCode).toBe(200);
    const body = status.body;
    expect(body).not.toContain(recoveryPassword);
    expect(body).not.toContain(secretKey);
    expect(status.json().schedule).toMatchObject({ retentionDaily: 7, retentionWeekly: 4, retentionMonthly: 6 });
    expect(status.json().r2Preset).toEqual({ endpoint: R2_PRESET.endpoint, region: 'auto', pathStyle: true });

    const download = await started.app.inject({
      method: 'GET',
      url: '/api/backup/recovery-file',
      headers: { cookie: started.cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('qijuan-recovery.txt');
    expect(download.body).toContain(recoveryPassword);
    expect(download.body).toContain('s3:https://accountid.r2.cloudflarestorage.com/qijuan-backups/library');

    const database = readFileSync(started.config.databasePath);
    expect(database.includes(recoveryPassword)).toBe(false);
    expect(database.includes(secretKey)).toBe(false);
    const wal = path.join(started.config.dataDir, 'qijuan.sqlite-wal');
    try {
      expect(readFileSync(wal).includes(recoveryPassword)).toBe(false);
      expect(readFileSync(wal).includes(secretKey)).toBe(false);
    } catch {
      // No WAL pages were written.
    }
    expect(calls).toEqual([]);

    const reader = await started.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'reader', password },
    });
    expect(reader.statusCode).toBe(201);
    const login = await started.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'reader', password },
    });
    const forbidden = await started.app.inject({
      method: 'GET',
      url: '/api/backup',
      headers: { cookie: cookieFrom(login) },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('backup jobs', () => {
  it('does not retain after a failed or interrupted backup, and a retry can succeed', async () => {
    const calls: string[][] = [];
    let mode: 'fail' | 'kill' | 'ok' | 'warn' = 'fail';
    const runner: ResticRunner = {
      async run(args) {
        calls.push(args);
        if (args.includes('backup') && mode === 'fail') return result({ code: 1, stderr: 'connection refused' });
        if (args.includes('backup') && mode === 'kill') return result({ code: null, signal: 'SIGKILL' });
        if (args.includes('backup') && mode === 'warn') {
          return result({
            code: 3,
            stdout:
              '{"message_type":"summary","snapshot_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}\n{"message_type":"exit_error","code":3,"message":"could not read selected file"}\n',
          });
        }
        if (args.includes('backup')) {
          return result({
            code: 0,
            stdout:
              '{"message_type":"summary","snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n',
          });
        }
        if (args.includes('snapshots')) return result({ code: 0, stdout: '[]' });
        return result({ code: 0 });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);

    const failed = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    expect(failed.statusCode).toBe(202);
    const failure = await waitJob(started.app, started.cookie, 'failed');
    expect(failure.job.reason).toMatch(/destination/i);
    expect(failure.job.reason).toMatch(/Tried 3 times/);
    expect(failure.job.reason).toMatch(/last successful snapshot/i);
    expect(calls.filter((args) => args.includes('backup'))).toHaveLength(3);
    expect(calls.some((args) => args.includes('forget'))).toBe(false);

    mode = 'kill';
    const again = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    expect(again.statusCode).toBe(202);
    const killed = await waitJob(started.app, started.cookie, 'failed');
    expect(killed.job.reason).toMatch(/interrupted/i);
    expect(calls.some((args) => args.includes('forget'))).toBe(false);

    mode = 'warn';
    await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    const warned = await waitJob(started.app, started.cookie, 'failed');
    expect(warned.job.reason).toMatch(/could not read|selected file/i);
    const partialForget = calls.filter((args) => args.includes('forget') && args.includes('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    expect(partialForget.length).toBeGreaterThan(0);
    expect(calls.some((args) => args.includes('--keep-daily'))).toBe(false);

    mode = 'ok';
    let sawMetadata = false;
    const previous = runner.run;
    runner.run = async (args) => {
      if (args.includes('backup')) {
        const root = args[args.length - 1] ?? '';
        const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { scope: string; metadataOnly: boolean };
        sawMetadata = manifest.scope === 'metadata-only' && manifest.metadataOnly === true;
        expect(readFileSync(path.join(root, 'manifest.json'), 'utf8')).toContain('"schemaVersion"');
      }
      return previous(args, { env: {} });
    };
    await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    const success = await waitJob(started.app, started.cookie, 'succeeded');
    expect(success.job.scope).toBe('metadata-only');
    expect(sawMetadata).toBe(true);
    const policy = calls.find((args) => args.includes('--keep-daily'));
    expect(policy).toEqual(expect.arrayContaining(['--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6', '--prune']));
    expect(success.body.lastSuccess.scope).toBe('metadata-only');
  });

  it('fails an unreadable managed file and a missing indexed root without calling restic backup', async () => {
    const calls: string[][] = [];
    const runner: ResticRunner = {
      async run(args) {
        calls.push(args);
        return result({ code: 0, stdout: '{"message_type":"summary","snapshot_id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}\n' });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);
    const blob = writeImmutableBlob(started.config.dataDir, Buffer.from('book-bytes'));
    const sqlite = openDatabase(started.config.databasePath);
    const now = '2026-04-01T00:00:00.000Z';
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
           VALUES (?, 'Tale', 'Tale', ?, ?)`,
        )
        .run(started.libraryId, now, now).lastInsertRowid,
    );
    sqlite.sqlite
      .prepare(
        `INSERT INTO file_assets (
          edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
        ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'managed', ?, 'present', ?)`,
      )
      .run(editionId, blob.sha256, blob.bytes, blob.relativePath, now);
    const indexedId = Number(
      sqlite.sqlite
        .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?)`)
        .run(path.join(started.config.dataDir, 'missing-indexed-root'), now).lastInsertRowid,
    );
    sqlite.sqlite.close();
    rmSync(blob.absolutePath);

    const missing = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'managed' },
    });
    expect(missing.statusCode).toBe(202);
    const failed = await waitJob(started.app, started.cookie, 'failed');
    expect(failed.job.reason).toMatch(/Cannot read the selected file/);
    expect(failed.job.reason).toMatch(/last successful snapshot/);
    expect(calls.some((args) => args.includes('backup'))).toBe(false);
    writeImmutableBlob(started.config.dataDir, Buffer.from('book-bytes'));

    const root = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'managed', indexedLibraryIds: [indexedId] },
    });
    expect(root.statusCode).toBe(202);
    const missingRoot = await waitJob(started.app, started.cookie, 'failed');
    expect(missingRoot.job.reason).toMatch(/no folder/);
    expect(calls.some((args) => args.includes('backup'))).toBe(false);
  });

  it('fails when a managed blob or included indexed file changed and keeps the previous snapshot', async () => {
    const calls: string[][] = [];
    const forgotten: string[] = [];
    let snapshotSeq = 0;
    const runner: ResticRunner = {
      async run(args) {
        calls.push(args);
        if (args.includes('forget')) {
          const id = args.find((arg) => /^[a-f0-9]{64}$/.test(arg));
          if (id) forgotten.push(id);
        }
        if (args.includes('backup')) {
          snapshotSeq += 1;
          const snapshotId = snapshotSeq.toString(16).padStart(64, '0');
          return result({
            code: 0,
            stdout: `{"message_type":"summary","snapshot_id":"${snapshotId}"}` + '\n',
          });
        }
        if (args.includes('snapshots')) return result({ code: 0, stdout: '[]' });
        return result({ code: 0 });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);
    const bookBytes = Buffer.from('book-bytes');
    const blob = writeImmutableBlob(started.config.dataDir, bookBytes);
    const indexedRoot = path.join(started.config.dataDir, 'indexed-shelf');
    const indexedRelative = 'nested/tale.epub';
    const indexedAbsolute = path.join(indexedRoot, 'nested', 'tale.epub');
    const indexedBytes = Buffer.from('indexed-bytes');
    mkdirSync(path.dirname(indexedAbsolute), { recursive: true });
    writeFileSync(indexedAbsolute, indexedBytes);
    writeFileSync(path.join(indexedRoot, 'notes.txt'), 'not a catalog file');
    const indexedSha = createHash('sha256').update(indexedBytes).digest('hex');
    const missingAbsolute = path.join(indexedRoot, 'gone.epub');
    writeFileSync(missingAbsolute, 'different-bytes');
    const missingListedHash = createHash('sha256').update(Buffer.from('original-missing-bytes')).digest('hex');
    const sqlite = openDatabase(started.config.databasePath);
    const now = '2026-04-01T00:00:00.000Z';
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
           VALUES (?, 'Tale', 'Tale', ?, ?)`,
        )
        .run(started.libraryId, now, now).lastInsertRowid,
    );
    const managedAssetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'managed', ?, 'present', ?)`,
        )
        .run(editionId, blob.sha256, blob.bytes, blob.relativePath, now).lastInsertRowid,
    );
    const indexedId = Number(
      sqlite.sqlite
        .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?)`)
        .run(indexedRoot, now).lastInsertRowid,
    );
    const indexedEditionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
           VALUES (?, 'Shelf tale', 'Shelf tale', ?, ?)`,
        )
        .run(indexedId, now, now).lastInsertRowid,
    );
    const indexedAssetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, 'tale.epub', 'indexed', ?, 'present', ?)`,
        )
        .run(indexedEditionId, indexedSha, indexedBytes.length, indexedRelative, now).lastInsertRowid,
    );
    sqlite.sqlite
      .prepare(
        `INSERT INTO file_assets (
          edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
        ) VALUES (?, 'epub', ?, ?, 'gone.epub', 'indexed', 'gone.epub', 'missing', ?)`,
      )
      .run(indexedEditionId, missingListedHash, Buffer.byteLength('original-missing-bytes'), now);
    sqlite.sqlite.close();

    const payload = { scope: 'managed', indexedLibraryIds: [indexedId] };
    const backupRuns = () => calls.filter((args) => args.includes('backup')).length;
    const expectCatalogUnchanged = () => {
      const check = openDatabase(started.config.databasePath);
      try {
        const managed = check.sqlite.prepare('SELECT sha256 FROM file_assets WHERE id = ?').get(managedAssetId) as {
          sha256: string;
        };
        const indexed = check.sqlite.prepare('SELECT sha256 FROM file_assets WHERE id = ?').get(indexedAssetId) as {
          sha256: string;
        };
        expect(managed.sha256).toBe(blob.sha256);
        expect(indexed.sha256).toBe(indexedSha);
      } finally {
        check.sqlite.close();
      }
    };

    const startedOk = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload,
    });
    expect(startedOk.statusCode).toBe(202);
    const success = await waitJob(started.app, started.cookie, 'succeeded');
    const keptSnapshot = success.body.lastSuccess.snapshotId as string;
    expect(keptSnapshot).toMatch(/^[a-f0-9]{64}$/);
    expect(backupRuns()).toBe(1);

    writeFileSync(blob.absolutePath, Buffer.from('tampered-book-bytes'));
    const changedBlob = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload,
    });
    expect(changedBlob.statusCode).toBe(202);
    const blobFailed = await waitJob(started.app, started.cookie, 'failed');
    expect(blobFailed.job.reason).toMatch(/changed/i);
    expect(blobFailed.job.reason).toContain(blob.absolutePath);
    expect(blobFailed.job.reason).toMatch(/last successful snapshot/i);
    expect(blobFailed.body.job.snapshotId).toBeNull();
    expect(blobFailed.body.job.status).toBe('failed');
    expect(blobFailed.body.lastSuccess.snapshotId).toBe(keptSnapshot);
    expect(backupRuns()).toBe(1);
    expect(forgotten).not.toContain(keptSnapshot);
    expectCatalogUnchanged();

    writeFileSync(blob.absolutePath, bookBytes);
    writeFileSync(indexedAbsolute, Buffer.from('tampered-indexed-bytes'));
    const changedIndexed = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload,
    });
    expect(changedIndexed.statusCode).toBe(202);
    const indexedFailed = await waitJob(started.app, started.cookie, 'failed');
    expect(indexedFailed.job.reason).toMatch(/changed/i);
    expect(indexedFailed.job.reason).toContain(indexedAbsolute);
    expect(indexedFailed.job.reason).toMatch(/last successful snapshot/i);
    expect(indexedFailed.body.job.status).toBe('failed');
    expect(indexedFailed.body.lastSuccess.snapshotId).toBe(keptSnapshot);
    expect(backupRuns()).toBe(1);
    expect(forgotten).not.toContain(keptSnapshot);
    expectCatalogUnchanged();

    writeFileSync(indexedAbsolute, indexedBytes);
    const unchanged = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload,
    });
    expect(unchanged.statusCode).toBe(202);
    const again = await waitJob(started.app, started.cookie, 'succeeded');
    expect(again.body.lastSuccess.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(again.body.lastSuccess.snapshotId).not.toBe(keptSnapshot);
    expect(backupRuns()).toBe(2);
    expect(forgotten).toEqual([]);
    expectCatalogUnchanged();
  });

  it('runs one scheduled backup when the next time is already due', async () => {
    let backups = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ResticRunner = {
      async run(args) {
        if (args.includes('backup')) {
          backups += 1;
          await gate;
          return result({
            code: 0,
            stdout: '{"message_type":"summary","snapshot_id":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}\n',
          });
        }
        return result({ code: 0, stdout: args.includes('snapshots') ? '[]' : '' });
      },
    };
    const started = await startApp(runner, 30);
    await configure(started.app, started.cookie);
    const sqlite = openDatabase(started.config.databasePath);
    sqlite.sqlite
      .prepare('UPDATE backup_settings SET schedule_enabled = 1, next_run_at = ?, scope = ? WHERE id = 1')
      .run(new Date(Date.now() - 60_000).toISOString(), 'metadata-only');
    sqlite.sqlite.close();

    for (let attempt = 0; attempt < 40 && backups === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(backups).toBe(1);
    const second = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    expect(second.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(backups).toBe(1);
    release();
    const done = await waitJob(started.app, started.cookie, 'succeeded');
    expect(done.job.scope).toBe('metadata-only');
  });

  it('reports transfer size and does not call an integrity check a restore', async () => {
    const snapshotId = 'e'.repeat(64);
    const runner: ResticRunner = {
      async run(args) {
        if (args.includes('backup')) {
          return result({
            code: 0,
            stdout: `{"message_type":"summary","snapshot_id":"${snapshotId}","data_added":1200,"total_bytes_processed":8000}\n`,
          });
        }
        if (args.includes('snapshots')) {
          return result({
            code: 0,
            stdout: JSON.stringify([
              {
                id: snapshotId,
                short_id: 'eeeeeeee',
                time: '2026-04-02T00:00:00Z',
                hostname: 'qijuan',
                tags: ['qijuan', 'scope=metadata-only'],
              },
            ]),
          });
        }
        if (args.includes('stats')) return result({ code: 0, stdout: '{"total_size":4096,"total_file_count":2}\n' });
        if (args.includes('check')) return result({ code: 0, stdout: 'no errors were found' });
        return result({ code: 0 });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);
    const queued = await started.app.inject({
      method: 'POST',
      url: '/api/backup/jobs',
      headers: { cookie: started.cookie },
      payload: { scope: 'metadata-only' },
    });
    expect(queued.statusCode).toBe(202);
    const success = await waitJob(started.app, started.cookie, 'succeeded');
    expect(success.body.usage).toEqual({
      repositoryBytes: 4096,
      lastTransfer: { bytesAdded: 1200, bytesProcessed: 8000 },
    });
    expect(success.body.history).toEqual([expect.objectContaining({ id: snapshotId, scope: 'metadata-only' })]);
    expect(success.body.job.scope).toBe('metadata-only');

    const check = await started.app.inject({
      method: 'POST',
      url: '/api/backup/checks',
      headers: { cookie: started.cookie },
    });
    expect(check.statusCode).toBe(202);
    const checked = await waitStatus(started.app, started.cookie, (body) => body.integrityCheck?.status === 'succeeded');
    expect(checked.integrityCheck.reason).toMatch(/did not restore a snapshot/);
    expect(checked.integrityCheck.reason).not.toMatch(/Restore test passed/);

    const restoreTest = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore-tests',
      headers: { cookie: started.cookie },
    });
    expect(restoreTest.statusCode).toBe(202);
    const tested = await waitStatus(started.app, started.cookie, (body) => body.restoreTest?.status === 'failed');
    expect(tested.restoreTest.reason).toMatch(/library was not changed/);
    expect(tested.restoreTest.reason).not.toMatch(/Integrity check passed/);
    const stillThere = await started.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie: started.cookie } });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json().lastSuccess.snapshotId).toBe(snapshotId);
  });

  it('waits to back up while library maintenance holds the gate, and waits to rescan while a backup runs', async () => {
    let releaseBackup = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    let backups = 0;
    const runner: ResticRunner = {
      async run(args) {
        if (args.includes('backup')) {
          backups += 1;
          await gate;
          return result({
            code: 0,
            stdout: '{"message_type":"summary","snapshot_id":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}\n',
          });
        }
        if (args.includes('snapshots')) return result({ code: 0, stdout: '[]' });
        return result({ code: 0 });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);
    expect(tryAcquire('library')).toBe(true);
    try {
      const queued = await started.app.inject({
        method: 'POST',
        url: '/api/backup/jobs',
        headers: { cookie: started.cookie },
        payload: { scope: 'metadata-only' },
      });
      expect(queued.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(backups).toBe(0);
      const waiting = await started.app.inject({ method: 'GET', url: '/api/backup', headers: { cookie: started.cookie } });
      expect(waiting.json().active.status).toBe('queued');
    } finally {
      release('library');
    }
    for (let attempt = 0; attempt < 40 && backups === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(backups).toBe(1);
    const sqlite = openDatabase(started.config.databasePath);
    const now = '2026-04-01T00:00:00.000Z';
    sqlite.sqlite
      .prepare(
        `INSERT INTO jobs (library_id, source, status, created_at, updated_at) VALUES (?, 'rescan', 'queued', ?, ?)`,
      )
      .run(started.libraryId, now, now);
    sqlite.sqlite.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = openDatabase(started.config.databasePath);
    const held = during.sqlite.prepare(`SELECT status, started_at FROM jobs WHERE source = 'rescan'`).get() as {
      status: string;
      started_at: string | null;
    };
    during.sqlite.close();
    expect(held).toEqual({ status: 'queued', started_at: null });
    releaseBackup();
    await waitJob(started.app, started.cookie, 'succeeded');
    let moved = false;
    for (let attempt = 0; attempt < 40 && !moved; attempt += 1) {
      const check = openDatabase(started.config.databasePath);
      const row = check.sqlite.prepare(`SELECT status FROM jobs WHERE source = 'rescan'`).get() as { status: string };
      check.sqlite.close();
      moved = row.status !== 'queued';
      if (!moved) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(moved).toBe(true);
  });
});

describe('restore credentials', () => {
  const snapshotId = 'a'.repeat(64);

  function destination(secretAccessKey: string, prefix = 'library') {
    return {
      preset: 'custom',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      pathStyle: true,
      bucket: 'qijuan-backups',
      prefix,
      accessKeyId: 'backup-access-key',
      secretAccessKey,
    };
  }

  it('reuses the saved secret when the restore form leaves it blank', async () => {
    let seenSecret = '';
    let seenPassword = '';
    const calls: string[][] = [];
    const runner: ResticRunner = {
      async run(args, options) {
        calls.push(args);
        seenSecret = options.env.AWS_SECRET_ACCESS_KEY ?? '';
        seenPassword = options.env.RESTIC_PASSWORD ?? '';
        if (args.includes('snapshots')) {
          return result({
            code: 0,
            stdout: JSON.stringify([
              {
                id: snapshotId,
                short_id: 'aaaaaaaa',
                time: '2026-04-01T00:00:00Z',
                hostname: 'qijuan',
                tags: ['qijuan', 'scope=managed'],
              },
            ]),
          });
        }
        return result({ code: 1, stderr: 'not a snapshot' });
      },
    };
    const started = await startApp(runner);
    await configure(started.app, started.cookie);
    const listed = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore/snapshots',
      headers: { cookie: started.cookie },
      payload: { recoveryPassword, destination: destination('', 'other-prefix') },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().snapshots).toEqual([
      expect.objectContaining({ id: snapshotId, scope: 'managed' }),
    ]);
    expect(listed.body).not.toContain(secretKey);
    expect(seenSecret).toBe(secretKey);
    expect(seenPassword).toBe(recoveryPassword);
    expect(calls[0]?.join(' ')).toContain('s3:http://127.0.0.1:9000/qijuan-backups/other-prefix');

    const plan = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore/plan',
      headers: { cookie: started.cookie },
      payload: { recoveryPassword, destination: destination(''), snapshotId },
    });
    expect(plan.statusCode).toBe(400);
    expect(plan.json().error).toBe('incompatible_snapshot');
    expect(calls.some((args) => args.includes('restore'))).toBe(true);

    const typed = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore/snapshots',
      headers: { cookie: started.cookie },
      payload: { recoveryPassword, destination: destination('typed-secret-value') },
    });
    expect(typed.statusCode).toBe(200);
    expect(seenSecret).toBe('typed-secret-value');
  });

  it('still requires a secret when no destination has been saved', async () => {
    const calls: string[][] = [];
    const runner: ResticRunner = {
      async run(args, options) {
        calls.push(args);
        expect(options.env.AWS_SECRET_ACCESS_KEY).toBe('typed-secret-value');
        return result({ code: 0, stdout: '[]' });
      },
    };
    const started = await startApp(runner);
    const blank = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore/snapshots',
      headers: { cookie: started.cookie },
      payload: { recoveryPassword, destination: destination('') },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({ error: 'invalid_request' });
    expect(calls).toEqual([]);

    const typed = await started.app.inject({
      method: 'POST',
      url: '/api/backup/restore/snapshots',
      headers: { cookie: started.cookie },
      payload: { recoveryPassword, destination: destination('typed-secret-value') },
    });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
