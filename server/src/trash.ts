import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  CatalogError,
  permanentlyDeleteAsset,
  removeCatalogEntry,
  restoreAsset,
  restoreCatalogEntry,
  trashAsset,
} from './catalog.js';
import type { AppDatabase } from './db.js';
import { latestCover, loadNames, releaseUnreferenced } from './edition-fields.js';
import { editionAssetFilenames } from './file-names.js';
import { discardPendingPreviews } from './metadata/privacy.js';
import { covers, editionRatingsQueue, editions, fileAssets, metadataPreviews } from './schema.js';

export interface TrashFile {
  id: number;
  format: 'epub' | 'pdf';
  /** managed: uploaded into QiJuan; indexed: a file in a folder library, never touched on disk. */
  storage: 'managed' | 'indexed';
  originalFilename: string;
  /** The metadata name from file-names.ts, as on the book page. */
  displayFilename: string;
  bytes: number;
}

export interface TrashedEdition {
  id: number;
  libraryId: number;
  title: string;
  authors: string[];
  hasCover: boolean;
  trashedAt: string;
  files: TrashFile[];
}

export interface TrashedAsset extends TrashFile {
  editionId: number;
  editionTitle: string;
  trashedAt: string;
}

export interface TrashListing {
  editions: TrashedEdition[];
  /** Files trashed on their own from editions that are still in the library. */
  assets: TrashedAsset[];
}

/**
 * Moves a live edition and its files to trash, and discards its pending (unapplied) lookup
 * previews with their staged covers. Reading state, shelves and annotations stay, so a restore
 * brings everything back.
 */
export function trashEdition(
  db: AppDatabase,
  dataDir: string,
  editionId: number,
  now = new Date(),
): { id: number; title: string; trashedAt: string } {
  const result = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = requireEditionRow(query, editionId);
    if (edition.trashedAt) throw new CatalogError('not_found');
    removeCatalogEntry(query, edition.id, now);
    const released = discardPendingPreviews(query, edition.id);
    const trashed = query.select({ trashedAt: editions.trashedAt }).from(editions).where(eq(editions.id, edition.id)).get();
    return { id: edition.id, title: edition.title, trashedAt: trashed?.trashedAt ?? now.toISOString(), released };
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, result.released);
  return { id: result.id, title: result.title, trashedAt: result.trashedAt };
}

/** Brings a trashed edition back with the files trashed with it. */
export function restoreEdition(db: AppDatabase, editionId: number, now = new Date()): void {
  const edition = requireEditionRow(db, editionId);
  if (!edition.trashedAt) throw new CatalogError('not_in_trash');
  restoreCatalogEntry(db, edition.id, now);
}

/**
 * Deletes a trashed edition and every row that hangs off it (by foreign-key cascade). Managed
 * book blobs and cover images are removed only when nothing else references their hash.
 * Files of folder (indexed) libraries are forgotten and never touched on disk.
 */
export function deleteEdition(db: AppDatabase, dataDir: string, editionId: number): void {
  const hashes = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = requireEditionRow(query, editionId);
    if (!edition.trashedAt) throw new CatalogError('not_in_trash');
    const managed = query
      .select({ sha256: fileAssets.sha256 })
      .from(fileAssets)
      .where(and(eq(fileAssets.editionId, edition.id), eq(fileAssets.storage, 'managed')))
      .all()
      .map((row) => row.sha256);
    const coverHashes = query
      .select({ sha256: covers.sha256 })
      .from(covers)
      .where(eq(covers.editionId, edition.id))
      .all()
      .map((row) => row.sha256);
    const staged = query
      .select({ sha256: metadataPreviews.coverSha256 })
      .from(metadataPreviews)
      .where(and(eq(metadataPreviews.editionId, edition.id), isNotNull(metadataPreviews.coverSha256)))
      .all()
      .flatMap((row) => (row.sha256 ? [row.sha256] : []));
    query.delete(editions).where(eq(editions.id, edition.id)).run();
    // The queue has no foreign key; its identifier triggers fire during the cascade.
    query.delete(editionRatingsQueue).where(eq(editionRatingsQueue.editionId, edition.id)).run();
    return [...new Set([...managed, ...coverHashes, ...staged])];
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, hashes);
}

/** Trashes one file of a live edition. The edition's last live file stays. */
export function trashEditionAsset(db: AppDatabase, editionId: number, assetId: number, now = new Date()): void {
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const asset = requireLiveEditionAsset(query, editionId, assetId);
    if (asset.trashedAt) return;
    const others = query
      .select({ count: sql<number>`count(*)` })
      .from(fileAssets)
      .where(and(eq(fileAssets.editionId, asset.editionId), isNull(fileAssets.trashedAt), ne(fileAssets.id, asset.id)))
      .get();
    if (Number(others?.count ?? 0) === 0) throw new CatalogError('last_asset');
    trashAsset(query, asset.id, now);
  }, { behavior: 'immediate' });
}

