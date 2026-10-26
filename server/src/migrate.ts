import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface MigrateOptions {
  databasePath: string;
  migrationsDir: string;
}

export interface MigrateResult {
  applied: string[];
  backupPath: string | null;
}

export function migrate(options: MigrateOptions): MigrateResult {
  const files = listMigrationFiles(options.migrationsDir);
  const existed = existsSync(options.databasePath);
  mkdirSync(path.dirname(options.databasePath), { recursive: true });

  const appliedNames = existed ? readAppliedNames(options.databasePath) : [];
  const pending = files.filter((name) => !appliedNames.includes(name));

  let backupPath: string | null = null;
  if (existed && pending.length > 0) {
    backupPath = backupDatabase(options.databasePath);
  }

  const db = new Database(options.databasePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureMigrationsTable(db);
    applyPending(db, options.migrationsDir, pending);
  } finally {
    db.close();
  }

  return { applied: pending, backupPath };
}

function listMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

function readAppliedNames(databasePath: string): string[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { present: number } | undefined;
    if (!table) return [];
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY id').all() as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

function backupDatabase(databasePath: string): string {
  if (existsSync(`${databasePath}-wal`)) {
    const checkpoint = new Database(databasePath);
    try {
      checkpoint.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      checkpoint.close();
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${databasePath}.${stamp}.pre-migration`;
  copyFileSync(databasePath, backupPath);
  return backupPath;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
}

function applyPending(db: Database.Database, migrationsDir: string, pending: string[]): void {
  const insert = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  const run = db.transaction((name: string, sql: string) => {
    db.exec(sql);
    insert.run(name, new Date().toISOString());
  });

  for (const name of pending) {
    const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
    try {
      run(name, sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${name} failed: ${message}`);
    }
  }
}
