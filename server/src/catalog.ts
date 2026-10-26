import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { hashFile, managedBlobRelativePath, removeBlobFile, writeImmutableBlob } from './blobs.js';
import type { AppDatabase } from './db.js';
import { covers, editions, fileAssets, libraries, series } from './schema.js';

const TITLE_MAX = 500;
const NAME_MAX = 300;
const LANGUAGE_MAX = 35;
const PUBLISHER_MAX = 300;
const PUBLISHED_DATE_MAX = 40;
const DESCRIPTION_MAX = 100_000;
const RELATIVE_PATH_MAX = 2048;

export type FileFormat = 'epub' | 'pdf';
export type Availability = 'present' | 'missing';

export class CatalogError extends Error {
  readonly code:
    | 'not_found'
    | 'invalid_request'
    | 'library_mode'
    | 'invalid_path'
    | 'file_missing'
    | 'not_in_trash'
    | 'indexed_permanent_delete'
    | 'not_indexed'
    | 'conflict';

  constructor(code: CatalogError['code']) {
    super(code);
    this.name = 'CatalogError';
    this.code = code;
  }
}

export type EditionRow = typeof editions.$inferSelect;
export type FileAssetRow = typeof fileAssets.$inferSelect;
export type SeriesRow = typeof series.$inferSelect;

export interface CreateSeriesInput {
  libraryId: number;
  name: string;
  sortName?: string;
}

export interface CreateEditionInput {
  libraryId: number;
  title: string;
  sortTitle?: string;
  language?: string | null;
  publisher?: string | null;
  publishedDate?: string | null;
  description?: string | null;
  seriesId?: number | null;
  seriesOrder?: number | null;
}

export interface AddManagedAssetInput {
  dataDir: string;
  editionId: number;
  bytes: Buffer;
  format?: FileFormat;
  originalFilename: string;
}

export interface AddIndexedAssetInput {
  editionId: number;
  relativePath: string;
  format?: FileFormat;
  originalFilename?: string;
}

export interface PermanentDeleteResult {
  blobRemoved: boolean;
}

type QueryDb = Pick<AppDatabase, 'insert' | 'select' | 'update' | 'delete'>;

export function createSeries(db: AppDatabase, input: CreateSeriesInput, now = new Date()): SeriesRow {
  const libraryId = requireId(input.libraryId);
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get();
  if (!library) throw new CatalogError('not_found');
  const name = requireText(input.name, NAME_MAX);
  const sortName = input.sortName === undefined ? name : requireText(input.sortName, NAME_MAX);
  try {
    const inserted = db
      .insert(series)
      .values({ libraryId, name, sortName, createdAt: now.toISOString() })
      .returning()
      .get();
    if (!inserted) throw new CatalogError('invalid_request');
    return inserted;
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (isUniqueConstraint(error)) throw new CatalogError('conflict');
    throw error;
  }
}