export function restoreEditionAsset(db: AppDatabase, editionId: number, assetId: number): void {
  const asset = requireLiveEditionAsset(db, editionId, assetId);
  if (!asset.trashedAt) throw new CatalogError('not_in_trash');
  restoreAsset(db, asset.id);
}

/**
 * Deletes one trashed file of a live edition. A managed blob goes when nothing else references it;
 * a folder file is only forgotten, never touched on disk.
 */
export function deleteEditionAsset(db: AppDatabase, dataDir: string, editionId: number, assetId: number): void {
  const asset = requireLiveEditionAsset(db, editionId, assetId);
  if (!asset.trashedAt) throw new CatalogError('not_in_trash');
  if (asset.storage === 'managed') {
    permanentlyDeleteAsset(db, { dataDir, assetId: asset.id });
    return;
  }
  db.delete(fileAssets).where(and(eq(fileAssets.id, asset.id), isNotNull(fileAssets.trashedAt))).run();
}

/** Trashed editions, newest first, and files trashed on their own from live editions. */
export function listTrash(db: AppDatabase, libraryIds: number[]): TrashListing {
  if (libraryIds.length === 0) return { editions: [], assets: [] };
  const rows = db
    .select({ id: editions.id, libraryId: editions.libraryId, title: editions.title, trashedAt: editions.trashedAt })
    .from(editions)
    .where(and(inArray(editions.libraryId, libraryIds), isNotNull(editions.trashedAt)))
    .orderBy(desc(editions.trashedAt), desc(editions.id))
    .all();
  const trashedEditions: TrashedEdition[] = rows.map((row) => ({
    id: row.id,
    libraryId: row.libraryId,
    title: row.title,
    authors: loadNames(db, row.id, 'author'),
    hasCover: latestCover(db, row.id) !== null,
    trashedAt: row.trashedAt ?? '',
    files: db
      .select(FILE_COLUMNS)
      .from(fileAssets)
      .where(eq(fileAssets.editionId, row.id))
      .orderBy(asc(fileAssets.id))
      .all()
      .map((file) => toTrashFile(db, row.id, file)),
  }));
  const assets = db
    .select({ ...FILE_COLUMNS, editionId: fileAssets.editionId, editionTitle: editions.title, trashedAt: fileAssets.trashedAt })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .where(and(inArray(editions.libraryId, libraryIds), isNull(editions.trashedAt), isNotNull(fileAssets.trashedAt)))
    .orderBy(desc(fileAssets.trashedAt), desc(fileAssets.id))
    .all()
    .map((row) => ({
      ...toTrashFile(db, row.editionId, row),
      editionId: row.editionId,
      editionTitle: row.editionTitle,
      trashedAt: row.trashedAt ?? '',
    }));
  return { editions: trashedEditions, assets };
}

const FILE_COLUMNS = {
  id: fileAssets.id,
  format: fileAssets.format,
  storage: fileAssets.storage,
  originalFilename: fileAssets.originalFilename,
  bytes: fileAssets.bytes,
};

function toTrashFile(
  db: AppDatabase,
  editionId: number,
  row: { id: number; format: string; storage: string; originalFilename: string; bytes: number },
): TrashFile {
  return {
    id: row.id,
    format: row.format === 'pdf' ? 'pdf' : 'epub',
    storage: row.storage === 'indexed' ? 'indexed' : 'managed',
    originalFilename: row.originalFilename,
    displayFilename: editionAssetFilenames(db, editionId, { includeTrashed: true }).get(row.id) ?? row.originalFilename,
    bytes: row.bytes,
  };
}

function requireEditionRow(db: AppDatabase, editionId: number): typeof editions.$inferSelect {
  if (!Number.isInteger(editionId) || editionId < 1) throw new CatalogError('invalid_request');
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition) throw new CatalogError('not_found');
  return edition;
}

function requireLiveEditionAsset(db: AppDatabase, editionId: number, assetId: number): typeof fileAssets.$inferSelect {
  const edition = requireEditionRow(db, editionId);
  if (edition.trashedAt) throw new CatalogError('not_found');
  if (!Number.isInteger(assetId) || assetId < 1) throw new CatalogError('invalid_request');
  const asset = db.select().from(fileAssets).where(eq(fileAssets.id, assetId)).get();
  if (!asset || asset.editionId !== edition.id) throw new CatalogError('not_found');
  return asset;
}
