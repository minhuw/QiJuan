import { createReadStream, existsSync, lstatSync, statSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath } from './blobs.js';
import { parseEpubCfi } from './cfi.js';
import { CatalogError } from './catalog.js';
import { parsePdfLocator } from './pdf-locator.js';
import type { AppDatabase } from './db.js';
import { requireLiveEdition } from './editions.js';
import { resolveInsideRoot } from './library-files.js';
import { bookmarks, editions, fileAssets, highlights, libraries, notes, readingPositions } from './schema.js';

const LABEL_MAX = 200;
const QUOTE_MAX = 2000;
const NOTE_MAX = 10_000;

export interface StoredPosition {
  locator: string;
  revision: number;
  assetId: number | null;
  updatedAt: string;
}

export interface AnnotationRow {
  id: number;
  locator: string;
  label: string | null;
  quote: string | null;
  assetId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteRow {
  id: number;
  locator: string | null;
  body: string;
  assetId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReadingPlace {
  position: StoredPosition | null;
  bookmarks: AnnotationRow[];
  highlights: AnnotationRow[];
  notes: NoteRow[];
}

export interface ReadableAsset {
  absolutePath: string;
  bytes: number;
  filename: string;
  format: 'epub' | 'pdf';
}

interface EpubAssetRow {
  sha256: string;
  bytes: number;
  originalFilename: string;
  storage: string;
  relativePath: string;
  rootPath: string;
}

export function loadReadingPlace(db: AppDatabase, userId: number, editionId: number): ReadingPlace {
  requireLiveEdition(db, editionId);
  const position = db
    .select({
      locator: readingPositions.locator,
      revision: readingPositions.revision,
      assetId: readingPositions.assetId,
      updatedAt: readingPositions.updatedAt,
    })
    .from(readingPositions)
    .where(and(eq(readingPositions.userId, userId), eq(readingPositions.editionId, editionId)))
    .get();
  const bookmarkRows = db
    .select({
      id: bookmarks.id,
      locator: bookmarks.locator,
      label: bookmarks.label,
      assetId: bookmarks.assetId,
      createdAt: bookmarks.createdAt,
      updatedAt: bookmarks.updatedAt,
    })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.editionId, editionId)))
    .orderBy(asc(bookmarks.createdAt), asc(bookmarks.id))
    .all();
  const highlightRows = db
    .select({
      id: highlights.id,
      locator: highlights.locator,
      quote: highlights.quote,
      assetId: highlights.assetId,
      createdAt: highlights.createdAt,
      updatedAt: highlights.updatedAt,
    })
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.editionId, editionId)))
    .orderBy(asc(highlights.createdAt), asc(highlights.id))
    .all();
  const noteRows = db
    .select({
      id: notes.id,
      locator: notes.locator,
      body: notes.body,
      assetId: notes.assetId,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.editionId, editionId)))
    .orderBy(asc(notes.createdAt), asc(notes.id))
    .all();
  return {
    position: position ?? null,
    bookmarks: bookmarkRows.map((row) => ({ ...row, quote: null })),
    highlights: highlightRows.map((row) => ({ ...row, label: null })),
    notes: noteRows,
  };
}

export function saveReadingPosition(
  db: AppDatabase,
  input: { userId: number; editionId: number; assetId: number; locator: string },
  now = new Date(),
): StoredPosition {
  const asset = requirePresentAsset(db, input.editionId, input.assetId);
  const locator = locatorForAsset(asset.format, input.locator);
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const existing = query
      .select({ revision: readingPositions.revision })
      .from(readingPositions)
      .where(and(eq(readingPositions.userId, input.userId), eq(readingPositions.editionId, input.editionId)))
      .get();
    if (!existing) {
      query
        .insert(readingPositions)
        .values({
          userId: input.userId,
          editionId: input.editionId,
          assetId: input.assetId,
          locator,
          revision: 1,
          updatedAt: stamp,
        })
        .run();
      return;
    }
    query
      .update(readingPositions)
      .set({
        assetId: input.assetId,
        locator,
        revision: existing.revision + 1,
        updatedAt: stamp,
      })
      .where(and(eq(readingPositions.userId, input.userId), eq(readingPositions.editionId, input.editionId)))
      .run();
  });
  const saved = db
    .select({
      locator: readingPositions.locator,
      revision: readingPositions.revision,
      assetId: readingPositions.assetId,
      updatedAt: readingPositions.updatedAt,
    })
    .from(readingPositions)
    .where(and(eq(readingPositions.userId, input.userId), eq(readingPositions.editionId, input.editionId)))
    .get();
  if (!saved) throw new CatalogError('invalid_request');
  return saved;
}

