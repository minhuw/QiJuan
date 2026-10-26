import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { absoluteBlobPath, writeImmutableBlob } from '../src/blobs.js';
import {
  CatalogError,
  addIndexedAsset,
  addManagedAsset,
  checkIndexedFile,
  checkIndexedLibrary,
  createEdition,
  createSeries,
  getAsset,
  getEdition,
  listAssets,
  listEditions,
  permanentlyDeleteAsset,
  removeCatalogEntry,
  restoreCatalogEntry,
  trashAsset,
} from '../src/catalog.js';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import {
  alternateTitles,
  bookmarks,
  covers,
  editionContributors,
  favorites,
  highlights,
  identifiers,
  libraries,
  notes,
  persons,
  ratings,
  readingPositions,
  readingQueues,
  readingStatuses,
  shelfItems,
  shelves,
  tags,
  users,
} from '../src/schema.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openTemp() {
  const temp = makeTempDir();
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const opened = openDatabase(config.databasePath);
  cleanups.push(() => {
    opened.sqlite.close();
    temp.cleanup();
  });
  return { ...opened, config, dir: temp.dir };
}

function insertLibrary(
  db: ReturnType<typeof openDatabase>['db'],
  input: { name: string; mode: 'managed' | 'indexed'; rootPath: string },
) {
  const row = db
    .insert(libraries)
    .values({ ...input, createdAt: new Date().toISOString() })
    .returning()
    .get();
  if (!row) throw new Error('library insert failed');
  return row;
}

function expectCode(fn: () => unknown, code: CatalogError['code']): void {
  try {
    fn();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).code).toBe(code);
  }
}

describe('managed catalog files', () => {
  it('trashes and restores a managed file without rewriting the blob, then permanently deletes it', () => {
    const { db, dir } = openTemp();
    const root = path.join(dir, 'libraries', '1');
    mkdirSync(root, { recursive: true });
    const library = insertLibrary(db, { name: 'Home', mode: 'managed', rootPath: root });
    const edition = createEdition(db, {
      libraryId: library.id,
      title: 'The Tale',
      language: 'en',
      publisher: 'Home Press',
      publishedDate: '2020-01-02',
      description: 'A short book.',
    });
    const bytes = Buffer.from('managed epub bytes');
    const asset = addManagedAsset(db, {
      dataDir: dir,
      editionId: edition.id,
      bytes,
      originalFilename: '../../Secret.epub',
    });

    expect(asset.storage).toBe('managed');
    expect(asset.originalFilename).toBe('Secret.epub');
    expect(asset.relativePath).toBe(`blobs/${asset.sha256.slice(0, 2)}/${asset.sha256}`);
    expect(asset.availability).toBe('present');
    expect(asset.trashedAt).toBeNull();
    const blobPath = absoluteBlobPath(dir, asset.sha256);
    expect(blobPath).toBe(path.join(dir, 'blobs', asset.sha256.slice(0, 2), asset.sha256));
    expect(existsSync(path.join(root, 'Secret.epub'))).toBe(false);
    const before = statSync(blobPath);
    expect(readFileSync(blobPath).equals(bytes)).toBe(true);

    chmodSync(blobPath, 0o444);
    const again = writeImmutableBlob(dir, bytes);
    expect(again.written).toBe(false);
    expect(statSync(blobPath).ino).toBe(before.ino);
    expect(readFileSync(blobPath).equals(bytes)).toBe(true);
    chmodSync(blobPath, before.mode);

    removeCatalogEntry(db, edition.id);
    expect(listEditions(db, library.id)).toEqual([]);
    expect(listAssets(db, edition.id)).toEqual([]);
    const hidden = getEdition(db, edition.id);
    const hiddenAsset = getAsset(db, asset.id);
    expect(hidden?.title).toBe('The Tale');
    expect(hidden?.trashedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hiddenAsset?.trashedAt).toBe(hidden?.trashedAt);
    expect(statSync(blobPath).ino).toBe(before.ino);

    restoreCatalogEntry(db, edition.id);
    expect(listEditions(db, library.id).map((row) => row.id)).toEqual([edition.id]);
    expect(getEdition(db, edition.id)?.trashedAt).toBeNull();
    expect(getAsset(db, asset.id)?.trashedAt).toBeNull();
    expect(listAssets(db, edition.id).map((row) => row.id)).toEqual([asset.id]);
    expect(readFileSync(blobPath).equals(bytes)).toBe(true);
    expect(statSync(blobPath).ino).toBe(before.ino);

    expectCode(() => permanentlyDeleteAsset(db, { dataDir: dir, assetId: asset.id }), 'not_in_trash');
    expect(existsSync(blobPath)).toBe(true);
    expect(getAsset(db, asset.id)?.id).toBe(asset.id);

    removeCatalogEntry(db, edition.id);
    const deleted = permanentlyDeleteAsset(db, { dataDir: dir, assetId: asset.id });
    expect(deleted.blobRemoved).toBe(true);
    expect(existsSync(blobPath)).toBe(false);
    expect(getAsset(db, asset.id)).toBeNull();
    expect(getEdition(db, edition.id)?.id).toBe(edition.id);
    expect(getEdition(db, edition.id)?.trashedAt).not.toBeNull();
  });

  it('removes a managed blob only when no remaining asset or cover references the hash', () => {
    const { db, dir } = openTemp();
    const library = insertLibrary(db, {
      name: 'Home',
      mode: 'managed',
      rootPath: path.join(dir, 'libraries', 'home'),
    });
    const firstEdition = createEdition(db, { libraryId: library.id, title: 'One' });
    const secondEdition = createEdition(db, { libraryId: library.id, title: 'Two' });
    const bytes = Buffer.from('shared managed bytes');
    const first = addManagedAsset(db, {
      dataDir: dir,
      editionId: firstEdition.id,
      bytes,
      originalFilename: 'one.epub',
    });
    const second = addManagedAsset(db, {
      dataDir: dir,
      editionId: secondEdition.id,
      bytes,
      originalFilename: 'two.epub',
    });
    expect(first.sha256).toBe(second.sha256);
    const blobPath = absoluteBlobPath(dir, first.sha256);
    const inode = statSync(blobPath).ino;

    trashAsset(db, first.id);
    expect(permanentlyDeleteAsset(db, { dataDir: dir, assetId: first.id })).toEqual({ blobRemoved: false });
    expect(existsSync(blobPath)).toBe(true);
    expect(statSync(blobPath).ino).toBe(inode);
    expect(getAsset(db, second.id)?.sha256).toBe(first.sha256);

    const coverEdition = createEdition(db, { libraryId: library.id, title: 'Covered' });
    const covered = addManagedAsset(db, {
      dataDir: dir,
      editionId: coverEdition.id,
      bytes: Buffer.from('covered bytes'),
      originalFilename: 'covered.epub',
    });
    db.insert(covers)
      .values({
        editionId: coverEdition.id,
        sha256: covered.sha256,
        bytes: covered.bytes,
        mediaType: 'image/jpeg',
        relativePath: covered.relativePath,
        createdAt: new Date().toISOString(),
      })
      .run();
    trashAsset(db, covered.id);
    expect(permanentlyDeleteAsset(db, { dataDir: dir, assetId: covered.id })).toEqual({ blobRemoved: false });
    expect(existsSync(absoluteBlobPath(dir, covered.sha256))).toBe(true);

    trashAsset(db, second.id);
    expect(permanentlyDeleteAsset(db, { dataDir: dir, assetId: second.id })).toEqual({ blobRemoved: true });
    expect(existsSync(blobPath)).toBe(false);
  });
});