export function createEdition(db: AppDatabase, input: CreateEditionInput, now = new Date()): EditionRow {
  const libraryId = requireId(input.libraryId);
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get();
  if (!library) throw new CatalogError('not_found');
  const title = requireText(input.title, TITLE_MAX);
  const sortTitle = input.sortTitle === undefined ? title : requireText(input.sortTitle, TITLE_MAX);
  const language = optionalText(input.language, LANGUAGE_MAX);
  const publisher = optionalText(input.publisher, PUBLISHER_MAX);
  const publishedDate = optionalText(input.publishedDate, PUBLISHED_DATE_MAX);
  const description = optionalDescription(input.description);
  const seriesId = input.seriesId == null ? null : requireId(input.seriesId);
  const seriesOrder = normalizeSeriesOrder(input.seriesOrder);
  if (seriesId == null && seriesOrder != null) throw new CatalogError('invalid_request');
  if (seriesId != null) {
    const found = db
      .select({ libraryId: series.libraryId })
      .from(series)
      .where(eq(series.id, seriesId))
      .get();
    if (!found || found.libraryId !== libraryId) throw new CatalogError('not_found');
  }
  const stamp = now.toISOString();
  const inserted = db
    .insert(editions)
    .values({
      libraryId,
      title,
      sortTitle,
      language,
      publisher,
      publishedDate,
      description,
      seriesId,
      seriesOrder,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return inserted;
}

export function getEdition(db: AppDatabase, editionId: number): EditionRow | null {
  if (!Number.isInteger(editionId) || editionId < 1) return null;
  return db.select().from(editions).where(eq(editions.id, editionId)).get() ?? null;
}

/** Catalog listings hide removed entries. Trashed rows stay in the database. */
export function listEditions(db: AppDatabase, libraryId: number): EditionRow[] {
  if (!Number.isInteger(libraryId) || libraryId < 1) throw new CatalogError('invalid_request');
  return db
    .select()
    .from(editions)
    .where(and(eq(editions.libraryId, libraryId), isNull(editions.trashedAt)))
    .orderBy(asc(editions.sortTitle), asc(editions.id))
    .all();
}

export function getAsset(db: AppDatabase, assetId: number): FileAssetRow | null {
  if (!Number.isInteger(assetId) || assetId < 1) return null;
  return db.select().from(fileAssets).where(eq(fileAssets.id, assetId)).get() ?? null;
}

export function listAssets(
  db: AppDatabase,
  editionId: number,
  options?: { includeTrashed?: boolean },
): FileAssetRow[] {
  if (!Number.isInteger(editionId) || editionId < 1) throw new CatalogError('invalid_request');
  const where = options?.includeTrashed
    ? eq(fileAssets.editionId, editionId)
    : and(eq(fileAssets.editionId, editionId), isNull(fileAssets.trashedAt));
  return db.select().from(fileAssets).where(where).orderBy(asc(fileAssets.id)).all();
}

/**
 * Stores immutable bytes at `data/blobs/<sha256 prefix>/<sha256>` and records a managed asset.
 * The original filename is metadata only and is never used as a storage path.
 */
export function addManagedAsset(db: AppDatabase, input: AddManagedAssetInput, now = new Date()): FileAssetRow {
  const editionId = requireId(input.editionId);
  const { library } = requireEdition(db, editionId);
  if (library.mode !== 'managed') throw new CatalogError('library_mode');
  if (!Buffer.isBuffer(input.bytes)) throw new CatalogError('invalid_request');
  const originalFilename = fileBaseName(input.originalFilename);
  const format = resolveFormat(originalFilename, input.format);
  const blob = writeImmutableBlob(input.dataDir, input.bytes);
  const inserted = db
    .insert(fileAssets)
    .values({
      editionId,
      format,
      sha256: blob.sha256,
      bytes: blob.bytes,
      originalFilename,
      storage: 'managed',
      relativePath: blob.relativePath,
      availability: 'present',
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return inserted;
}

/**
 * Records an indexed file by a path relative to its library root.
 * The file is hashed in place and is not copied, moved, or deleted.
 */
export function addIndexedAsset(db: AppDatabase, input: AddIndexedAssetInput, now = new Date()): FileAssetRow {
  const editionId = requireId(input.editionId);
  const { library } = requireEdition(db, editionId);
  if (library.mode !== 'indexed') throw new CatalogError('library_mode');
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath) throw new CatalogError('invalid_path');
  const inspection = inspectIndexedFile(library.rootPath, relativePath);
  if (inspection.status === 'invalid') throw new CatalogError('invalid_path');
  if (inspection.status === 'missing') throw new CatalogError('file_missing');
  const originalFilename =
    input.originalFilename === undefined ? fileBaseName(relativePath) : fileBaseName(input.originalFilename);
  const format = resolveFormat(relativePath, input.format);
  const hashed = hashFile(inspection.absolutePath);
  const inserted = db
    .insert(fileAssets)
    .values({
      editionId,
      format,
      sha256: hashed.sha256,
      bytes: hashed.bytes,
      originalFilename,
      storage: 'indexed',
      relativePath,
      availability: 'present',
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return inserted;
}

/**
 * Hides a catalog entry and marks its files trashed. Rows and on-disk originals stay.
 * Managed blobs stay until an explicit permanent delete.
 */
export function removeCatalogEntry(db: AppDatabase, editionId: number, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const edition = tx
      .select({ id: editions.id, trashedAt: editions.trashedAt })
      .from(editions)
      .where(eq(editions.id, requireId(editionId)))
      .get();
    if (!edition) throw new CatalogError('not_found');
    if (!edition.trashedAt) {
      tx.update(editions)
        .set({ trashedAt: stamp, updatedAt: stamp })
        .where(eq(editions.id, edition.id))
        .run();
    }
    tx.update(fileAssets)
      .set({ trashedAt: stamp })
      .where(and(eq(fileAssets.editionId, edition.id), isNull(fileAssets.trashedAt)))
      .run();
  }, { behavior: 'immediate' });
}

/** Clears trashed time on the edition and its files. Does not move or rewrite bytes. */
export function restoreCatalogEntry(db: AppDatabase, editionId: number, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const edition = tx
      .select({ id: editions.id })
      .from(editions)
      .where(eq(editions.id, requireId(editionId)))
      .get();
    if (!edition) throw new CatalogError('not_found');
    tx.update(editions).set({ trashedAt: null, updatedAt: stamp }).where(eq(editions.id, edition.id)).run();
    tx.update(fileAssets).set({ trashedAt: null }).where(eq(fileAssets.editionId, edition.id)).run();
  }, { behavior: 'immediate' });
}

export function trashAsset(db: AppDatabase, assetId: number, now = new Date()): void {
  const stamp = now.toISOString();
  const asset = requireAsset(db, assetId);
  if (asset.trashedAt) return;
  db.update(fileAssets).set({ trashedAt: stamp }).where(eq(fileAssets.id, asset.id)).run();
}

export function restoreAsset(db: AppDatabase, assetId: number): void {
  const asset = requireAsset(db, assetId);
  if (!asset.trashedAt) return;
  db.update(fileAssets).set({ trashedAt: null }).where(eq(fileAssets.id, asset.id)).run();
}

/**
 * Deletes a managed asset that is already in trash.
 * The blob is removed only when no file asset or cover still references that hash.
 * Indexed assets are refused and their originals are left untouched.
 */
export function permanentlyDeleteAsset(
  db: AppDatabase,
  input: { dataDir: string; assetId: number },
): PermanentDeleteResult {
  const assetId = requireId(input.assetId);
  return db.transaction((tx) => {
    const current = tx.select().from(fileAssets).where(eq(fileAssets.id, assetId)).get();
    if (!current) throw new CatalogError('not_found');
    if (current.storage === 'indexed') throw new CatalogError('indexed_permanent_delete');
    if (current.storage !== 'managed') throw new CatalogError('invalid_request');
    if (!current.trashedAt) throw new CatalogError('not_in_trash');
    if (current.relativePath !== managedBlobRelativePath(current.sha256)) throw new CatalogError('invalid_path');

    tx.delete(fileAssets).where(eq(fileAssets.id, current.id)).run();
    if (countSha256(tx, current.sha256) > 0) return { blobRemoved: false };
    return { blobRemoved: removeBlobFile(input.dataDir, current.sha256) };
  }, { behavior: 'immediate' });
}

/**
 * Checks one indexed file. A missing library root or file marks the asset missing.
 * The edition is not trashed or deleted, and the indexed original is not moved.
 * When the file is readable inside the library root again, availability returns to present.
 */
export function checkIndexedFile(db: AppDatabase, assetId: number): Availability {
  const asset = requireAsset(db, assetId);
  if (asset.storage !== 'indexed') throw new CatalogError('not_indexed');
  const edition = db.select({ libraryId: editions.libraryId }).from(editions).where(eq(editions.id, asset.editionId)).get();
  if (!edition) throw new CatalogError('not_found');
  const library = db.select({ rootPath: libraries.rootPath }).from(libraries).where(eq(libraries.id, edition.libraryId)).get();
  if (!library) throw new CatalogError('not_found');
  const availability = indexedAvailability(library.rootPath, asset.relativePath);
  if (asset.availability !== availability) {
    db.update(fileAssets).set({ availability }).where(eq(fileAssets.id, asset.id)).run();
  }
  return availability;
}

/** Checks every indexed asset in a library. Missing mounts are not treated as deletion. */
export function checkIndexedLibrary(
  db: AppDatabase,
  libraryId: number,
): { checked: number; present: number; missing: number } {
  const id = requireId(libraryId);
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, id)).get();
  if (!library) throw new CatalogError('not_found');
  const assets = db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .where(and(eq(editions.libraryId, id), eq(fileAssets.storage, 'indexed')))
    .orderBy(asc(fileAssets.id))
    .all();
  let present = 0;
  let missing = 0;
  for (const asset of assets) {
    const availability = checkIndexedFile(db, asset.id);
    if (availability === 'present') present += 1;
    else missing += 1;
  }
  return { checked: assets.length, present, missing };
}