export function addBookmark(
  db: AppDatabase,
  input: { userId: number; editionId: number; assetId: number; locator: string; label?: string | null },
  now = new Date(),
): AnnotationRow {
  const asset = requirePresentAsset(db, input.editionId, input.assetId);
  const locator = locatorForAsset(asset.format, input.locator);
  const label = cleanOptional(input.label, LABEL_MAX);
  const stamp = now.toISOString();
  const inserted = db
    .insert(bookmarks)
    .values({
      userId: input.userId,
      editionId: input.editionId,
      assetId: input.assetId,
      locator,
      label,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({
      id: bookmarks.id,
      locator: bookmarks.locator,
      label: bookmarks.label,
      assetId: bookmarks.assetId,
      createdAt: bookmarks.createdAt,
      updatedAt: bookmarks.updatedAt,
    })
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return { ...inserted, quote: null };
}

export function removeBookmark(db: AppDatabase, userId: number, editionId: number, bookmarkId: number): void {
  requireLiveEdition(db, editionId);
  const row = db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId), eq(bookmarks.editionId, editionId)))
    .get();
  if (!row) throw new CatalogError('not_found');
  db.delete(bookmarks).where(eq(bookmarks.id, row.id)).run();
}

export function addHighlight(
  db: AppDatabase,
  input: { userId: number; editionId: number; assetId: number; locator: string; quote?: string | null },
  now = new Date(),
): AnnotationRow {
  const locator = requireCfi(input.locator);
  requireEpubAsset(db, input.editionId, input.assetId);
  const quote = cleanOptional(input.quote, QUOTE_MAX);
  const stamp = now.toISOString();
  const inserted = db
    .insert(highlights)
    .values({
      userId: input.userId,
      editionId: input.editionId,
      assetId: input.assetId,
      locator,
      quote,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({
      id: highlights.id,
      locator: highlights.locator,
      quote: highlights.quote,
      assetId: highlights.assetId,
      createdAt: highlights.createdAt,
      updatedAt: highlights.updatedAt,
    })
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return { ...inserted, label: null };
}

export function removeHighlight(db: AppDatabase, userId: number, editionId: number, highlightId: number): void {
  requireLiveEdition(db, editionId);
  const row = db
    .select({ id: highlights.id })
    .from(highlights)
    .where(and(eq(highlights.id, highlightId), eq(highlights.userId, userId), eq(highlights.editionId, editionId)))
    .get();
  if (!row) throw new CatalogError('not_found');
  db.delete(highlights).where(eq(highlights.id, row.id)).run();
}

export function addNote(
  db: AppDatabase,
  input: { userId: number; editionId: number; assetId: number; locator: string; body: string },
  now = new Date(),
): NoteRow {
  const locator = requireCfi(input.locator);
  requireEpubAsset(db, input.editionId, input.assetId);
  const body = cleanRequired(input.body, NOTE_MAX);
  const stamp = now.toISOString();
  const inserted = db
    .insert(notes)
    .values({
      userId: input.userId,
      editionId: input.editionId,
      assetId: input.assetId,
      locator,
      body,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({
      id: notes.id,
      locator: notes.locator,
      body: notes.body,
      assetId: notes.assetId,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .get();
  if (!inserted) throw new CatalogError('invalid_request');
  return inserted;
}

export function updateNote(
  db: AppDatabase,
  input: { userId: number; editionId: number; noteId: number; body: string },
  now = new Date(),
): NoteRow {
  requireLiveEdition(db, input.editionId);
  const body = cleanRequired(input.body, NOTE_MAX);
  const existing = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId), eq(notes.editionId, input.editionId)))
    .get();
  if (!existing) throw new CatalogError('not_found');
  const updated = db
    .update(notes)
    .set({ body, updatedAt: now.toISOString() })
    .where(eq(notes.id, existing.id))
    .returning({
      id: notes.id,
      locator: notes.locator,
      body: notes.body,
      assetId: notes.assetId,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .get();
  if (!updated) throw new CatalogError('not_found');
  return updated;
}

export function removeNote(db: AppDatabase, userId: number, editionId: number, noteId: number): void {
  requireLiveEdition(db, editionId);
  const row = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId), eq(notes.editionId, editionId)))
    .get();
  if (!row) throw new CatalogError('not_found');
  db.delete(notes).where(eq(notes.id, row.id)).run();
}

export function openAssetStream(db: AppDatabase, dataDir: string, editionId: number, assetId: number): ReadableAsset {
  const asset = requirePresentAsset(db, editionId, assetId);
  const absolutePath = resolveAssetAbsolute(dataDir, asset);
  if (!absolutePath) throw new CatalogError('not_found');
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) throw new CatalogError('not_found');
    return { absolutePath, bytes: stat.size, filename: asset.originalFilename, format: asset.format };
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError('not_found');
  }
}

