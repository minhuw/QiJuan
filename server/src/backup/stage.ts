import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { asc } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath } from '../blobs.js';
import type { AppDatabase } from '../db.js';
import { libraries } from '../schema.js';
import {
  BackupJobError,
  type BackupManifest,
  type BackupScopeChoice,
  type LibraryMapEntry,
  METADATA_ONLY_SCOPE,
  appVersion,
  keptSnapshotReason,
  latestSchemaVersion,
  migrationNames,
  scopeLabel,
} from './model.js';

const SECRET_NAME = 'session.secret';

export interface StageRequest {
  sqlite: Database.Database;
  db: AppDatabase;
  dataDir: string;
  migrationsDir: string;
  openLibraryOrigin: string;
  scope: BackupScopeChoice;
  indexedLibraryIds: number[];
}

export async function stageBackup(input: StageRequest): Promise<{ root: string; label: string }> {
  const label = scopeLabel(input.scope, input.indexedLibraryIds);
  const metadataOnly = label === METADATA_ONLY_SCOPE;
  const root = mkdtempSync(path.join(tmpdir(), 'qijuan-backup-'));
  try {
    const snapshotPath = path.join(root, 'qijuan.sqlite');
    await input.sqlite.backup(snapshotPath);
    forgetInProgressJobs(snapshotPath);
    copySecret(input.dataDir, root);
    const libraryRows = listLibraries(input.db);
    const included = new Set(input.indexedLibraryIds);
    if (!metadataOnly) copyManagedBlobs(input.sqlite, input.dataDir, root);
    if (included.size > 0) copyIndexedLibraries(libraryRows, included, root);
    const storageLibraries = libraryRows.map((library) => ({
      id: library.id,
      name: library.name,
      mode: library.mode,
      rootPath: library.rootPath,
      included: included.has(library.id),
    }));
    writeRecoverFile(root, input, storageLibraries);
    const manifest: BackupManifest = {
      format: 1,
      app: 'qijuan',
      appVersion: appVersion(),
      schemaVersion: latestSchemaVersion(input.migrationsDir),
      createdAt: new Date().toISOString(),
      scope: label,
      metadataOnly,
      storageMap: {
        database: 'qijuan.sqlite',
        secret: SECRET_NAME,
        blobs: metadataOnly ? null : 'blobs',
        indexed: included.size > 0 ? 'indexed' : null,
        recover: 'recover.json',
        libraries: storageLibraries,
      },
    };
    writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, label };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function removeStage(root: string | null): void {
  if (!root) return;
  rmSync(root, { recursive: true, force: true });
}

export interface RestoreInspection {
  manifest: BackupManifest;
  users: number;
  editions: number;
  shelves: number;
  highlights: number;
  notes: number;
  bookmarks: number;
  readingPositions: number;
  managedFiles: number;
  missingFiles: string[];
  compatible: boolean;
  reason: string | null;
}

export function inspectSnapshot(root: string, migrationsDir: string): RestoreInspection {
  const manifest = readManifest(root);
  const manifestCheck = checkManifest(manifest, migrationsDir);
  const databasePath = path.join(root, 'qijuan.sqlite');
  if (!existsSync(databasePath)) {
    return emptyInspection(manifest, false, 'The snapshot has no QiJuan database. Choose a different snapshot.');
  }
  if (!existsSync(path.join(root, SECRET_NAME))) {
    return emptyInspection(manifest, false, 'The snapshot has no application secret. Choose a different snapshot.');
  }
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quick = sqlite.pragma('quick_check') as Array<{ quick_check: string }>;
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
      return emptyInspection(manifest, false, 'The snapshot database failed its integrity check. Choose a different snapshot.');
    }
    const users = count(sqlite, 'SELECT COUNT(*) AS n FROM users');
    const editions = count(sqlite, 'SELECT COUNT(*) AS n FROM editions WHERE trashed_at IS NULL');
    const shelves = count(sqlite, 'SELECT COUNT(*) AS n FROM shelves');
    const highlights = count(sqlite, 'SELECT COUNT(*) AS n FROM highlights');
    const notes = count(sqlite, 'SELECT COUNT(*) AS n FROM notes');
    const bookmarks = count(sqlite, 'SELECT COUNT(*) AS n FROM bookmarks');
    const readingPositions = count(sqlite, 'SELECT COUNT(*) AS n FROM reading_positions');
    const files = sqlite
      .prepare(
        `SELECT sha256 AS sha256, relative_path AS relativePath, bytes AS bytes
         FROM file_assets WHERE storage = 'managed' AND trashed_at IS NULL
         UNION
         SELECT sha256, relative_path, bytes FROM covers`,
      )
      .all() as Array<{ sha256: string; relativePath: string; bytes: number }>;
    const missingFiles: string[] = [];
    for (const file of files) {
      const relative = safeRelative(file.relativePath);
      const absolute = relative ? path.join(root, relative) : '';
      if (!relative || !existsSync(absolute) || !statSync(absolute).isFile() || statSync(absolute).size !== file.bytes) {
        missingFiles.push(file.relativePath);
      }
    }
    let compatible = manifestCheck.ok;
    let reason = manifestCheck.ok ? null : manifestCheck.reason;
    if (compatible && !manifest.metadataOnly && missingFiles.length > 0) {
      compatible = false;
      const sample = missingFiles.slice(0, 5).join(', ');
      reason = `The snapshot is missing managed files (${sample}). Choose a snapshot that includes book files, or make a new backup.`;
    }
    return {
      manifest,
      users,
      editions,
      shelves,
      highlights,
      notes,
      bookmarks,
      readingPositions,
      managedFiles: files.length,
      missingFiles,
      compatible,
      reason,
    };
  } finally {
    sqlite.close();
  }
}

