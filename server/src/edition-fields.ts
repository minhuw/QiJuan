import { existsSync, readFileSync } from 'node:fs';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath, removeBlobFile, writeImmutableBlob } from './blobs.js';
import { CatalogError } from './catalog.js';
import { deriveCoverTint } from './cover-tint.js';
import type { AppDatabase } from './db.js';
import { sniffImage } from './metadata.js';
import { upsertPerson } from './persons.js';
import {
  alternateTitles,
  assetOcr,
  covers,
  editionContributors,
  editionIdentifiers,
  fieldLocks,
  fileAssets,
  metadataPreviews,
  persons,
  tags,
} from './schema.js';
import {
  type IdentifierSource,
  cleanSourceUrl,
  identifierKey,
  identifierUrl,
  normalizeIdentifier,
} from './identifiers.js';
import { cleanName, cleanTag, cleanTitle } from './text.js';

export const LOCK_FIELDS = [
  'title',
  'sort_title',
  'alternate_titles',
  'authors',
  'translators',
  'description',
  'series',
  'series_order',
  'publisher',
  'published_date',
  'language',
  'identifiers',
  'tags',
  'cover',
] as const;

export type LockField = (typeof LOCK_FIELDS)[number];

export const API_TO_LOCK = {
  title: 'title',
  sortTitle: 'sort_title',
  alternateTitles: 'alternate_titles',
  authors: 'authors',
  translators: 'translators',
  description: 'description',
  series: 'series',
  seriesOrder: 'series_order',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  identifiers: 'identifiers',
  tags: 'tags',
  cover: 'cover',
} as const;

export type ApiField = keyof typeof API_TO_LOCK;

const LOCK_TO_API = Object.fromEntries(Object.entries(API_TO_LOCK).map(([api, field]) => [field, api])) as Record<
  LockField,
  ApiField
>;

const NAME_LIMIT = 30;
const TAG_LIMIT = 50;
const IDENTIFIER_LIMIT = 40;
const ALTERNATE_LIMIT = 20;

export function isLockField(value: string): value is LockField {
  return (LOCK_FIELDS as readonly string[]).includes(value);
}

export function loadLocks(db: AppDatabase, editionId: number): Set<LockField> {
  const rows = db.select({ field: fieldLocks.field }).from(fieldLocks).where(eq(fieldLocks.editionId, editionId)).all();
  const locks = new Set<LockField>();
  for (const row of rows) {
    if (isLockField(row.field)) locks.add(row.field);
  }
  return locks;
}

export function lockNamesForApi(locks: Set<LockField>): ApiField[] {
  return [...locks].map((field) => LOCK_TO_API[field]).sort();
}

export function lockFields(db: AppDatabase, editionId: number, fields: readonly LockField[], now: string): void {
  for (const field of new Set(fields)) {
    const existing = db
      .select({ field: fieldLocks.field })
      .from(fieldLocks)
      .where(and(eq(fieldLocks.editionId, editionId), eq(fieldLocks.field, field)))
      .get();
    if (existing) continue;
    db.insert(fieldLocks).values({ editionId, field, lockedAt: now }).run();
  }
}

/** Edition spelling. Falls back to the shared person name for rows written before display names. */
export function loadNames(db: AppDatabase, editionId: number, role: 'author' | 'translator'): string[] {
  return db
    .select({ displayName: editionContributors.displayName, name: persons.name })
    .from(editionContributors)
    .innerJoin(persons, eq(persons.id, editionContributors.personId))
    .where(and(eq(editionContributors.editionId, editionId), eq(editionContributors.role, role)))
    .orderBy(asc(editionContributors.position), asc(persons.id))
    .all()
    .map((row) => row.displayName || row.name);
}

export function loadAlternateTitles(
  db: AppDatabase,
  editionId: number,
): Array<{ title: string; sortTitle: string | null }> {
  return db
    .select({ title: alternateTitles.title, sortTitle: alternateTitles.sortTitle })
    .from(alternateTitles)
    .where(eq(alternateTitles.editionId, editionId))
    .orderBy(asc(alternateTitles.id))
    .all();
}

