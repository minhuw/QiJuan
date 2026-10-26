import { existsSync } from 'node:fs';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath, removeBlobFile, writeImmutableBlob } from './blobs.js';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { sniffImage } from './metadata.js';
import { upsertPerson } from './persons.js';
import {
  alternateTitles,
  covers,
  editionContributors,
  fieldLocks,
  fileAssets,
  identifiers,
  persons,
  tags,
} from './schema.js';
import { cleanIdentifierValue, cleanName, cleanScheme, cleanTag, cleanTitle } from './text.js';

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
  return db
    .select({ scheme: identifiers.scheme, value: identifiers.value })
    .from(identifiers)
    .where(eq(identifiers.editionId, editionId))
    .orderBy(asc(identifiers.id))
    .all();
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

export function replaceIdentifiers(
  db: AppDatabase,
  editionId: number,
  items: Array<{ scheme: string; value: string }>,
  mode: 'strict' | 'loose',
): void {
  const cleaned: Array<{ scheme: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const scheme = cleanScheme(item.scheme);
    const value = cleanIdentifierValue(item.value);
    if (!scheme || !value) {
      if (mode === 'strict') throw new CatalogError('invalid_request');
      continue;
    }
    const key = `${scheme}\0${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ scheme, value });
  }
  if (cleaned.length > IDENTIFIER_LIMIT) throw new CatalogError('invalid_request');
  db.delete(identifiers).where(eq(identifiers.editionId, editionId)).run();
  for (const item of cleaned) {
    db.insert(identifiers).values({ editionId, scheme: item.scheme, value: item.value }).run();
  }
}

export function latestCover(
  db: AppDatabase,
  editionId: number,
): { id: number; sha256: string; mediaType: string; relativePath: string } | null {
  const row = db
    .select({
      id: covers.id,
      sha256: covers.sha256,
      mediaType: covers.mediaType,
      relativePath: covers.relativePath,
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
      createdAt: now,
    })
    .run();
  return retired;
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
  return readCount(assetRow?.count) + readCount(coverRow?.count);
}

function readCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}