export function findSnapshotRoot(directory: string): string | null {
  const pending = [directory];
  let seen = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    seen += 1;
    if (seen > 10_000) return null;
    if (existsSync(path.join(current, 'manifest.json')) && existsSync(path.join(current, 'qijuan.sqlite'))) {
      return current;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(current, entry);
      try {
        if (lstatSync(next).isDirectory()) pending.push(next);
      } catch {
        // Skip unreadable restore leftovers.
      }
    }
  }
  return null;
}

export function installSnapshotFiles(snapshotRoot: string, dataDir: string, databasePath: string): void {
  const manifest = readManifest(snapshotRoot);
  const temporary = `${databasePath}.restore`;
  rmSync(temporary, { force: true });
  copyFileSync(path.join(snapshotRoot, 'qijuan.sqlite'), temporary);
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  renameSync(temporary, databasePath);
  const secretDest = path.join(dataDir, SECRET_NAME);
  copyFileSync(path.join(snapshotRoot, SECRET_NAME), secretDest);
  chmodSecret(secretDest);
  // Metadata-only snapshots do not include book files. Replacing blobs would
  // delete the copies the restored database still points at.
  if (manifest.metadataOnly) return;
  const blobsDest = path.join(dataDir, 'blobs');
  rmSync(blobsDest, { recursive: true, force: true });
  const blobsSrc = path.join(snapshotRoot, 'blobs');
  if (existsSync(blobsSrc)) cpSync(blobsSrc, blobsDest, { recursive: true });
}

export function restoreIndexedFiles(snapshotRoot: string, db: AppDatabase): void {
  const indexedRoot = path.join(snapshotRoot, 'indexed');
  if (!existsSync(indexedRoot)) return;
  for (const entry of readdirSync(indexedRoot)) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const libraryId = Number(entry);
    const library = db.select().from(libraries).all().find((row) => row.id === libraryId);
    if (!library || library.mode !== 'indexed') continue;
    mkdirSync(library.rootPath, { recursive: true });
    cpSync(path.join(indexedRoot, entry), library.rootPath, { recursive: true });
  }
}

function forgetInProgressJobs(snapshotPath: string): void {
  const sqlite = new Database(snapshotPath);
  try {
    sqlite.exec("DELETE FROM backup_jobs WHERE status IN ('queued', 'running')");
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    sqlite.close();
  }
  rmSync(`${snapshotPath}-wal`, { force: true });
  rmSync(`${snapshotPath}-shm`, { force: true });
}

function copySecret(dataDir: string, root: string): void {
  const source = path.join(dataDir, SECRET_NAME);
  if (!existsSync(source)) {
    throw new BackupJobError(
      keptSnapshotReason('The application secret is missing, so this backup cannot be restored. Restart QiJuan and retry'),
    );
  }
  let fd: number | null = null;
  try {
    fd = openSync(source, 'r');
  } catch {
    throw new BackupJobError(
      keptSnapshotReason(`Cannot read the application secret at ${source}. Restore its permissions and retry`),
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const dest = path.join(root, SECRET_NAME);
  copyFileSync(source, dest);
  chmodSecret(dest);
}

function chmodSecret(file: string): void {
  chmodSync(file, 0o600);
}

function listLibraries(db: AppDatabase): LibraryMapEntry[] {
  return db
    .select({
      id: libraries.id,
      name: libraries.name,
      mode: libraries.mode,
      rootPath: libraries.rootPath,
    })
    .from(libraries)
    .orderBy(asc(libraries.id))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      mode: row.mode === 'indexed' ? 'indexed' : 'managed',
      rootPath: row.rootPath,
      included: false,
    }));
}

function copyManagedBlobs(sqlite: Database.Database, dataDir: string, root: string): void {
  const files = sqlite
    .prepare(
      `SELECT sha256 AS sha256, relative_path AS relativePath, bytes AS bytes
       FROM file_assets WHERE storage = 'managed'
       UNION
       SELECT sha256, relative_path, bytes FROM covers`,
    )
    .all() as Array<{ sha256: string; relativePath: string; bytes: number }>;
  for (const file of files) {
    let expected = '';
    try {
      expected = managedBlobRelativePath(file.sha256);
    } catch {
      throw new BackupJobError(keptSnapshotReason(`Cannot read the selected file ${file.relativePath}. Its record is not a managed blob`));
    }
    if (file.relativePath !== expected) {
      throw new BackupJobError(
        keptSnapshotReason(`Cannot read the selected file ${file.relativePath}. Its stored path does not match the blob`),
      );
    }
    let absolute = '';
    try {
      absolute = absoluteBlobPath(dataDir, file.sha256);
    } catch {
      throw new BackupJobError(keptSnapshotReason(`Cannot read the selected file ${file.relativePath}`));
    }
    assertReadableFile(absolute);
    const dest = path.join(root, expected);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(absolute, dest);
  }
}

