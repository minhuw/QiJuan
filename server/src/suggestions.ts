import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { normalizeMatchKey } from './normalize.js';
import { editionContributors, editionSuggestions, editions, persons } from './schema.js';
import { isUniqueConstraint } from './sql-errors.js';

export interface EditionSuggestionView {
  id: number;
  otherEditionId: number;
  otherTitle: string;
}

/**
 * When a newly imported file shares a normalized title and main author with
 * another edition, remember that — and leave both editions in place.
 */
export function recordEditionSuggestions(db: AppDatabase, editionId: number, now: string): void {
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
    try {
      db.insert(editionSuggestions)
        .values({
          libraryId: edition.libraryId,
          editionId: edition.id,
          matchedEditionId: otherId,
          createdAt: now,
        })
        .run();
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
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
  for (const row of rows) {
    const otherId = row.editionId === editionId ? row.matchedEditionId : row.editionId;
    const other = db
      .select({ title: editions.title, trashedAt: editions.trashedAt })
      .from(editions)
      .where(eq(editions.id, otherId))
      .get();
    if (!other || other.trashedAt) continue;
    views.push({ id: row.id, otherEditionId: otherId, otherTitle: other.title });
  }
  return views;
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
