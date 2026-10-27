import type Database from 'better-sqlite3';
import { Converter } from 'opencc-js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { CatalogError } from './catalog.js';
import type { AppDatabase } from './db.js';
import { getEditionDetail, requireLiveEdition } from './editions.js';
import {
  editions,
  favorites,
  ratings,
  readingQueues,
  readingStatuses,
  shelfItems,
  shelves,
} from './schema.js';
import { listOpenSuggestions } from './suggestions.js';
import { isUniqueConstraint } from './sql-errors.js';

const CONTINUE_LIMIT = 12;
const RECENT_LIMIT = 24;
const toTraditional = Converter({ from: 'cn', to: 't' });
const toSimplified = Converter({ from: 't', to: 'cn' });

/** Same hyphen stripping as edition_search_doc.isbn in migration 0007. */
const COMPACT_ISBN_EXPR =
  "lower(replace(replace(replace(replace(i.value, '-', ''), ' ', ''), char(8211), ''), char(8212), ''))";

export type ReadingStatus = 'want' | 'reading' | 'finished' | 'on_hold';

export interface ReadingPatch {
  status?: ReadingStatus | null;
  rating?: number | null;
  favorite?: boolean;
  queued?: boolean;
}

export interface ReadingShelf {
  id: number;
  name: string;
  included: boolean;
}

export interface ReadingState {
  status: ReadingStatus | null;
  rating: number | null;
  favorite: boolean;
  queued: boolean;
  shelves: ReadingShelf[];
}

export interface SeriesNeighbor {
  id: number;
  title: string;
  seriesOrder: number | null;
}

export interface LibraryCard {
  id: number;
  libraryId: number;
  title: string;
  authors: string[];
  language: string | null;
  formats: Array<'epub' | 'pdf'>;
  hasCover: boolean;
  status: ReadingStatus | null;
  rating: number | null;
  favorite: boolean;
}

export interface ShelfSummary {
  id: number;
  name: string;
  count: number;
}

export interface LibraryQuery {
  userId: number;
  libraryIds: number[];
  q: string | null;
  language: string | null;
  format: 'epub' | 'pdf' | null;
  status: ReadingStatus | null;
  shelfId: number | null;
  limit: number;
  offset: number;
}

export interface LibraryPage {
  editions: LibraryCard[];
  total: number;
  limit: number;
  offset: number;
  languages: string[];
  shelves: ShelfSummary[];
}

export interface HomePayload {
  continueReading: Array<LibraryCard & { updatedAt: string }>;
  recent: LibraryCard[];
  shelves: ShelfSummary[];
}

interface CardRow {
  id: number;
  libraryId: number;
  title: string;
  language: string | null;
  status: string | null;
  rating: number | null;
  favorite: number;
}

function sqliteOf(db: AppDatabase): Database.Database {
  return (db as AppDatabase & { $client: Database.Database }).$client;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function ftsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Query-time only. Catalog columns keep the script the user stored. */
function scriptVariants(value: string): string[] {
  const variants = [value, toSimplified(value), toTraditional(value)];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    if (!variant || seen.has(variant)) continue;
    seen.add(variant);
    unique.push(variant);
  }
  return unique.length > 0 ? unique : [value];
}

function isbnKey(value: string): string | null {
  const compact = value.toLowerCase().replace(/[\u2013\u2014 \t-]/g, '');
  if (!/^[0-9x]+$/.test(compact)) return null;
  return compact;
}

function likeAny(expression: string, variants: string[], params: string[]): string {
  return variants
    .map((variant) => {
      params.push(likePattern(variant));
      return `${expression} LIKE ? ESCAPE '\\'`;
    })
    .join(' OR ');
}

