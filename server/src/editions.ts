import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { CatalogError, createSeries } from './catalog.js';
import type { AppDatabase } from './db.js';
import {
  type ApiField,
  type LockField,
  API_TO_LOCK,
  loadAlternateTitles,
  loadIdentifiers,
  loadLocks,
  loadNames,
  loadTags,
  lockFields,
  lockNamesForApi,
  latestCover,
  releaseUnreferenced,
  replaceAlternateTitles,
  replaceContributors,
  replaceIdentifiers,
  replaceTags,
  saveCoverRow,
} from './edition-fields.js';
import { editions, fileAssets, libraries, series } from './schema.js';
import { sniffImage } from './metadata.js';
import {
  cleanDescription,
  cleanLanguage,
  cleanName,
  cleanPublishedDate,
  cleanPublisher,
  cleanTitle,
} from './text.js';

export interface EditionAsset {
  id: number;
  format: 'epub' | 'pdf';
  originalFilename: string;
  bytes: number;
  availability: 'present' | 'missing';
}

export interface EditionDetail {
  id: number;
  libraryId: number;
  title: string;
  sortTitle: string;
  language: string | null;
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  series: { id: number; name: string } | null;
  seriesOrder: number | null;
  alternateTitles: Array<{ title: string; sortTitle: string | null }>;
  authors: string[];
  translators: string[];
  tags: string[];
  identifiers: Array<{ scheme: string; value: string }>;
  locks: ApiField[];
  cover: { mediaType: string } | null;
  assets: EditionAsset[];
  suggestions: Array<{ id: number; otherEditionId: number; otherTitle: string }>;
}

export interface EditionSummary {
  id: number;
  libraryId: number;
  title: string;
  language: string | null;
  authors: string[];
  formats: Array<'epub' | 'pdf'>;
}

export interface EditionPatch {
  title?: string;
  sortTitle?: string;
  alternateTitles?: Array<{ title: string; sortTitle: string | null }>;
  authors?: string[];
  translators?: string[];
  description?: string | null;
  series?: string | null;
  seriesOrder?: number | null;
  publisher?: string | null;
  publishedDate?: string | null;
  language?: string | null;
  identifiers?: Array<{ scheme: string; value: string }>;
  tags?: string[];
}

export interface BatchPatch {
  editionIds: number[];
  language?: string | null;
  publisher?: string | null;
  tags?: string[];
  series?: string | null;
  seriesOrder?: number | null;
}

export function listEditionSummaries(db: AppDatabase, libraryIds: number[]): EditionSummary[] {
  if (libraryIds.length === 0) return [];
  const rows = db
    .select()
    .from(editions)
    .where(and(inArray(editions.libraryId, libraryIds), isNull(editions.trashedAt)))
    .orderBy(asc(editions.sortTitle), asc(editions.id))
    .all();
  if (rows.length === 0) return [];
  const authors = new Map<number, string[]>();
  const formats = new Map<number, Array<'epub' | 'pdf'>>();
  for (const id of rows.map((row) => row.id)) {
    authors.set(id, loadNames(db, id, 'author'));
    const assets = db
      .select({ format: fileAssets.format })
      .from(fileAssets)
      .where(and(eq(fileAssets.editionId, id), isNull(fileAssets.trashedAt)))
      .orderBy(asc(fileAssets.id))
      .all();
    const seen = new Set<'epub' | 'pdf'>();
    const list: Array<'epub' | 'pdf'> = [];
    for (const asset of assets) {
      if (asset.format !== 'epub' && asset.format !== 'pdf') continue;
      if (seen.has(asset.format)) continue;
      seen.add(asset.format);
      list.push(asset.format);
    }
    formats.set(id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    libraryId: row.libraryId,
    title: row.title,
    language: row.language,
    authors: authors.get(row.id) ?? [],
    formats: formats.get(row.id) ?? [],
  }));
}