describe('indexed catalog files', () => {
  it('leaves the original file in place when the catalog entry is removed', () => {
    const { db, dir } = openTemp();
    const root = path.join(dir, 'indexed');
    mkdirSync(path.join(root, 'Author'), { recursive: true });
    const relativePath = 'Author/Tale.epub';
    const absolute = path.join(root, 'Author', 'Tale.epub');
    const bytes = Buffer.from('indexed original');
    writeFileSync(absolute, bytes);
    const before = statSync(absolute);
    const library = insertLibrary(db, { name: 'Shelf', mode: 'indexed', rootPath: root });
    const edition = createEdition(db, { libraryId: library.id, title: 'Tale' });
    const asset = addIndexedAsset(db, { editionId: edition.id, relativePath });

    expect(asset.storage).toBe('indexed');
    expect(asset.relativePath).toBe(relativePath);
    expect(asset.sha256).toHaveLength(64);
    expect(existsSync(absoluteBlobPath(dir, asset.sha256))).toBe(false);
    expect(statSync(absolute).ino).toBe(before.ino);

    removeCatalogEntry(db, edition.id);
    const after = statSync(absolute);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
    expect(readFileSync(absolute).equals(bytes)).toBe(true);
    expect(getEdition(db, edition.id)?.trashedAt).not.toBeNull();
    expect(getAsset(db, asset.id)).toMatchObject({
      relativePath,
      trashedAt: expect.any(String),
      availability: 'present',
    });
    expect(listEditions(db, library.id)).toEqual([]);

    expectCode(() => permanentlyDeleteAsset(db, { dataDir: dir, assetId: asset.id }), 'indexed_permanent_delete');
    expect(statSync(absolute).ino).toBe(before.ino);
    expect(readFileSync(absolute).equals(bytes)).toBe(true);
    expect(getAsset(db, asset.id)?.id).toBe(asset.id);

    db.delete(libraries).where(eq(libraries.id, library.id)).run();
    expect(readFileSync(absolute).equals(bytes)).toBe(true);
    expect(statSync(absolute).ino).toBe(before.ino);
  });

  it('marks an indexed file missing when the library path or file is absent, and present when it returns', () => {
    const { db, dir } = openTemp();
    const root = path.join(dir, 'indexed');
    mkdirSync(root);
    const relativePath = 'Tale.epub';
    const absolute = path.join(root, relativePath);
    const bytes = Buffer.from('mounted book');
    writeFileSync(absolute, bytes);
    const library = insertLibrary(db, { name: 'Mounted', mode: 'indexed', rootPath: root });
    const edition = createEdition(db, { libraryId: library.id, title: 'Mounted tale' });
    const asset = addIndexedAsset(db, { editionId: edition.id, relativePath, format: 'epub' });
    expect(checkIndexedFile(db, asset.id)).toBe('present');

    unlinkSync(absolute);
    expect(checkIndexedFile(db, asset.id)).toBe('missing');
    expect(getEdition(db, edition.id)).toMatchObject({ id: edition.id, title: 'Mounted tale', trashedAt: null });
    expect(getAsset(db, asset.id)).toMatchObject({
      id: asset.id,
      availability: 'missing',
      trashedAt: null,
      relativePath,
    });
    expect(db.select().from(libraries).where(eq(libraries.id, library.id)).get()?.rootPath).toBe(root);

    writeFileSync(absolute, bytes);
    expect(checkIndexedFile(db, asset.id)).toBe('present');
    expect(getAsset(db, asset.id)?.trashedAt).toBeNull();
    expect(getEdition(db, edition.id)?.trashedAt).toBeNull();

    const moved = path.join(dir, 'indexed-away');
    renameSync(root, moved);
    expect(checkIndexedLibrary(db, library.id)).toEqual({ checked: 1, present: 0, missing: 1 });
    expect(getEdition(db, edition.id)).toMatchObject({ id: edition.id, title: 'Mounted tale', trashedAt: null });
    expect(getAsset(db, asset.id)).toMatchObject({ availability: 'missing', trashedAt: null, relativePath });
    expect(db.select().from(libraries).where(eq(libraries.id, library.id)).get()?.rootPath).toBe(root);
    expect(readFileSync(path.join(moved, relativePath)).equals(bytes)).toBe(true);
    expect(listEditions(db, library.id).map((row) => row.id)).toEqual([edition.id]);

    renameSync(moved, root);
    expect(checkIndexedFile(db, asset.id)).toBe('present');
    expect(getAsset(db, asset.id)?.availability).toBe('present');
    expect(getEdition(db, edition.id)?.trashedAt).toBeNull();
    expect(readFileSync(absolute).equals(bytes)).toBe(true);
  });

  it('does not follow an indexed path out of the library root', () => {
    const { db, dir } = openTemp();
    const root = path.join(dir, 'indexed');
    mkdirSync(root);
    const outside = path.join(dir, 'secret.epub');
    writeFileSync(outside, 'do not touch');
    symlinkSync(outside, path.join(root, 'link.epub'));
    const library = insertLibrary(db, { name: 'Indexed', mode: 'indexed', rootPath: root });
    const edition = createEdition(db, { libraryId: library.id, title: 'Outside' });

    expectCode(() => addIndexedAsset(db, { editionId: edition.id, relativePath: '../secret.epub' }), 'invalid_path');
    expectCode(() => addIndexedAsset(db, { editionId: edition.id, relativePath: 'link.epub' }), 'invalid_path');
    expectCode(() => addIndexedAsset(db, { editionId: edition.id, relativePath: 'missing.epub' }), 'file_missing');
    expect(readFileSync(outside).toString()).toBe('do not touch');
    expect(listAssets(db, edition.id)).toEqual([]);
    expect(getEdition(db, edition.id)?.trashedAt).toBeNull();
  });
});