function textMatch(q: string): { sql: string; params: Array<string | number> } {
  const variants = scriptVariants(q);
  const params: Array<string | number> = [];
  const clauses: string[] = [];
  if (codePoints(q) < 3) {
    const likeParams: string[] = [];
    const like = [
      `(${likeAny('e.title', variants, likeParams)})`,
      `EXISTS (SELECT 1 FROM alternate_titles alt WHERE alt.edition_id = e.id AND (${likeAny('alt.title', variants, likeParams)}))`,
      `EXISTS (
        SELECT 1 FROM edition_contributors ec
        JOIN persons p ON p.id = ec.person_id
        WHERE ec.edition_id = e.id AND ec.role = 'author'
          AND (${likeAny('COALESCE(ec.display_name, p.name)', variants, likeParams)})
      )`,
      `EXISTS (
        SELECT 1 FROM edition_contributors ec
        JOIN persons p ON p.id = ec.person_id
        WHERE ec.edition_id = e.id AND ec.role = 'translator'
          AND (${likeAny('COALESCE(ec.display_name, p.name)', variants, likeParams)})
      )`,
      `EXISTS (SELECT 1 FROM series s WHERE s.id = e.series_id AND (${likeAny('s.name', variants, likeParams)}))`,
      `EXISTS (SELECT 1 FROM tags t WHERE t.edition_id = e.id AND (${likeAny('t.name', variants, likeParams)}))`,
    ].join(' OR ');
    clauses.push(`(${like})`);
    params.push(...likeParams);
  } else {
    const phrases = variants.filter((variant) => codePoints(variant) >= 3).map(ftsPhrase);
    if (phrases.length > 0) {
      clauses.push('e.id IN (SELECT rowid FROM edition_fts WHERE edition_fts MATCH ?)');
      params.push(phrases.join(' OR '));
    }
  }
  const isbn = isbnKey(q);
  if (isbn) {
    clauses.push(`EXISTS (
      SELECT 1 FROM identifiers i
      WHERE i.edition_id = e.id
        AND instr(lower(i.scheme), 'isbn') > 0
        AND ${COMPACT_ISBN_EXPR} LIKE ? ESCAPE '\\'
    )`);
    params.push(likePattern(isbn));
  }
  if (clauses.length === 0) return { sql: '0', params: [] };
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function inClause(column: string, values: number[], params: Array<string | number>): string {
  params.push(...values);
  return `${column} IN (${values.map(() => '?').join(', ')})`;
}

function filterSql(input: LibraryQuery): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = [];
  const parts = ['e.trashed_at IS NULL', inClause('e.library_id', input.libraryIds, params)];
  if (input.language) {
    parts.push('e.language = ? COLLATE NOCASE');
    params.push(input.language);
  }
  if (input.format) {
    parts.push(`EXISTS (
      SELECT 1 FROM file_assets fa
      WHERE fa.edition_id = e.id AND fa.trashed_at IS NULL AND fa.format = ?
    )`);
    params.push(input.format);
  }
  if (input.status) {
    parts.push(`EXISTS (
      SELECT 1 FROM reading_statuses rs
      WHERE rs.edition_id = e.id AND rs.user_id = ? AND rs.status = ?
    )`);
    params.push(input.userId, input.status);
  }
  if (input.shelfId != null) {
    parts.push(`EXISTS (
      SELECT 1 FROM shelf_items si
      JOIN shelves s ON s.id = si.shelf_id
      WHERE si.edition_id = e.id AND s.id = ? AND s.user_id = ?
    )`);
    params.push(input.shelfId, input.userId);
  }
  if (input.q) {
    const text = textMatch(input.q);
    parts.push(text.sql);
    params.push(...text.params);
  }
  return { sql: parts.join(' AND '), params };
}

function isReadingStatus(value: string | null): value is ReadingStatus {
  return value === 'want' || value === 'reading' || value === 'finished' || value === 'on_hold';
}

function isFormat(value: string): value is 'epub' | 'pdf' {
  return value === 'epub' || value === 'pdf';
}

