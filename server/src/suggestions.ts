import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { isMergeScheme } from './identifiers.js';
import { normalizeMatchKey } from './normalize.js';
import { editionContributors, editionIdentifiers, editionSuggestions, editions, persons } from './schema.js';
import { isUniqueConstraint } from './sql-errors.js';

/** Why two editions look alike: the same title and main author, or a shared identifier. */
export type SuggestionReason = 'title_author' | 'identifier';

export interface EditionSuggestionView {
  id: number;
  otherEditionId: number;
  otherTitle: string;
  reasons: SuggestionReason[];
  /** With the identifier reason: the first identifier the two editions share. */
  identifier?: { scheme: string; value: string };
}

/**
 * When an edition shares a normalized title and main author with another
 * edition, or an identifier that would merge an import, remember that — and
 * leave both editions in place.
 */
export function recordEditionSuggestions(db: AppDatabase, editionId: number, now: string): void {
  recordTitleAuthorSuggestions(db, editionId, now);
  recordIdentifierSuggestions(db, editionId, now);
}

/** Suggests live editions of the same library that share a mergeable identifier with this one. */
export function recordIdentifierSuggestions(db: AppDatabase, editionId: number, now: string): void {
  const edition = db
    .select({ id: editions.id, libraryId: editions.libraryId, trashedAt: editions.trashedAt })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  if (!edition || edition.trashedAt) return;
  for (const otherId of sharedIdentifierEditions(db, edition.id, edition.libraryId).keys()) {
    insertSuggestion(db, edition.libraryId, Math.max(edition.id, otherId), Math.min(edition.id, otherId), now);
  }
}

/** Other live editions sharing a mergeable identifier, in id order, each with the first identifier shared. */
function sharedIdentifierEditions(
  db: AppDatabase,
  editionId: number,
  libraryId: number,
): Map<number, { scheme: string; value: string }> {
  const mine = db
    .select({ scheme: editionIdentifiers.scheme, value: editionIdentifiers.value })
    .from(editionIdentifiers)
    .where(eq(editionIdentifiers.editionId, editionId))
    .all()
    .filter((row) => isMergeScheme(row.scheme));
  const others = new Map<number, { scheme: string; value: string }>();
  for (const identifier of mine) {
    const rows = db
      .select({ editionId: editionIdentifiers.editionId })
      .from(editionIdentifiers)
      .innerJoin(editions, eq(editions.id, editionIdentifiers.editionId))
      .where(
        and(
          eq(editionIdentifiers.scheme, identifier.scheme),
          eq(editionIdentifiers.value, identifier.value),
          ne(editionIdentifiers.editionId, editionId),
          eq(editions.libraryId, libraryId),
          isNull(editions.trashedAt),
        ),
      )
      .all();
    for (const row of rows) {
      if (!others.has(row.editionId)) others.set(row.editionId, identifier);
    }
  }
  return new Map([...others].sort(([a], [b]) => a - b));
}

function insertSuggestion(db: AppDatabase, libraryId: number, editionId: number, matchedEditionId: number, now: string): void {
  if (editionId === matchedEditionId) return;
  const existing = db
    .select({ id: editionSuggestions.id })
    .from(editionSuggestions)
    .where(
      or(
        and(eq(editionSuggestions.editionId, editionId), eq(editionSuggestions.matchedEditionId, matchedEditionId)),
        and(eq(editionSuggestions.editionId, matchedEditionId), eq(editionSuggestions.matchedEditionId, editionId)),
      ),
    )
    .get();
  if (existing) return;
  try {
    db.insert(editionSuggestions).values({ libraryId, editionId, matchedEditionId, createdAt: now }).run();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
  }
}

