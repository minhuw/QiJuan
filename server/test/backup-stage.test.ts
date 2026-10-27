import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupJobError } from '../src/backup/model.js';
import { installSnapshotFiles, removeStage, stageBackup } from '../src/backup/stage.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

function writeManifest(root: string, metadataOnly: boolean): void {
  const manifest = {
    format: 1,
    app: 'qijuan',
    appVersion: '0.0.0',
    schemaVersion: '0001_init.sql',
    createdAt: '2026-04-01T00:00:00.000Z',
    scope: metadataOnly ? 'metadata-only' : 'managed',
    metadataOnly,
    storageMap: {
      database: 'qijuan.sqlite',
      secret: 'session.secret',
      blobs: metadataOnly ? null : 'blobs',
      indexed: null,
      recover: 'recover.json',
      libraries: [],
    },
  };
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(root, 'qijuan.sqlite'), 'snapshot-db');
  writeFileSync(path.join(root, 'session.secret'), 'snapshot-secret');
}

describe('installSnapshotFiles', () => {
  it('does not delete or replace managed blobs for a metadata-only snapshot', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      mkdirSync(path.join(snapshot.dir, 'blobs', 'cd'), { recursive: true });
      writeFileSync(path.join(snapshot.dir, 'blobs', 'cd', 'other'), 'snapshot-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite-wal'), 'wal');
      writeManifest(snapshot.dir, true);

      installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'));

      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('snapshot-db');
      expect(readFileSync(path.join(data.dir, 'session.secret'), 'utf8')).toBe('snapshot-secret');
      expect(existsSync(path.join(data.dir, 'qijuan.sqlite-wal'))).toBe(false);
      expect(readFileSync(path.join(live, 'book'), 'utf8')).toBe('live-book');
      expect(existsSync(path.join(data.dir, 'blobs', 'cd', 'other'))).toBe(false);
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });

  it('replaces managed blobs for a full snapshot', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      mkdirSync(path.join(snapshot.dir, 'blobs', 'cd'), { recursive: true });
      writeFileSync(path.join(snapshot.dir, 'blobs', 'cd', 'other'), 'snapshot-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeManifest(snapshot.dir, false);

      installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'));

      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('snapshot-db');
      expect(existsSync(path.join(live, 'book'))).toBe(false);
      expect(readFileSync(path.join(data.dir, 'blobs', 'cd', 'other'), 'utf8')).toBe('snapshot-book');
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });

  it('leaves the data directory alone when the manifest cannot be read', () => {
    const data = makeTempDir();
    const snapshot = makeTempDir();
    try {
      const live = path.join(data.dir, 'blobs', 'ab');
      mkdirSync(live, { recursive: true });
      writeFileSync(path.join(live, 'book'), 'live-book');
      writeFileSync(path.join(data.dir, 'qijuan.sqlite'), 'old-db');
      writeFileSync(path.join(snapshot.dir, 'manifest.json'), '{');
      writeFileSync(path.join(snapshot.dir, 'qijuan.sqlite'), 'snapshot-db');
      writeFileSync(path.join(snapshot.dir, 'session.secret'), 'snapshot-secret');

      expect(() => installSnapshotFiles(snapshot.dir, data.dir, path.join(data.dir, 'qijuan.sqlite'))).toThrow(/manifest/);
      expect(readFileSync(path.join(data.dir, 'qijuan.sqlite'), 'utf8')).toBe('old-db');
      expect(readFileSync(path.join(live, 'book'), 'utf8')).toBe('live-book');
      expect(existsSync(path.join(data.dir, 'session.secret'))).toBe(false);
    } finally {
      data.cleanup();
      snapshot.cleanup();
    }
  });
});