export function loadCards(db: AppDatabase, userId: number, ids: number[]): LibraryCard[] {
  if (ids.length === 0) return [];
  const sqlite = sqliteOf(db);
  const marks = ids.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.library_id AS libraryId, e.title, e.language,
        rs.status AS status, r.rating AS rating,
        CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END AS favorite
      FROM editions e
      LEFT JOIN reading_statuses rs ON rs.edition_id = e.id AND rs.user_id = ?
      LEFT JOIN ratings r ON r.edition_id = e.id AND r.user_id = ?
      LEFT JOIN favorites f ON f.edition_id = e.id AND f.user_id = ?
      WHERE e.id IN (${marks})`,
    )
    .all(userId, userId, userId, ...ids) as CardRow[];
  const authors = new Map<number, string[]>();
  const authorRows = sqlite
    .prepare(
      `SELECT ec.edition_id AS editionId, COALESCE(ec.display_name, p.name) AS name
      FROM edition_contributors ec
      JOIN persons p ON p.id = ec.person_id
      WHERE ec.role = 'author' AND ec.edition_id IN (${marks})
      ORDER BY ec.position, p.id`,
    )
    .all(...ids) as Array<{ editionId: number; name: string }>;
  for (const row of authorRows) {
    const list = authors.get(row.editionId) ?? [];
    list.push(row.name);
    authors.set(row.editionId, list);
  }
  const formats = new Map<number, Array<'epub' | 'pdf'>>();
  const formatRows = sqlite
    .prepare(
      `SELECT edition_id AS editionId, format
      FROM file_assets
      WHERE trashed_at IS NULL AND edition_id IN (${marks})
      ORDER BY id`,
    )
    .all(...ids) as Array<{ editionId: number; format: string }>;
  for (const row of formatRows) {
    if (!isFormat(row.format)) continue;
    const list = formats.get(row.editionId) ?? [];
    if (!list.includes(row.format)) list.push(row.format);
    formats.set(row.editionId, list);
  }
  const covers = new Set(
    (
      sqlite.prepare(`SELECT DISTINCT edition_id AS editionId FROM covers WHERE edition_id IN (${marks})`).all(...ids) as Array<{
        editionId: number;
      }>
    ).map((row) => row.editionId),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cards: LibraryCard[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    cards.push({
      id: row.id,
      libraryId: row.libraryId,
      title: row.title,
      authors: authors.get(row.id) ?? [],
      language: row.language,
      formats: formats.get(row.id) ?? [],
      hasCover: covers.has(row.id),
      status: isReadingStatus(row.status) ? row.status : null,
      rating: row.rating,
      favorite: row.favorite === 1,
    });
  }
  return cards;
}

export function listUserShelves(db: AppDatabase, userId: number, libraryIds: number[]): ShelfSummary[] {
  const sqlite = sqliteOf(db);
  if (libraryIds.length === 0) {
    return sqlite
      .prepare(
        `SELECT id, name, 0 AS count
        FROM shelves
        WHERE user_id = ?
        ORDER BY position, id`,
      )
      .all(userId) as ShelfSummary[];
  }
  const marks = libraryIds.map(() => '?').join(', ');
  return sqlite
    .prepare(
      `SELECT s.id, s.name,
        (
          SELECT count(*)
          FROM shelf_items si
          JOIN editions e ON e.id = si.edition_id
          WHERE si.shelf_id = s.id AND e.trashed_at IS NULL AND e.library_id IN (${marks})
        ) AS count
      FROM shelves s
      WHERE s.user_id = ?
      ORDER BY s.position, s.id`,
    )
    .all(...libraryIds, userId) as ShelfSummary[];
}

export function listLanguages(db: AppDatabase, libraryIds: number[]): string[] {
  if (libraryIds.length === 0) return [];
  const sqlite = sqliteOf(db);
  const marks = libraryIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT language
      FROM editions
      WHERE trashed_at IS NULL AND library_id IN (${marks})
        AND language IS NOT NULL AND trim(language) != ''
      ORDER BY language`,
    )
    .all(...libraryIds) as Array<{ language: string }>;
  return rows.map((row) => row.language);
}

export function searchLibrary(db: AppDatabase, input: LibraryQuery): LibraryPage {
  const shelves = listUserShelves(db, input.userId, input.libraryIds);
  const languages = listLanguages(db, input.libraryIds);
  if (input.libraryIds.length === 0) {
    return { editions: [], total: 0, limit: input.limit, offset: input.offset, languages, shelves };
  }
  const where = filterSql(input);
  const sqlite = sqliteOf(db);
  const totalRow = sqlite.prepare(`SELECT count(*) AS total FROM editions e WHERE ${where.sql}`).get(...where.params) as {
    total: number;
  };
  const idRows = sqlite
    .prepare(
      `SELECT e.id FROM editions e
      WHERE ${where.sql}
      ORDER BY e.sort_title, e.id
      LIMIT ? OFFSET ?`,
    )
    .all(...where.params, input.limit, input.offset) as Array<{ id: number }>;
  return {
    editions: loadCards(db, input.userId, idRows.map((row) => row.id)),
    total: totalRow.total,
    limit: input.limit,
    offset: input.offset,
    languages,
    shelves,
  };
}