describe('catalog records', () => {
  it('stores editions, people, identifiers, shelves, and a locator revision', () => {
    const { db, sqlite, dir } = openTemp();
    const now = new Date().toISOString();
    const user = db
      .insert(users)
      .values({ username: 'ada', passwordHash: 'hash', role: 'admin', createdAt: now })
      .returning()
      .get();
    if (!user) throw new Error('user insert failed');
    const library = insertLibrary(db, {
      name: 'Home',
      mode: 'managed',
      rootPath: path.join(dir, 'libraries', 'home'),
    });
    const series = createSeries(db, { libraryId: library.id, name: 'Rivers', sortName: 'Rivers' });
    const edition = createEdition(db, {
      libraryId: library.id,
      title: 'The Long River',
      sortTitle: 'Long River, The',
      language: 'en',
      publisher: 'North Press',
      publishedDate: '2019',
      description: 'Volume two.',
      seriesId: series.id,
      seriesOrder: 2.5,
    });
    expect(getEdition(db, edition.id)?.seriesOrder).toBe(2.5);

    db.insert(alternateTitles).values({ editionId: edition.id, title: 'Le Long Fleuve', sortTitle: 'Long Fleuve' }).run();
    const author = db
      .insert(persons)
      .values({ name: 'Ada Lovelace', sortName: 'Lovelace, Ada', createdAt: now })
      .returning()
      .get();
    const translator = db
      .insert(persons)
      .values({ name: 'Grace Hopper', sortName: 'Hopper, Grace', createdAt: now })
      .returning()
      .get();
    if (!author || !translator) throw new Error('person insert failed');
    db.insert(editionContributors)
      .values([
        { editionId: edition.id, personId: author.id, role: 'author', position: 0 },
        { editionId: edition.id, personId: translator.id, role: 'translator', position: 1 },
      ])
      .run();
    db.insert(tags).values({ editionId: edition.id, name: 'fiction', createdAt: now }).run();
    db.insert(identifiers).values({ editionId: edition.id, scheme: 'isbn', value: '9780000000001' }).run();
    const asset = addManagedAsset(db, {
      dataDir: dir,
      editionId: edition.id,
      bytes: Buffer.from('body'),
      originalFilename: 'river.epub',
    });
    db.insert(covers)
      .values({
        editionId: edition.id,
        sha256: asset.sha256,
        bytes: asset.bytes,
        mediaType: 'image/png',
        relativePath: asset.relativePath,
        createdAt: now,
      })
      .run();
    const shelf = db
      .insert(shelves)
      .values({ userId: user.id, name: 'Weekend', position: 0, createdAt: now })
      .returning()
      .get();
    if (!shelf) throw new Error('shelf insert failed');
    db.insert(shelfItems).values({ shelfId: shelf.id, editionId: edition.id, position: 0, addedAt: now }).run();
    db.insert(favorites).values({ userId: user.id, editionId: edition.id, createdAt: now }).run();
    db.insert(readingQueues).values({ userId: user.id, editionId: edition.id, position: 0, addedAt: now }).run();
    db.insert(ratings).values({ userId: user.id, editionId: edition.id, rating: 5, updatedAt: now }).run();
    db.insert(readingStatuses)
      .values({ userId: user.id, editionId: edition.id, status: 'on_hold', updatedAt: now })
      .run();
    const locator = 'epubcfi(/6/2!/4/1:0)';
    db.insert(bookmarks)
      .values({
        userId: user.id,
        editionId: edition.id,
        assetId: asset.id,
        locator,
        label: 'Start',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(highlights)
      .values({
        userId: user.id,
        editionId: edition.id,
        assetId: asset.id,
        locator,
        quote: 'hello',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(notes).values({ userId: user.id, editionId: edition.id, body: 'Remember this.', createdAt: now, updatedAt: now }).run();
    db.insert(readingPositions)
      .values({ userId: user.id, editionId: edition.id, assetId: asset.id, locator, revision: 1, updatedAt: now })
      .run();
    db.update(readingPositions)
      .set({ locator: 'epubcfi(/6/4!/4/2:10)', revision: 2, updatedAt: now })
      .where(eq(readingPositions.editionId, edition.id))
      .run();

    const position = db.select().from(readingPositions).where(eq(readingPositions.userId, user.id)).get();
    expect(position).toMatchObject({ locator: 'epubcfi(/6/4!/4/2:10)', revision: 2, assetId: asset.id });
    expect(position?.locator.includes('%')).toBe(false);

    expect(() => sqlite.prepare("INSERT INTO edition_contributors (edition_id, person_id, role, position) VALUES (?, ?, 'illustrator', 0)").run(edition.id, author.id)).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'mobi', ?, 1, 'a.mobi', 'managed', 'blobs/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'present', ?)`,
        )
        .run(edition.id, 'a'.repeat(64), now),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare('INSERT INTO reading_statuses (user_id, edition_id, status, updated_at) VALUES (?, ?, ?, ?)')
        .run(user.id, edition.id, 'abandoned', now),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare('INSERT INTO reading_positions (user_id, edition_id, revision, updated_at) VALUES (?, ?, 1, ?)')
        .run(user.id, edition.id, now),
    ).toThrow();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'series',
        'editions',
        'alternate_titles',
        'persons',
        'edition_contributors',
        'tags',
        'identifiers',
        'file_assets',
        'covers',
        'shelves',
        'shelf_items',
        'favorites',
        'reading_queues',
        'ratings',
        'reading_statuses',
        'bookmarks',
        'highlights',
        'notes',
        'reading_positions',
      ]),
    );
  });
});