export function openEpubStream(db: AppDatabase, dataDir: string, editionId: number, assetId: number): ReadableAsset {
  const file = openAssetStream(db, dataDir, editionId, assetId);
  if (file.format !== 'epub') throw new CatalogError('not_found');
  return file;
}

export function epubReadStream(absolutePath: string): ReadStream {
  return createReadStream(absolutePath);
}

export function contentDisposition(filename: string, fallback = 'book.epub'): string {
  const cleaned = filename.replace(/[\r\n"]/g, '').trim();
  const safe = cleaned.length > 0 && cleaned.length <= 200 ? cleaned : fallback;
  return `inline; filename="${safe}"`;
}

function requireCfi(value: string): string {
  const locator = parseEpubCfi(value);
  if (!locator) throw new CatalogError('invalid_request');
  return locator;
}

function locatorForAsset(format: 'epub' | 'pdf', value: string): string {
  if (format === 'pdf') {
    const locator = parsePdfLocator(value);
    if (!locator) throw new CatalogError('invalid_request');
    return locator;
  }
  return requireCfi(value);
}

function requirePresentAsset(db: AppDatabase, editionId: number, assetId: number): EpubAssetRow & { format: 'epub' | 'pdf' } {
  requireLiveEdition(db, editionId);
  if (!Number.isInteger(assetId) || assetId < 1) throw new CatalogError('invalid_request');
  const row = db
    .select({
      format: fileAssets.format,
      sha256: fileAssets.sha256,
      bytes: fileAssets.bytes,
      originalFilename: fileAssets.originalFilename,
      storage: fileAssets.storage,
      relativePath: fileAssets.relativePath,
      availability: fileAssets.availability,
      rootPath: libraries.rootPath,
    })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .innerJoin(libraries, eq(libraries.id, editions.libraryId))
    .where(and(eq(fileAssets.id, assetId), eq(fileAssets.editionId, editionId), isNull(fileAssets.trashedAt)))
    .get();
  if (!row || row.availability !== 'present') throw new CatalogError('not_found');
  if (row.format !== 'epub' && row.format !== 'pdf') throw new CatalogError('not_found');
  return row;
}

function requireEpubAsset(db: AppDatabase, editionId: number, assetId: number): EpubAssetRow {
  const row = requirePresentAsset(db, editionId, assetId);
  if (row.format !== 'epub') throw new CatalogError('not_found');
  return row;
}

function resolveAssetAbsolute(dataDir: string, asset: EpubAssetRow): string | null {
  try {
    if (asset.storage === 'managed') {
      if (asset.relativePath !== managedBlobRelativePath(asset.sha256)) return null;
      const absolute = absoluteBlobPath(dataDir, asset.sha256);
      if (!existsSync(absolute)) return null;
      const stat = lstatSync(absolute);
      if (!stat.isFile()) return null;
      return absolute;
    }
    if (asset.storage !== 'indexed') return null;
    const inside = resolveInsideRoot(asset.rootPath, asset.relativePath);
    if (!inside || !existsSync(inside)) return null;
    const stat = statSync(inside);
    if (!stat.isFile()) return null;
    return inside;
  } catch {
    return null;
  }
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new CatalogError('invalid_request');
  return trimmed;
}

function cleanRequired(value: string, max: number): string {
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new CatalogError('invalid_request');
  const trimmed = value.trim();
  if (!trimmed) throw new CatalogError('invalid_request');
  return trimmed;
}