describe('stageBackup indexed file hashes', () => {
  it('fails when a present indexed path is a symlink with different bytes or not a regular file', async () => {
    const temp = makeTempDir();
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    migrate({ databasePath, migrationsDir: defaultMigrationsDir() });
    const opened = openDatabase(databasePath);
    try {
      const libraryRoot = path.join(temp.dir, 'shelf');
      const bookPath = path.join(libraryRoot, 'book.epub');
      const samePath = path.join(libraryRoot, 'same.epub');
      const otherPath = path.join(libraryRoot, 'other.epub');
      const outsidePath = path.join(temp.dir, 'outside.epub');
      const bookText = 'original-book-bytes';
      const bookSha = createHash('sha256').update(bookText).digest('hex');
      mkdirSync(libraryRoot, { recursive: true });
      writeFileSync(bookPath, bookText);
      writeFileSync(samePath, bookText);
      writeFileSync(otherPath, 'tampered-target-bytes');
      writeFileSync(outsidePath, bookText);
      writeFileSync(path.join(temp.dir, 'session.secret'), 'stage-secret');
      const now = '2026-04-01T00:00:00.000Z';
      const libraryId = Number(
        opened.sqlite
          .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?)`)
          .run(libraryRoot, now).lastInsertRowid,
      );
      const editionId = Number(
        opened.sqlite
          .prepare(
            `INSERT INTO editions (library_id, title, sort_title, created_at, updated_at)
             VALUES (?, 'Tale', 'Tale', ?, ?)`,
          )
          .run(libraryId, now, now).lastInsertRowid,
      );
      const assetId = Number(
        opened.sqlite
          .prepare(
            `INSERT INTO file_assets (
              edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
            ) VALUES (?, 'epub', ?, ?, 'book.epub', 'indexed', 'book.epub', 'present', ?)`,
          )
          .run(editionId, bookSha, Buffer.byteLength(bookText), now).lastInsertRowid,
      );
      opened.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'epub', ?, ?, 'absent.epub', 'indexed', 'absent.epub', 'present', ?)`,
        )
        .run(editionId, bookSha, Buffer.byteLength(bookText), now);

      const stage = () =>
        stageBackup({
          sqlite: opened.sqlite,
          db: opened.db,
          dataDir: temp.dir,
          migrationsDir: defaultMigrationsDir(),
          openLibraryOrigin: 'https://openlibrary.org',
          scope: 'managed',
          indexedLibraryIds: [libraryId],
        });
      const catalogSha = () =>
        (opened.sqlite.prepare('SELECT sha256 FROM file_assets WHERE id = ?').get(assetId) as { sha256: string }).sha256;
      const removeBook = () => {
        try {
          const info = lstatSync(bookPath);
          if (info.isSymbolicLink() || !info.isDirectory()) {
            unlinkSync(bookPath);
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        rmSync(bookPath, { recursive: true, force: true });
      };
      const expectChanged = async () => {
        let caught: unknown;
        try {
          await stage();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(BackupJobError);
        const message = (caught as Error).message;
        expect(message).toMatch(/changed/i);
        expect(message).toContain(bookPath);
        expect(message).toMatch(/last successful snapshot/i);
        expect(catalogSha()).toBe(bookSha);
      };
      const expectStaged = async (copied: boolean) => {
        const staged = await stage();
        try {
          const copiedPath = path.join(staged.root, 'indexed', String(libraryId), 'book.epub');
          if (copied) expect(readFileSync(copiedPath, 'utf8')).toBe(bookText);
          expect(catalogSha()).toBe(bookSha);
        } finally {
          removeStage(staged.root);
        }
      };

      await expectStaged(true);

      removeBook();
      symlinkSync(otherPath, bookPath);
      await expectChanged();

      removeBook();
      symlinkSync(samePath, bookPath);
      await expectStaged(false);

      removeBook();
      mkdirSync(bookPath);
      writeFileSync(path.join(bookPath, 'nested.txt'), 'not the book');
      await expectChanged();

      removeBook();
      execFileSync('mkfifo', [bookPath]);
      await expectChanged();

      removeBook();
      symlinkSync(outsidePath, bookPath);
      await expectChanged();

      removeBook();
      symlinkSync(libraryRoot, bookPath);
      await expectChanged();

      removeBook();
      symlinkSync(path.join(libraryRoot, 'missing-target.epub'), bookPath);
      await expectChanged();

      removeBook();
      writeFileSync(bookPath, bookText);
      await expectStaged(true);
    } finally {
      opened.sqlite.close();
      temp.cleanup();
    }
  });
});