export function loadTags(db: AppDatabase, editionId: number): string[] {
  return db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.editionId, editionId))
    .orderBy(asc(tags.id))
    .all()
    .map((row) => row.name);
}

export function loadIdentifiers(
  db: AppDatabase,
  editionId: number,
): Array<{ scheme: string; value: string }> {
  return loadIdentifierRecords(db, editionId).map(({ scheme, value }) => ({ scheme, value }));
}

export interface IdentifierRecord {
  scheme: string;
  value: string;
  source: IdentifierSource;
  sourceUrl: string | null;
  createdAt: string;
}

/** Reader payload: what the identifier is and where to look it up. */
export interface IdentifierView {
  scheme: string;
  value: string;
  url: string | null;
}

/** Admin payload adds provenance. */
export interface AdminIdentifierView extends IdentifierView {
  source: IdentifierSource;
  sourceUrl: string | null;
  createdAt: string;
}

export function loadIdentifierRecords(db: AppDatabase, editionId: number): IdentifierRecord[] {
  return db
    .select({
      scheme: editionIdentifiers.scheme,
      value: editionIdentifiers.value,
      source: editionIdentifiers.source,
      sourceUrl: editionIdentifiers.sourceUrl,
      createdAt: editionIdentifiers.createdAt,
    })
    .from(editionIdentifiers)
    .where(eq(editionIdentifiers.editionId, editionId))
    .orderBy(asc(editionIdentifiers.id))
    .all();
}

export function presentIdentifiers(records: IdentifierRecord[], admin: boolean): IdentifierView[] | AdminIdentifierView[] {
  return records.map((record) => {
    const view: IdentifierView = {
      scheme: record.scheme,
      value: record.value,
      url: identifierUrl(record.scheme, record.value),
    };
    if (!admin) return view;
    return { ...view, source: record.source, sourceUrl: record.sourceUrl, createdAt: record.createdAt };
  });
}

export interface IdentifierInput {
  scheme: string;
  value: string;
  /** Defaults to the call's source. */
  source?: IdentifierSource;
  sourceUrl?: string | null;
}

/**
 * Makes the edition's identifiers equal to `items`. Values are validated and
 * normalized by scheme. `strict` rejects an invalid value with
 * `invalid_identifier`, except a pair the edition already stores unchanged (a
 * legacy value kept by migration 0016); `loose` drops it. Pairs already stored
 * keep their provenance. With `onlySource`, only rows of that source may be
 * removed: a rescan replaces what the file said and leaves agent and manual
 * identifiers alone.
 */
export function replaceIdentifiers(
  db: AppDatabase,
  editionId: number,
  items: IdentifierInput[],
  mode: 'strict' | 'loose',
  options: { source: IdentifierSource; now: string; onlySource?: IdentifierSource },
): void {
  const existing = db
    .select()
    .from(editionIdentifiers)
    .where(eq(editionIdentifiers.editionId, editionId))
    .orderBy(asc(editionIdentifiers.id))
    .all();
  const stored = new Map(existing.map((row) => [`${row.scheme}\0${row.value}`, row]));
  const cleaned: Array<IdentifierInput & { scheme: string; value: string }> = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const result = normalizeIdentifier(item.scheme, item.value);
    let scheme: string;
    let value: string;
    if (result.ok) {
      scheme = result.scheme;
      value = result.value;
    } else {
      const legacy = typeof item.scheme === 'string' && typeof item.value === 'string'
        ? stored.get(`${item.scheme}\0${item.value}`)
        : undefined;
      if (!legacy) {
        if (mode === 'strict') throw new CatalogError('invalid_identifier', { index });
        continue;
      }
      scheme = legacy.scheme;
      value = legacy.value;
    }
    const key = identifierKey({ scheme, value });
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ ...item, scheme, value });
  }
  if (cleaned.length > IDENTIFIER_LIMIT) throw new CatalogError('invalid_request');
  const keep = new Set(cleaned.map((item) => `${item.scheme}\0${item.value}`));
  for (const row of existing) {
    if (keep.has(`${row.scheme}\0${row.value}`)) continue;
    if (options.onlySource && row.source !== options.onlySource) continue;
    db.delete(editionIdentifiers).where(eq(editionIdentifiers.id, row.id)).run();
  }
  insertNewIdentifiers(db, editionId, cleaned, stored, options);
}