export function loadHome(db: AppDatabase, userId: number, libraryIds: number[]): HomePayload {
  const shelfList = listUserShelves(db, userId, libraryIds);
  if (libraryIds.length === 0) return { continueReading: [], recent: [], shelves: shelfList };
  const sqlite = sqliteOf(db);
  const marks = libraryIds.map(() => '?').join(', ');
  const continueRows = sqlite
    .prepare(
      `SELECT e.id, rp.updated_at AS updatedAt
      FROM reading_positions rp
      JOIN editions e ON e.id = rp.edition_id
      WHERE rp.user_id = ? AND e.trashed_at IS NULL AND e.library_id IN (${marks})
      ORDER BY rp.updated_at DESC, e.id DESC
      LIMIT ${CONTINUE_LIMIT}`,
    )
    .all(userId, ...libraryIds) as Array<{ id: number; updatedAt: string }>;
  const continueCards = new Map(loadCards(db, userId, continueRows.map((row) => row.id)).map((card) => [card.id, card]));
  const continueReading = continueRows.flatMap((row) => {
    const card = continueCards.get(row.id);
    return card ? [{ ...card, updatedAt: row.updatedAt }] : [];
  });
  const recentRows = sqlite
    .prepare(
      `SELECT id FROM editions
      WHERE trashed_at IS NULL AND library_id IN (${marks})
      ORDER BY created_at DESC, id DESC
      LIMIT ${RECENT_LIMIT}`,
    )
    .all(...libraryIds) as Array<{ id: number }>;
  return {
    continueReading,
    recent: loadCards(db, userId, recentRows.map((row) => row.id)),
    shelves: shelfList,
  };
}

export function loadReading(db: AppDatabase, userId: number, editionId: number): ReadingState {
  const status = db
    .select({ status: readingStatuses.status })
    .from(readingStatuses)
    .where(and(eq(readingStatuses.userId, userId), eq(readingStatuses.editionId, editionId)))
    .get();
  const rating = db
    .select({ rating: ratings.rating })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.editionId, editionId)))
    .get();
  const favorite = db
    .select({ userId: favorites.userId })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.editionId, editionId)))
    .get();
  const queued = db
    .select({ userId: readingQueues.userId })
    .from(readingQueues)
    .where(and(eq(readingQueues.userId, userId), eq(readingQueues.editionId, editionId)))
    .get();
  const shelfRows = db
    .select({ id: shelves.id, name: shelves.name })
    .from(shelves)
    .where(eq(shelves.userId, userId))
    .orderBy(asc(shelves.position), asc(shelves.id))
    .all();
  const included = new Set(
    db
      .select({ shelfId: shelfItems.shelfId })
      .from(shelfItems)
      .where(eq(shelfItems.editionId, editionId))
      .all()
      .map((row) => row.shelfId),
  );
  return {
    status: status && isReadingStatus(status.status) ? status.status : null,
    rating: rating?.rating ?? null,
    favorite: Boolean(favorite),
    queued: Boolean(queued),
    shelves: shelfRows.map((shelf) => ({ id: shelf.id, name: shelf.name, included: included.has(shelf.id) })),
  };
}

export function loadNeighbors(db: AppDatabase, editionId: number): {
  previous: SeriesNeighbor | null;
  next: SeriesNeighbor | null;
  series: SeriesNeighbor[];
} {
  const edition = db
    .select({ seriesId: editions.seriesId, libraryId: editions.libraryId })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  if (!edition?.seriesId) return { previous: null, next: null, series: [] };
  const series = sqliteOf(db)
    .prepare(
      `SELECT id, title, series_order AS seriesOrder
      FROM editions
      WHERE series_id = ? AND trashed_at IS NULL AND library_id = ?
      ORDER BY CASE WHEN series_order IS NULL THEN 1 ELSE 0 END, series_order, id`,
    )
    .all(edition.seriesId, edition.libraryId) as SeriesNeighbor[];
  const index = series.findIndex((item) => item.id === editionId);
  return {
    previous: index > 0 ? (series[index - 1] ?? null) : null,
    next: index >= 0 && index < series.length - 1 ? (series[index + 1] ?? null) : null,
    series,
  };
}

export function presentLibraryEdition(db: AppDatabase, userId: number, editionId: number) {
  return {
    ...getEditionDetail(db, editionId, listOpenSuggestions(db, editionId)),
    reading: loadReading(db, userId, editionId),
    neighbors: loadNeighbors(db, editionId),
  };
}