function copyIndexedLibraries(rows: LibraryMapEntry[], included: Set<number>, root: string): void {
  for (const id of included) {
    const library = rows.find((row) => row.id === id);
    if (!library || library.mode !== 'indexed') {
      throw new BackupJobError(
        keptSnapshotReason(`Indexed library ${id} is not a folder library. Clear that selection and retry`),
      );
    }
    let rootStat: ReturnType<typeof statSync> | null = null;
    try {
      rootStat = statSync(library.rootPath);
    } catch {
      rootStat = null;
    }
    if (!rootStat?.isDirectory()) {
      throw new BackupJobError(
        keptSnapshotReason(
          `The selected indexed library "${library.name}" has no folder at ${library.rootPath}. Restore that folder or remove it from the backup`,
        ),
      );
    }
    const target = path.join(root, 'indexed', String(library.id));
    mkdirSync(target, { recursive: true });
    copyReadableTree(library.rootPath, library.rootPath, target);
  }
}

function copyReadableTree(libraryRoot: string, current: string, targetRoot: string): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    throw new BackupJobError(keptSnapshotReason(`Cannot read the selected file ${current}. Restore permission to list that folder`));
  }
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyReadableTree(libraryRoot, absolute, targetRoot);
      continue;
    }
    if (!entry.isFile()) continue;
    assertReadableFile(absolute);
    const relative = path.relative(libraryRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new BackupJobError(keptSnapshotReason(`Cannot read the selected file ${absolute}. It is outside the indexed library`));
    }
    const dest = path.join(targetRoot, relative);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(absolute, dest);
  }
}

function assertReadableFile(absolute: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(absolute, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'It is missing' : 'QiJuan cannot read it';
    throw new BackupJobError(
      keptSnapshotReason(`Cannot read the selected file ${absolute}. ${why}. Restore the file and its permissions`),
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeRecoverFile(root: string, input: StageRequest, librariesMap: LibraryMapEntry[]): void {
  const body = {
    app: 'qijuan',
    appVersion: appVersion(),
    schemaVersion: latestSchemaVersion(input.migrationsDir),
    openLibraryOrigin: input.openLibraryOrigin,
    layout: {
      database: 'qijuan.sqlite',
      secret: SECRET_NAME,
      blobs: 'blobs',
      managedLibraryRoot: 'libraries/<id>',
    },
    libraries: librariesMap,
  };
  writeFileSync(path.join(root, 'recover.json'), `${JSON.stringify(body, null, 2)}\n`);
}

function readManifest(root: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  } catch {
    throw new BackupJobError('The snapshot manifest could not be read. Choose a different snapshot.');
  }
  if (!isManifest(parsed)) {
    throw new BackupJobError('The snapshot manifest is not a QiJuan backup. Choose a different snapshot.');
  }
  return parsed;
}

function checkManifest(manifest: BackupManifest, migrationsDir: string): { ok: true } | { ok: false; reason: string } {
  if (manifest.format !== 1 || manifest.app !== 'qijuan') {
    return { ok: false, reason: 'This snapshot is not a compatible QiJuan backup. Choose a snapshot made by QiJuan.' };
  }
  const known = migrationNames(migrationsDir);
  if (!known.includes(manifest.schemaVersion)) {
    return {
      ok: false,
      reason: `This snapshot uses schema ${manifest.schemaVersion}, which this QiJuan does not include. Upgrade QiJuan, then restore again.`,
    };
  }
  const latest = known[known.length - 1] ?? manifest.schemaVersion;
  if (manifest.schemaVersion > latest) {
    return {
      ok: false,
      reason: `This snapshot uses a newer schema (${manifest.schemaVersion}). Upgrade QiJuan before restoring.`,
    };
  }
  return { ok: true };
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<BackupManifest>;
  return record.format === 1 && record.app === 'qijuan' && typeof record.schemaVersion === 'string' && typeof record.scope === 'string' && typeof record.metadataOnly === 'boolean' && typeof record.storageMap === 'object';
}

function emptyInspection(manifest: BackupManifest, compatible: boolean, reason: string | null): RestoreInspection {
  return {
    manifest,
    users: 0,
    editions: 0,
    shelves: 0,
    highlights: 0,
    notes: 0,
    bookmarks: 0,
    readingPositions: 0,
    managedFiles: 0,
    missingFiles: [],
    compatible,
    reason,
  };
}

function count(sqlite: Database.Database, sql: string): number {
  const row = sqlite.prepare(sql).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function safeRelative(value: string): string | null {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  return parts.join('/');
}

