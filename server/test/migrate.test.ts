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
});