function requireEdition(db: QueryDb, editionId: number): { editionId: number; library: { id: number; mode: string; rootPath: string } } {
  const edition = db
    .select({ id: editions.id, libraryId: editions.libraryId })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  if (!edition) throw new CatalogError('not_found');
  const library = db
    .select({ id: libraries.id, mode: libraries.mode, rootPath: libraries.rootPath })
    .from(libraries)
    .where(eq(libraries.id, edition.libraryId))
    .get();
  if (!library) throw new CatalogError('not_found');
  return { editionId: edition.id, library };
}

function requireAsset(db: QueryDb, assetId: number): FileAssetRow {
  const id = requireId(assetId);
  const asset = db.select().from(fileAssets).where(eq(fileAssets.id, id)).get();
  if (!asset) throw new CatalogError('not_found');
  return asset;
}

function countSha256(db: QueryDb, sha256: string): number {
  const assetRow = db
    .select({ count: sql<number>`count(*)` })
    .from(fileAssets)
    .where(eq(fileAssets.sha256, sha256))
    .get();
  const coverRow = db
    .select({ count: sql<number>`count(*)` })
    .from(covers)
    .where(eq(covers.sha256, sha256))
    .get();
  return readCount(assetRow?.count) + readCount(coverRow?.count);
}

function readCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