export function setReading(db: AppDatabase, userId: number, editionId: number, patch: ReadingPatch, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    requireLiveEdition(query, editionId);
    if (patch.status !== undefined) {
      if (patch.status === null) {
        query.delete(readingStatuses).where(and(eq(readingStatuses.userId, userId), eq(readingStatuses.editionId, editionId))).run();
      } else {
        query
          .insert(readingStatuses)
          .values({ userId, editionId, status: patch.status, updatedAt: stamp })
          .onConflictDoUpdate({
            target: [readingStatuses.userId, readingStatuses.editionId],
            set: { status: patch.status, updatedAt: stamp },
          })
          .run();
      }
    }
    if (patch.rating !== undefined) {
      if (patch.rating === null) {
        query.delete(ratings).where(and(eq(ratings.userId, userId), eq(ratings.editionId, editionId))).run();
      } else {
        query
          .insert(ratings)
          .values({ userId, editionId, rating: patch.rating, updatedAt: stamp })
          .onConflictDoUpdate({
            target: [ratings.userId, ratings.editionId],
            set: { rating: patch.rating, updatedAt: stamp },
          })
          .run();
      }
    }
    if (patch.favorite === true) {
      query.insert(favorites).values({ userId, editionId, createdAt: stamp }).onConflictDoNothing().run();
    } else if (patch.favorite === false) {
      query.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.editionId, editionId))).run();
    }
    if (patch.queued === true) {
      const existing = query
        .select({ userId: readingQueues.userId })
        .from(readingQueues)
        .where(and(eq(readingQueues.userId, userId), eq(readingQueues.editionId, editionId)))
        .get();
      if (!existing) {
        const maxRow = query
          .select({ max: sql<number | null>`max(${readingQueues.position})` })
          .from(readingQueues)
          .where(eq(readingQueues.userId, userId))
          .get();
        query
          .insert(readingQueues)
          .values({ userId, editionId, position: (maxRow?.max ?? -1) + 1, addedAt: stamp })
          .run();
      }
    } else if (patch.queued === false) {
      query.delete(readingQueues).where(and(eq(readingQueues.userId, userId), eq(readingQueues.editionId, editionId))).run();
    }
  }, { behavior: 'immediate' });
}

export function cleanShelfName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length < 1 || name.length > 120) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function createShelf(
  db: AppDatabase,
  userId: number,
  name: string,
  editionId: number | null,
  now = new Date(),
): { id: number; name: string } {
  const stamp = now.toISOString();
  try {
    return db.transaction((tx) => {
      const query = tx as unknown as AppDatabase;
      if (editionId != null) requireLiveEdition(query, editionId);
      const maxRow = query
        .select({ max: sql<number | null>`max(${shelves.position})` })
        .from(shelves)
        .where(eq(shelves.userId, userId))
        .get();
      const inserted = query
        .insert(shelves)
        .values({ userId, name, position: (maxRow?.max ?? -1) + 1, createdAt: stamp })
        .returning({ id: shelves.id, name: shelves.name })
        .get();
      if (!inserted) throw new CatalogError('invalid_request');
      if (editionId != null) {
        query.insert(shelfItems).values({ shelfId: inserted.id, editionId, position: 0, addedAt: stamp }).run();
      }
      return inserted;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (isUniqueConstraint(error)) throw new CatalogError('conflict');
    throw error;
  }
}

function requireOwnShelf(db: AppDatabase, userId: number, shelfId: number): void {
  const shelf = db.select({ userId: shelves.userId }).from(shelves).where(eq(shelves.id, shelfId)).get();
  if (!shelf || shelf.userId !== userId) throw new CatalogError('not_found');
}

export function addShelfItem(db: AppDatabase, userId: number, shelfId: number, editionId: number, now = new Date()): void {
  const stamp = now.toISOString();
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    requireOwnShelf(query, userId, shelfId);
    requireLiveEdition(query, editionId);
    const existing = query
      .select({ editionId: shelfItems.editionId })
      .from(shelfItems)
      .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.editionId, editionId)))
      .get();
    if (existing) return;
    const maxRow = query
      .select({ max: sql<number | null>`max(${shelfItems.position})` })
      .from(shelfItems)
      .where(eq(shelfItems.shelfId, shelfId))
      .get();
    query
      .insert(shelfItems)
      .values({ shelfId, editionId, position: (maxRow?.max ?? -1) + 1, addedAt: stamp })
      .run();
  }, { behavior: 'immediate' });
}

export function removeShelfItem(db: AppDatabase, userId: number, shelfId: number, editionId: number): void {
  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    requireOwnShelf(query, userId, shelfId);
    query.delete(shelfItems).where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.editionId, editionId))).run();
  }, { behavior: 'immediate' });
}

export function findOwnShelf(db: AppDatabase, userId: number, shelfId: number): { id: number } | null {
  const shelf = db.select({ id: shelves.id, userId: shelves.userId }).from(shelves).where(eq(shelves.id, shelfId)).get();
  if (!shelf || shelf.userId !== userId) return null;
  return { id: shelf.id };
}