export function getEditionDetail(
  db: AppDatabase,
  editionId: number,
  suggestions: EditionDetail['suggestions'],
): EditionDetail {
  const edition = requireLiveEdition(db, editionId);
  const seriesRow =
    edition.seriesId == null
      ? null
      : db.select({ id: series.id, name: series.name }).from(series).where(eq(series.id, edition.seriesId)).get() ?? null;
  const cover = latestCover(db, edition.id);
  const assets = db
    .select({
      id: fileAssets.id,
      format: fileAssets.format,
      originalFilename: fileAssets.originalFilename,
      bytes: fileAssets.bytes,
      availability: fileAssets.availability,
    })
    .from(fileAssets)
    .where(and(eq(fileAssets.editionId, edition.id), isNull(fileAssets.trashedAt)))
    .orderBy(asc(fileAssets.id))
    .all();
  return {
    id: edition.id,
    libraryId: edition.libraryId,
    title: edition.title,
    sortTitle: edition.sortTitle,
    language: edition.language,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    description: edition.description,
    series: seriesRow,
    seriesOrder: edition.seriesOrder,
    alternateTitles: loadAlternateTitles(db, edition.id),
    authors: loadNames(db, edition.id, 'author'),
    translators: loadNames(db, edition.id, 'translator'),
    tags: loadTags(db, edition.id),
    identifiers: loadIdentifiers(db, edition.id),
    locks: lockNamesForApi(loadLocks(db, edition.id)),
    cover: cover ? { mediaType: cover.mediaType } : null,
    assets: assets.map((asset) => ({
      id: asset.id,
      format: asset.format,
      originalFilename: asset.originalFilename,
      bytes: asset.bytes,
      availability: asset.availability,
    })),
    suggestions,
  };
}

export function requireLiveEdition(db: AppDatabase, editionId: number): typeof editions.$inferSelect {
  if (!Number.isInteger(editionId) || editionId < 1) throw new CatalogError('invalid_request');
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) throw new CatalogError('not_found');
  return edition;
}

/** A present key is a user edit and locks that field, even when the value is unchanged. */
export function updateEdition(db: AppDatabase, editionId: number, patch: EditionPatch, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = requireLiveEdition(query, editionId);
    const locks: LockField[] = [];
    const values: Partial<typeof editions.$inferInsert> = {};

    if (patch.title !== undefined) {
      values.title = requireClean(cleanTitle(patch.title));
      locks.push(API_TO_LOCK.title);
    }
    if (patch.sortTitle !== undefined) {
      values.sortTitle = requireClean(cleanTitle(patch.sortTitle));
      locks.push(API_TO_LOCK.sortTitle);
    }
    if (patch.description !== undefined) {
      values.description = patch.description;
      locks.push(API_TO_LOCK.description);
    }
    if (patch.publisher !== undefined) {
      values.publisher = patch.publisher;
      locks.push(API_TO_LOCK.publisher);
    }
    if (patch.publishedDate !== undefined) {
      values.publishedDate = patch.publishedDate;
      locks.push(API_TO_LOCK.publishedDate);
    }
    if (patch.language !== undefined) {
      values.language = patch.language;
      locks.push(API_TO_LOCK.language);
    }

    let seriesId = edition.seriesId;
    let seriesOrder = edition.seriesOrder;
    if (patch.series !== undefined) {
      if (patch.series === null) {
        seriesId = null;
        seriesOrder = null;
        locks.push(API_TO_LOCK.series, API_TO_LOCK.seriesOrder);
      } else {
        seriesId = resolveSeriesId(query, edition.libraryId, patch.series, now);
        locks.push(API_TO_LOCK.series);
      }
    }
    if (patch.seriesOrder !== undefined) {
      if (seriesId == null && patch.seriesOrder != null) throw new CatalogError('invalid_request');
      seriesOrder = patch.seriesOrder;
      locks.push(API_TO_LOCK.seriesOrder);
    }
    values.seriesId = seriesId;
    values.seriesOrder = seriesOrder;

    if (patch.alternateTitles !== undefined) {
      replaceAlternateTitles(query, edition.id, patch.alternateTitles);
      locks.push(API_TO_LOCK.alternateTitles);
    }
    if (patch.authors !== undefined) {
      replaceContributors(query, edition.id, 'author', patch.authors, stamp, 'strict');
      locks.push(API_TO_LOCK.authors);
    }
    if (patch.translators !== undefined) {
      replaceContributors(query, edition.id, 'translator', patch.translators, stamp, 'strict');
      locks.push(API_TO_LOCK.translators);
    }
    if (patch.identifiers !== undefined) {
      replaceIdentifiers(query, edition.id, patch.identifiers, 'strict');
      locks.push(API_TO_LOCK.identifiers);
    }
    if (patch.tags !== undefined) {
      replaceTags(query, edition.id, patch.tags, stamp);
      locks.push(API_TO_LOCK.tags);
    }

    values.updatedAt = stamp;
    query.update(editions).set(values).where(eq(editions.id, edition.id)).run();
    lockFields(query, edition.id, locks, stamp);
  }, { behavior: 'immediate' });
}