/**
 * Adds identifiers the edition lacks; never removes any. Invalid values are
 * skipped. Returns how many were added.
 */
export function addIdentifiers(
  db: AppDatabase,
  editionId: number,
  items: IdentifierInput[],
  options: { source: IdentifierSource; now: string },
): number {
  const existing = db
    .select()
    .from(editionIdentifiers)
    .where(eq(editionIdentifiers.editionId, editionId))
    .all();
  const stored = new Map(existing.map((row) => [`${row.scheme}\0${row.value}`, row]));
  const cleaned: Array<IdentifierInput & { scheme: string; value: string }> = [];
  for (const item of items) {
    const result = normalizeIdentifier(item.scheme, item.value);
    if (result.ok) cleaned.push({ ...item, scheme: result.scheme, value: result.value });
  }
  if (existing.length + cleaned.length > IDENTIFIER_LIMIT) {
    cleaned.splice(Math.max(0, IDENTIFIER_LIMIT - existing.length));
  }
  return insertNewIdentifiers(db, editionId, cleaned, stored, options);
}

function insertNewIdentifiers(
  db: AppDatabase,
  editionId: number,
  items: Array<IdentifierInput & { scheme: string; value: string }>,
  stored: Map<string, unknown>,
  options: { source: IdentifierSource; now: string },
): number {
  let added = 0;
  const seen = new Set<string>();
  for (const item of items) {
    const exact = `${item.scheme}\0${item.value}`;
    if (stored.has(exact) || seen.has(exact)) continue;
    seen.add(exact);
    db.insert(editionIdentifiers)
      .values({
        editionId,
        scheme: item.scheme,
        value: item.value,
        source: item.source ?? options.source,
        sourceUrl: cleanSourceUrl(item.sourceUrl),
        createdAt: options.now,
      })
      .run();
    added += 1;
  }
  return added;
}

export function replaceContributors(
  db: AppDatabase,
  editionId: number,
  role: 'author' | 'translator',
  names: string[],
  now: string,
  mode: 'strict' | 'loose',
): void {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = cleanName(name);
    if (!value) {
      if (mode === 'strict') throw new CatalogError('invalid_request');
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  if (cleaned.length > NAME_LIMIT) throw new CatalogError('invalid_request');
  db.delete(editionContributors)
    .where(and(eq(editionContributors.editionId, editionId), eq(editionContributors.role, role)))
    .run();
  cleaned.forEach((name, position) => {
    const personId = upsertPerson(db, name, now);
    db.insert(editionContributors).values({ editionId, personId, role, position, displayName: name }).run();
  });
}

export function replaceAlternateTitles(
  db: AppDatabase,
  editionId: number,
  items: Array<{ title: string; sortTitle: string | null }>,
): void {
  const cleaned: Array<{ title: string; sortTitle: string | null }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const title = cleanTitle(item.title);
    if (!title) throw new CatalogError('invalid_request');
    const sortBlank = item.sortTitle == null || item.sortTitle.trim() === '';
    const sortTitle = sortBlank ? null : cleanTitle(item.sortTitle);
    if (!sortBlank && !sortTitle) throw new CatalogError('invalid_request');
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ title, sortTitle });
  }
  if (cleaned.length > ALTERNATE_LIMIT) throw new CatalogError('invalid_request');
  db.delete(alternateTitles).where(eq(alternateTitles.editionId, editionId)).run();
  for (const item of cleaned) {
    db.insert(alternateTitles).values({ editionId, title: item.title, sortTitle: item.sortTitle }).run();
  }
}

export function replaceTags(db: AppDatabase, editionId: number, names: string[], now: string): void {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = cleanTag(name);
    if (!value) throw new CatalogError('invalid_request');
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  if (cleaned.length > TAG_LIMIT) throw new CatalogError('invalid_request');
  db.delete(tags).where(eq(tags.editionId, editionId)).run();
  for (const name of cleaned) {
    db.insert(tags).values({ editionId, name, createdAt: now }).run();
  }
}