type IndexedInspection =
  | { status: 'present'; absolutePath: string }
  | { status: 'missing' }
  | { status: 'invalid' };

function inspectIndexedFile(libraryRoot: string, relativePath: string): IndexedInspection {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return { status: 'invalid' };
  const lexical = lexicalInside(libraryRoot, normalized);
  if (!lexical) return { status: 'invalid' };

  let rootReal: string;
  try {
    if (!statSync(libraryRoot).isDirectory()) return { status: 'missing' };
    rootReal = realpathSync(libraryRoot);
  } catch {
    return { status: 'missing' };
  }

  let fileReal: string;
  try {
    const linked = lstatSync(lexical);
    if (!linked.isFile() && !linked.isSymbolicLink()) return { status: 'missing' };
    fileReal = realpathSync(lexical);
  } catch {
    return { status: 'missing' };
  }
  const rel = path.relative(rootReal, fileReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 'invalid' };
  try {
    if (!statSync(fileReal).isFile()) return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
  return { status: 'present', absolutePath: lexical };
}

function indexedAvailability(libraryRoot: string, relativePath: string): Availability {
  return inspectIndexedFile(libraryRoot, relativePath).status === 'present' ? 'present' : 'missing';
}

export function normalizeRelativePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > RELATIVE_PATH_MAX) return null;
  if (trimmed.startsWith('/') || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const parts = trimmed.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function lexicalInside(root: string, relativePath: string): string | null {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...parts);
  const rel = path.relative(rootAbs, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function resolveFormat(filename: string, explicit: FileFormat | undefined): FileFormat {
  const inferred = formatFromName(filename);
  if (explicit !== undefined && explicit !== 'epub' && explicit !== 'pdf') throw new CatalogError('invalid_request');
  const format = explicit ?? inferred;
  if (!format) throw new CatalogError('invalid_request');
  if (inferred && explicit && inferred !== explicit) throw new CatalogError('invalid_request');
  return format;
}

function formatFromName(filename: string): FileFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

function fileBaseName(input: string): string {
  if (typeof input !== 'string' || input.includes('\0')) throw new CatalogError('invalid_request');
  const base = path.posix.basename(input.replaceAll('\\', '/').trim());
  if (!base || base === '.' || base === '..' || base.length > 255) throw new CatalogError('invalid_request');
  if (/[\u0000-\u001f\u007f]/.test(base)) throw new CatalogError('invalid_request');
  return base;
}

function requireId(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new CatalogError('invalid_request');
  return value;
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new CatalogError('invalid_request');
  return trimmed;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new CatalogError('invalid_request');
  return trimmed;
}

function optionalDescription(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  if (value.length > DESCRIPTION_MAX || value.includes('\0')) throw new CatalogError('invalid_request');
  return value;
}

function normalizeSeriesOrder(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogError('invalid_request');
  return value;
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return code === 'SQLITE_CONSTRAINT' && message.includes('UNIQUE');
}