export function batchEditEditions(db: AppDatabase, patch: BatchPatch, now = new Date()): number {
  if (patch.editionIds.length === 0) throw new CatalogError('invalid_request');
  const stamp = now.toISOString();
  const rows = patch.editionIds.map((id) => requireLiveEdition(db, id));
  const lockList: LockField[] = [];
  if (patch.language !== undefined) lockList.push('language');
  if (patch.publisher !== undefined) lockList.push('publisher');
  if (patch.tags !== undefined) lockList.push('tags');
  if (patch.series !== undefined) lockList.push('series');
  if (patch.series === null || patch.seriesOrder !== undefined) lockList.push('series_order');

  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const seriesByLibrary = new Map<number, number>();
    for (const edition of rows) {
      let seriesId = edition.seriesId;
      let seriesOrder = edition.seriesOrder;
      if (patch.series !== undefined) {
        if (patch.series === null) {
          seriesId = null;
          seriesOrder = null;
        } else {
          const cached = seriesByLibrary.get(edition.libraryId);
          seriesId = cached ?? resolveSeriesId(query, edition.libraryId, patch.series, now);
          seriesByLibrary.set(edition.libraryId, seriesId);
        }
      }
      if (patch.seriesOrder !== undefined) {
        if (seriesId == null && patch.seriesOrder != null) throw new CatalogError('invalid_request');
        seriesOrder = patch.seriesOrder;
      }
      query
        .update(editions)
        .set({
          language: patch.language !== undefined ? patch.language : edition.language,
          publisher: patch.publisher !== undefined ? patch.publisher : edition.publisher,
          seriesId,
          seriesOrder,
          updatedAt: stamp,
        })
        .where(eq(editions.id, edition.id))
        .run();
      if (patch.tags !== undefined) replaceTags(query, edition.id, patch.tags, stamp);
      lockFields(query, edition.id, lockList, stamp);
    }
  }, { behavior: 'immediate' });
  return rows.length;
}

/** Replaces the cover image. Does not read or write the book blob. */
export function replaceEditionCover(
  db: AppDatabase,
  input: { dataDir: string; editionId: number; bytes: Buffer },
  now = new Date(),
): void {
  const mediaType = sniffImage(input.bytes);
  if (!mediaType) throw new CatalogError('invalid_request');
  const stamp = now.toISOString();
  const retired = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = requireLiveEdition(query, input.editionId);
    const hashes = saveCoverRow(
      query,
      { dataDir: input.dataDir, editionId: edition.id, bytes: input.bytes, mediaType },
      stamp,
    );
    lockFields(query, edition.id, ['cover'], stamp);
    query.update(editions).set({ updatedAt: stamp }).where(eq(editions.id, edition.id)).run();
    return hashes;
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, input.dataDir, retired);
}

function resolveSeriesId(db: AppDatabase, libraryId: number, name: string, now: Date): number {
  const title = requireClean(cleanName(name));
  const library = db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get();
  if (!library) throw new CatalogError('not_found');
  const existing = db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.libraryId, libraryId), eq(series.name, title)))
    .get();
  if (existing) return existing.id;
  return createSeries(db, { libraryId, name: title }, now).id;
}

function requireClean(value: string | null): string {
  if (!value) throw new CatalogError('invalid_request');
  return value;
}

export function cleanPatchText(value: unknown, clean: (value: unknown) => string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new CatalogError('invalid_request');
  if (value.trim() === '') return null;
  const cleaned = clean(value);
  if (!cleaned) throw new CatalogError('invalid_request');
  return cleaned;
}

export { cleanDescription, cleanLanguage, cleanPublishedDate, cleanPublisher };