export function latestCover(
  db: AppDatabase,
  editionId: number,
): { id: number; sha256: string; mediaType: string; relativePath: string; tint: string | null } | null {
  const row = db
    .select({
      id: covers.id,
      sha256: covers.sha256,
      mediaType: covers.mediaType,
      relativePath: covers.relativePath,
      tint: covers.tint,
    })
    .from(covers)
    .where(eq(covers.editionId, editionId))
    .orderBy(desc(covers.id))
    .get();
  return row ?? null;
}

/**
 * Stores a cover image beside the book. Returns hashes that may now be unreferenced.
 * The caller deletes those files only after the surrounding transaction commits.
 * Book blobs are not opened for write.
 */
export function saveCoverRow(
  db: AppDatabase,
  input: { dataDir: string; editionId: number; bytes: Buffer; mediaType: string },
  now: string,
): string[] {
  const sniffed = sniffImage(input.bytes);
  if (!sniffed || sniffed !== input.mediaType) throw new CatalogError('invalid_request');
  const blob = writeImmutableBlob(input.dataDir, input.bytes);
  const existing = db
    .select({ sha256: covers.sha256, mediaType: covers.mediaType, relativePath: covers.relativePath })
    .from(covers)
    .where(eq(covers.editionId, input.editionId))
    .all();
  if (
    existing.length === 1 &&
    existing[0]?.sha256 === blob.sha256 &&
    existing[0]?.mediaType === input.mediaType &&
    existing[0]?.relativePath === blob.relativePath
  ) {
    return [];
  }
  const retired = [...new Set(existing.map((row) => row.sha256))].filter((hash) => hash !== blob.sha256);
  db.delete(covers).where(eq(covers.editionId, input.editionId)).run();
  db.insert(covers)
    .values({
      editionId: input.editionId,
      sha256: blob.sha256,
      bytes: blob.bytes,
      mediaType: input.mediaType,
      relativePath: blob.relativePath,
      tint: deriveCoverTint(input.bytes, input.mediaType) ?? '',
      createdAt: now,
    })
    .run();
  return retired;
}

/**
 * Derives the band tint for covers stored before tints existed. A cover whose file is missing or
 * unreadable is marked '' so it is not read again. Returns the number of covers updated.
 */
export function backfillCoverTints(db: AppDatabase, dataDir: string): number {
  const rows = db
    .select({ id: covers.id, sha256: covers.sha256, mediaType: covers.mediaType, relativePath: covers.relativePath })
    .from(covers)
    .where(isNull(covers.tint))
    .orderBy(asc(covers.id))
    .all();
  for (const row of rows) {
    const absolute = coverAbsolute(dataDir, row);
    let tint: string | null = null;
    if (absolute) {
      try {
        tint = deriveCoverTint(readFileSync(absolute), row.mediaType);
      } catch {
        tint = null;
      }
    }
    db.update(covers).set({ tint: tint ?? '' }).where(eq(covers.id, row.id)).run();
  }
  return rows.length;
}

export function releaseUnreferenced(db: AppDatabase, dataDir: string, hashes: string[]): void {
  for (const hash of hashes) {
    if (countReferences(db, hash) > 0) continue;
    try {
      removeBlobFile(dataDir, hash);
    } catch {
      // An unreferenced blob can stay. It is not the book file.
    }
  }
}

export function coverAbsolute(dataDir: string, cover: { sha256: string; relativePath: string }): string | null {
  if (cover.relativePath !== managedBlobRelativePath(cover.sha256)) return null;
  try {
    const absolute = absoluteBlobPath(dataDir, cover.sha256);
    if (!existsSync(absolute)) return null;
    return absolute;
  } catch {
    return null;
  }
}

function countReferences(db: AppDatabase, sha256: string): number {
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
  const previewRow = db
    .select({ count: sql<number>`count(*)` })
    .from(metadataPreviews)
    .where(eq(metadataPreviews.coverSha256, sha256))
    .get();
  // An OCR copy is a blob of its own; see migration 0022.
  const ocrRow = db
    .select({ count: sql<number>`count(*)` })
    .from(assetOcr)
    .where(eq(assetOcr.sha256, sha256))
    .get();
  return readCount(assetRow?.count) + readCount(coverRow?.count) + readCount(previewRow?.count) + readCount(ocrRow?.count);
}

function readCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}