function recordTitleAuthorSuggestions(db: AppDatabase, editionId: number, now: string): void {
  const edition = db
    .select({
      id: editions.id,
      libraryId: editions.libraryId,
      title: editions.title,
      trashedAt: editions.trashedAt,
    })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  if (!edition || edition.trashedAt) return;
  const titleKey = normalizeMatchKey(edition.title);
  if (!titleKey) return;

  const rows = db
    .select({
      editionId: editions.id,
      title: editions.title,
      name: persons.name,
      position: editionContributors.position,
      personId: persons.id,
    })
    .from(editions)
    .innerJoin(
      editionContributors,
      and(eq(editionContributors.editionId, editions.id), eq(editionContributors.role, 'author')),
    )
    .innerJoin(persons, eq(persons.id, editionContributors.personId))
    .where(and(eq(editions.libraryId, edition.libraryId), isNull(editions.trashedAt)))
    .all();

  const grouped = new Map<number, { title: string; author: { name: string; position: number; personId: number } | null }>();
  for (const row of rows) {
    let entry = grouped.get(row.editionId);
    if (!entry) {
      entry = { title: row.title, author: null };
      grouped.set(row.editionId, entry);
    }
    if (
      !entry.author ||
      row.position < entry.author.position ||
      (row.position === entry.author.position && row.personId < entry.author.personId)
    ) {
      entry.author = { name: row.name, position: row.position, personId: row.personId };
    }
  }

  const mine = grouped.get(edition.id);
  if (!mine?.author) return;
  const authorKey = normalizeMatchKey(mine.author.name);
  if (!authorKey) return;

  for (const [otherId, other] of grouped) {
    if (otherId === edition.id || !other.author) continue;
    if (normalizeMatchKey(other.title) !== titleKey) continue;
    if (normalizeMatchKey(other.author.name) !== authorKey) continue;
    insertSuggestion(db, edition.libraryId, edition.id, otherId, now);
  }
}

export function listOpenSuggestions(db: AppDatabase, editionId: number): EditionSuggestionView[] {
  const rows = db
    .select()
    .from(editionSuggestions)
    .where(
      and(
        isNull(editionSuggestions.dismissedAt),
        or(eq(editionSuggestions.editionId, editionId), eq(editionSuggestions.matchedEditionId, editionId)),
      ),
    )
    .orderBy(asc(editionSuggestions.id))
    .all();
  const views: EditionSuggestionView[] = [];
  const mine = db.select({ libraryId: editions.libraryId }).from(editions).where(eq(editions.id, editionId)).get();
  const shared = mine ? sharedIdentifierEditions(db, editionId, mine.libraryId) : new Map<number, { scheme: string; value: string }>();
  for (const row of rows) {
    const otherId = row.editionId === editionId ? row.matchedEditionId : row.editionId;
    const other = db
      .select({ title: editions.title, trashedAt: editions.trashedAt })
      .from(editions)
      .where(eq(editions.id, otherId))
      .get();
    if (!other || other.trashedAt) continue;
    const reasons: SuggestionReason[] = [];
    if (titleAuthorMatch(db, editionId, otherId)) reasons.push('title_author');
    const identifier = shared.get(otherId);
    if (identifier) reasons.push('identifier');
    views.push({ id: row.id, otherEditionId: otherId, otherTitle: other.title, reasons, ...(identifier ? { identifier } : {}) });
  }
  return views;
}

function titleAuthorMatch(db: AppDatabase, left: number, right: number): boolean {
  const keys = new Map<number, { title: string; author: string | null }>();
  const titles = db
    .select({ id: editions.id, title: editions.title })
    .from(editions)
    .where(inArray(editions.id, [left, right]))
    .all();
  for (const row of titles) {
    const author = db
      .select({ name: persons.name })
      .from(editionContributors)
      .innerJoin(persons, eq(persons.id, editionContributors.personId))
      .where(and(eq(editionContributors.editionId, row.id), eq(editionContributors.role, 'author')))
      .orderBy(asc(editionContributors.position), asc(persons.id))
      .get();
    keys.set(row.id, { title: normalizeMatchKey(row.title), author: author ? normalizeMatchKey(author.name) : null });
  }
  const a = keys.get(left);
  const b = keys.get(right);
  return Boolean(a && b && a.title && a.title === b.title && a.author && a.author === b.author);
}

export function findSuggestion(db: AppDatabase, suggestionId: number): { id: number; libraryId: number } | null {
  if (!Number.isInteger(suggestionId) || suggestionId < 1) return null;
  const row = db
    .select({ id: editionSuggestions.id, libraryId: editionSuggestions.libraryId })
    .from(editionSuggestions)
    .where(eq(editionSuggestions.id, suggestionId))
    .get();
  return row ?? null;
}

export function dismissSuggestion(db: AppDatabase, suggestionId: number, now: string): void {
  db.update(editionSuggestions)
    .set({ dismissedAt: now })
    .where(and(eq(editionSuggestions.id, suggestionId), isNull(editionSuggestions.dismissedAt)))
    .run();
}
