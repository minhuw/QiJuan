import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('migrations', () => {
  it('applies packaged SQL files from a temporary data directory', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    const migrationsDir = defaultMigrationsDir();
    expect(existsSync(path.join(migrationsDir, '0001_init.sql'))).toBe(true);

    const first = migrate({ databasePath, migrationsDir });
    expect(first.applied).toEqual([
      '0001_init.sql',
      '0002_auth.sql',
      '0003_catalog.sql',
      '0004_jobs.sql',
      '0005_edition_editing.sql',
      '0006_contributor_display_name.sql',
      '0007_search.sql',
      '0008_note_anchors.sql',
      '0009_reading_revisions.sql',
      '0010_opds_tokens.sql',
      '0011_backup.sql',
      '0012_library_sort.sql',
      '0013_job_sources.sql',
      '0014_backup_maintenance.sql',
      '0015_metadata_trajectories.sql',
      '0016_edition_identifiers.sql',
      '0017_preview_covers.sql',
      '0018_edition_ratings.sql',
      '0019_preview_applied.sql',
      '0020_cover_tint.sql',
      '0021_metadata_private.sql',
      '0022_asset_ocr.sql',
      '0023_asset_ocr_auto.sql',
      '0024_edition_sort_key.sql',
      '0025_reading_progress.sql',
    ]);
    expect(first.backupPath).toBeNull();

    const { sqlite, db, schema } = openDatabase(databasePath);
    expect(db.select().from(schema.appMeta).all()).toEqual([]);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'app_meta',
        'users',
        'sessions',
        'libraries',
        'library_grants',
        'editions',
        'file_assets',
        'reading_positions',
        'jobs',
        'job_items',
        'field_locks',
        'edition_suggestions',
        'metadata_previews',
        'opds_tokens',
      ]),
    );
    sqlite.close();

    const second = migrate({ databasePath, migrationsDir });
    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect(readdirSync(temp.dir).some((name) => name.includes('pre-migration'))).toBe(false);
  });

  it('copies an existing database beside itself before applying migrations', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const migrationsDir = path.join(temp.dir, 'migrations');
    mkdirSync(migrationsDir);
    writeFileSync(
      path.join(migrationsDir, '0001_init.sql'),
      'CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n',
    );

    const databasePath = path.join(temp.dir, 'nested', 'qijuan.sqlite');
    const created = migrate({ databasePath, migrationsDir });
    expect(created.backupPath).toBeNull();

    const sqlite = new Database(databasePath);
    sqlite.prepare('INSERT INTO books (title) VALUES (?)').run('Existing');
    sqlite.close();

    writeFileSync(
      path.join(migrationsDir, '0002_note.sql'),
      'ALTER TABLE books ADD COLUMN note TEXT;\n',
    );

    const updated = migrate({ databasePath, migrationsDir });
    expect(updated.applied).toEqual(['0002_note.sql']);
    expect(updated.backupPath).toBeTruthy();
    expect(path.dirname(updated.backupPath!)).toBe(path.dirname(databasePath));
    expect(path.basename(updated.backupPath!)).toMatch(/^qijuan\.sqlite\..+\.pre-migration$/);

    const backup = new Database(updated.backupPath!, { readonly: true });
    const preserved = backup.prepare('SELECT title FROM books').get() as { title: string };
    expect(preserved.title).toBe('Existing');
    const backupColumns = backup.prepare('PRAGMA table_info(books)').all() as { name: string }[];
    expect(backupColumns.some((column) => column.name === 'note')).toBe(false);
    backup.close();

    const current = new Database(databasePath, { readonly: true });
    const columns = current.prepare('PRAGMA table_info(books)').all() as { name: string }[];
    expect(columns.some((column) => column.name === 'note')).toBe(true);
    const stillThere = current.prepare('SELECT title FROM books').get() as { title: string };
    expect(stillThere.title).toBe('Existing');
    current.close();
  });

  it('copies an existing database before applying the catalog migration', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const earlyDir = path.join(temp.dir, 'early');
    mkdirSync(earlyDir);
    const packaged = defaultMigrationsDir();
    copyFileSync(path.join(packaged, '0001_init.sql'), path.join(earlyDir, '0001_init.sql'));
    copyFileSync(path.join(packaged, '0002_auth.sql'), path.join(earlyDir, '0002_auth.sql'));

    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    const created = migrate({ databasePath, migrationsDir: earlyDir });
    expect(created.applied).toEqual(['0001_init.sql', '0002_auth.sql']);
    expect(created.backupPath).toBeNull();

    const sqlite = new Database(databasePath);
    sqlite
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run('ada', 'hash', 'admin', '2020-01-01T00:00:00.000Z');
    sqlite.close();

    const updated = migrate({ databasePath, migrationsDir: packaged });
    expect(updated.applied).toEqual([
      '0003_catalog.sql',
      '0004_jobs.sql',
      '0005_edition_editing.sql',
      '0006_contributor_display_name.sql',
      '0007_search.sql',
      '0008_note_anchors.sql',
      '0009_reading_revisions.sql',
      '0010_opds_tokens.sql',
      '0011_backup.sql',
      '0012_library_sort.sql',
      '0013_job_sources.sql',
      '0014_backup_maintenance.sql',
      '0015_metadata_trajectories.sql',
      '0016_edition_identifiers.sql',
      '0017_preview_covers.sql',
      '0018_edition_ratings.sql',
      '0019_preview_applied.sql',
      '0020_cover_tint.sql',
      '0021_metadata_private.sql',
      '0022_asset_ocr.sql',
      '0023_asset_ocr_auto.sql',
      '0024_edition_sort_key.sql',
      '0025_reading_progress.sql',
    ]);
    expect(updated.backupPath).toBeTruthy();
    expect(existsSync(updated.backupPath!)).toBe(true);
    expect(path.dirname(updated.backupPath!)).toBe(path.dirname(databasePath));

    const backup = new Database(updated.backupPath!, { readonly: true });
    expect(backup.prepare('SELECT username FROM users').get()).toEqual({ username: 'ada' });
    expect(
      backup.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'editions'").get(),
    ).toBeUndefined();
    backup.close();

    const current = new Database(databasePath, { readonly: true });
    expect(current.prepare('SELECT username FROM users').get()).toEqual({ username: 'ada' });
    expect(
      current.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'file_assets'").get(),
    ).toEqual({ present: 1 });
    expect(
      current.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
    ).toEqual({ present: 1 });
    expect(
      current.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'field_locks'").get(),
    ).toEqual({ present: 1 });
    current.close();
  });

  it('keeps import jobs when the jobs source check is widened', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const earlyDir = path.join(temp.dir, 'early');
    mkdirSync(earlyDir);
    const packaged = defaultMigrationsDir();
    for (const name of readdirSync(packaged)) {
      if (!name.endsWith('.sql') || name === '0013_job_sources.sql') continue;
      copyFileSync(path.join(packaged, name), path.join(earlyDir, name));
    }
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    migrate({ databasePath, migrationsDir: earlyDir });

    const now = '2026-01-01T00:00:00.000Z';
    const seed = new Database(databasePath);
    const library = seed
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Home', 'managed', ?, ?) RETURNING id`)
      .get(temp.dir, now) as { id: number };
    const job = seed
      .prepare(
        `INSERT INTO jobs (library_id, source, status, created_at, updated_at, started_at)
         VALUES (?, 'upload', 'running', ?, ?, ?) RETURNING id`,
      )
      .get(library.id, now, now, now) as { id: number };
    seed
      .prepare(
        `INSERT INTO job_items (job_id, position, filename, source_path, status, created_at, updated_at)
         VALUES (?, 0, 'tale.epub', 'incoming/x/0-tale.epub', 'running', ?, ?)`,
      )
      .run(job.id, now, now);
    seed.close();

    const updated = migrate({ databasePath, migrationsDir: packaged });
    expect(updated.applied).toEqual(['0013_job_sources.sql']);

    const db = new Database(databasePath);
    const row = db.prepare('SELECT id, source, status, payload, result FROM jobs WHERE id = ?').get(job.id) as {
      id: number;
      source: string;
      status: string;
      payload: string | null;
      result: string | null;
    };
    expect(row).toEqual({ id: job.id, source: 'upload', status: 'running', payload: null, result: null });
    const item = db.prepare('SELECT filename, status FROM job_items WHERE job_id = ?').get(job.id) as {
      filename: string;
      status: string;
    };
    expect(item).toEqual({ filename: 'tale.epub', status: 'running' });
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_items'").get() as {
      sql: string;
    };
    expect(definition.sql).toMatch(/REFERENCES "?jobs"?\(id\)/);
    const inserted = db
      .prepare(
        `INSERT INTO jobs (library_id, source, status, payload, created_at, updated_at)
         VALUES (?, 'lookup', 'queued', ?, ?, ?) RETURNING id`,
      )
      .get(library.id, '{"editionId":1}', now, now) as { id: number };
    expect(inserted.id).toBeGreaterThan(job.id);
    expect(() => {
      db.prepare(
        `INSERT INTO jobs (library_id, source, status, created_at, updated_at) VALUES (?, 'watch', 'queued', ?, ?)`,
      ).run(library.id, now, now);
    }).toThrow();
    db.close();
  });

  it('moves identifiers into edition_identifiers with provenance and never merges existing editions', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const earlyDir = path.join(temp.dir, 'early');
    mkdirSync(earlyDir);
    const packaged = defaultMigrationsDir();
    for (const name of readdirSync(packaged)) {
      if (!name.endsWith('.sql') || name >= '0016') continue;
      copyFileSync(path.join(packaged, name), path.join(earlyDir, name));
    }
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    migrate({ databasePath, migrationsDir: earlyDir });

    const now = '2026-01-01T00:00:00.000Z';
    const seed = new Database(databasePath);
    const library = seed
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Home', 'managed', ?, ?) RETURNING id`)
      .get(temp.dir, now) as { id: number };
    const edition = (title: string) =>
      (
        seed
          .prepare(
            `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(library.id, title, title, now, now) as { id: number }
      ).id;
    const folderBook = edition('Folder Book');
    const uploaded = edition('Uploaded Book');
    const edited = edition('Edited Book');
    const twin = edition('Another Title');
    const insert = seed.prepare('INSERT INTO identifiers (edition_id, scheme, value) VALUES (?, ?, ?)');
    insert.run(folderBook, 'ISBN', '0-14-032872-6');
    insert.run(folderBook, 'isbn13', 'urn:isbn:978-0-14-032872-1');
    insert.run(folderBook, 'uuid', 'urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f');
    insert.run(uploaded, 'doi', 'https://doi.org/10.1000/ABC.Def');
    insert.run(uploaded, 'isbn', 'not-an-isbn');
    insert.run(edited, 'isbn', '9780000000002');
    insert.run(twin, 'isbn', '978-0-00-000000-2');
    const job = seed
      .prepare(
        `INSERT INTO jobs (library_id, source, status, created_at, updated_at) VALUES (?, 'upload', 'succeeded', ?, ?) RETURNING id`,
      )
      .get(library.id, now, now) as { id: number };
    seed
      .prepare(
        `INSERT INTO job_items (job_id, position, filename, source_path, status, edition_id, created_at, updated_at)
         VALUES (?, 0, 'up.epub', 'incoming/x/0-up.epub', 'succeeded', ?, ?, ?)`,
      )
      .run(job.id, uploaded, now, now);
    seed.prepare(`INSERT INTO field_locks (edition_id, field, locked_at) VALUES (?, 'identifiers', ?)`).run(edited, now);
    seed.close();

    const updated = migrate({ databasePath, migrationsDir: packaged });
    expect(updated.applied).toEqual(['0016_edition_identifiers.sql', '0017_preview_covers.sql', '0018_edition_ratings.sql', '0019_preview_applied.sql', '0020_cover_tint.sql', '0021_metadata_private.sql', '0022_asset_ocr.sql', '0023_asset_ocr_auto.sql', '0024_edition_sort_key.sql', '0025_reading_progress.sql']);

    const db = new Database(databasePath);
    const rows = db
      .prepare('SELECT edition_id AS editionId, scheme, value, source, source_url AS sourceUrl, created_at AS createdAt FROM edition_identifiers ORDER BY id')
      .all();
    expect(rows).toEqual([
      // ISBN-10 converted; the ISBN-13 spelling of the same book collapses into it.
      { editionId: folderBook, scheme: 'isbn', value: '9780140328721', source: 'embedded', sourceUrl: null, createdAt: now },
      { editionId: folderBook, scheme: 'uuid', value: 'urn:uuid:6f1b1c2a-9a0e-4d3b-8c55-1a2b3c4d5e6f', source: 'embedded', sourceUrl: null, createdAt: now },
      { editionId: uploaded, scheme: 'doi', value: '10.1000/abc.def', source: 'agent', sourceUrl: null, createdAt: now },
      // A value that does not validate is kept as it was.
      { editionId: uploaded, scheme: 'isbn', value: 'not-an-isbn', source: 'agent', sourceUrl: null, createdAt: now },
      { editionId: edited, scheme: 'isbn', value: '9780000000002', source: 'manual', sourceUrl: null, createdAt: now },
      { editionId: twin, scheme: 'isbn', value: '9780000000002', source: 'embedded', sourceUrl: null, createdAt: now },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'identifiers'").get()).toBeUndefined();

    // Two editions sharing an ISBN stay separate and become a suggestion.
    expect(db.prepare('SELECT count(*) AS count FROM editions WHERE trashed_at IS NULL').get()).toEqual({ count: 4 });
    expect(db.prepare('SELECT edition_id AS editionId, matched_edition_id AS matchedId FROM edition_suggestions').all()).toEqual([
      { editionId: twin, matchedId: edited },
    ]);

    // Search still finds an edition by its ISBN.
    expect(db.prepare("SELECT rowid FROM edition_fts WHERE edition_fts MATCH '\"9780140328721\"'").all()).toEqual([
      { rowid: folderBook },
    ]);
    db.prepare('INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
      uploaded,
      'isbn',
      '9787010134185',
      'manual',
      now,
    );
    expect(db.prepare("SELECT rowid FROM edition_fts WHERE edition_fts MATCH '\"9787010134185\"'").all()).toEqual([
      { rowid: uploaded },
    ]);
    expect(() =>
      db.prepare(`UPDATE job_items SET status = 'needs_confirmation' WHERE job_id = ?`).run(job.id),
    ).not.toThrow();
    db.close();
  });

  it('adds edition ratings and queues an edition when its rating identifiers change', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    const packaged = defaultMigrationsDir();
    const before = path.join(temp.dir, 'before');
    mkdirSync(before);
    for (const name of readdirSync(packaged)) {
      if (name.endsWith('.sql') && name < '0018') copyFileSync(path.join(packaged, name), path.join(before, name));
    }
    migrate({ databasePath, migrationsDir: before });
    const now = '2026-01-01T00:00:00.000Z';
    const seed = new Database(databasePath);
    seed.pragma('foreign_keys = ON');
    seed.prepare("INSERT INTO libraries (id, name, mode, root_path, created_at) VALUES (1, 'Home', 'managed', '/x', ?)").run(now);
    seed.prepare("INSERT INTO editions (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'T', 'T', ?, ?)").run(now, now);
    seed.prepare("INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (1, 'isbn', '9780140328721', 'manual', ?)").run(now);
    seed.close();

    const updated = migrate({ databasePath, migrationsDir: packaged });
    expect(updated.applied).toEqual(['0018_edition_ratings.sql', '0019_preview_applied.sql', '0020_cover_tint.sql', '0021_metadata_private.sql', '0022_asset_ocr.sql', '0023_asset_ocr_auto.sql', '0024_edition_sort_key.sql', '0025_reading_progress.sql']);
    const db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    // No backfill: existing identifiers queue nothing.
    expect(db.prepare('SELECT count(*) AS count FROM edition_ratings_queue').get()).toEqual({ count: 0 });

    const insertIdentifier = db.prepare('INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (1, ?, ?, ?, ?)');
    insertIdentifier.run('uuid', 'urn:uuid:x', 'manual', now);
    expect(db.prepare('SELECT count(*) AS count FROM edition_ratings_queue').get()).toEqual({ count: 0 });
    insertIdentifier.run('douban', '25869109', 'manual', now);
    expect(db.prepare('SELECT edition_id AS editionId FROM edition_ratings_queue').all()).toEqual([{ editionId: 1 }]);
    db.prepare('DELETE FROM edition_ratings_queue').run();
    db.prepare("DELETE FROM edition_identifiers WHERE scheme = 'isbn'").run();
    expect(db.prepare('SELECT edition_id AS editionId FROM edition_ratings_queue').all()).toEqual([{ editionId: 1 }]);

    const insertRating = db.prepare(
      'INSERT INTO edition_ratings (edition_id, provider, url, rating, scale, count, status, error, fetched_at) VALUES (1, ?, ?, ?, ?, ?, ?, NULL, ?)',
    );
    insertRating.run('douban', 'https://book.douban.com/subject/25869109/', 9.3, 10, 209, 'ok', now);
    expect(() => insertRating.run('goodreads', null, 5.5, 5, 1, 'ok', now)).toThrow(/CHECK/);
    expect(() => insertRating.run('goodreads', null, 4, 5, -1, 'ok', now)).toThrow(/CHECK/);
    expect(() => insertRating.run('amazon', null, 4, 5, 1, 'ok', now)).toThrow(/CHECK/);
    expect(() => insertRating.run('goodreads', null, null, 5, null, 'pending', now)).toThrow(/CHECK/);

    db.prepare('DELETE FROM editions WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS count FROM edition_ratings').get()).toEqual({ count: 0 });
    db.close();
  });

  it('adds metadata_private to editions and job items, off for existing rows', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    const packaged = defaultMigrationsDir();
    const before = path.join(temp.dir, 'before');
    mkdirSync(before);
    for (const name of readdirSync(packaged)) {
      if (name.endsWith('.sql') && name < '0021') copyFileSync(path.join(packaged, name), path.join(before, name));
    }
    migrate({ databasePath, migrationsDir: before });
    const now = '2026-01-01T00:00:00.000Z';
    const seed = new Database(databasePath);
    seed.prepare("INSERT INTO libraries (id, name, mode, root_path, created_at) VALUES (1, 'Home', 'managed', '/x', ?)").run(now);
    seed.prepare("INSERT INTO editions (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'T', 'T', ?, ?)").run(now, now);
    seed.close();

    const updated = migrate({ databasePath, migrationsDir: packaged });
    expect(updated.applied).toEqual(['0021_metadata_private.sql', '0022_asset_ocr.sql', '0023_asset_ocr_auto.sql', '0024_edition_sort_key.sql', '0025_reading_progress.sql']);
    const db = new Database(databasePath);
    expect(db.prepare('SELECT metadata_private FROM editions WHERE id = 1').get()).toEqual({ metadata_private: 0 });
    const columns = db.prepare("SELECT name FROM pragma_table_info('job_items')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('metadata_private');
    expect(() => db.prepare('UPDATE editions SET metadata_private = 2 WHERE id = 1').run()).toThrow(/CHECK/);
    db.close();
  });
});
