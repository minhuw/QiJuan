import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
    expect(first.applied).toEqual(['0001_init.sql']);
    expect(first.backupPath).toBeNull();

    const { sqlite, db, schema } = openDatabase(databasePath);
    expect(db.select().from(schema.appMeta).all()).toEqual([]);
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
});
