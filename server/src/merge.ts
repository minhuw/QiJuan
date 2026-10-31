import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { loadAlternateTitles, loadNames } from './edition-fields.js';
import { STRONG_SCHEMES, isMergeScheme, normalizeIdentifier } from './identifiers.js';
import { normalizeMatchKey } from './normalize.js';
import { editionIdentifiers, editions, fileAssets } from './schema.js';

/**
 * Why a file that matched an edition by identifier was not merged into it:
 * the titles differ, the author lists share no one, the edition already has
 * this format, or the identifiers point at more than one edition.
 */
export type MergeConflict = 'title' | 'authors' | 'format' | 'ambiguous';
export const MERGE_CONFLICTS: readonly MergeConflict[] = ['title', 'authors', 'format', 'ambiguous'];

export interface IdentifierMatch {
  editionId: number;
  conflicts: MergeConflict[];
  /** The first incoming identifier the chosen edition shares. */
  identifier: { scheme: string; value: string };
}

export interface IncomingRecord {
  libraryId: number;
  identifiers: Array<{ scheme: string; value: string }>;
  title: string | null;
  authors: string[];
  format: 'epub' | 'pdf';
}

/**
 * Looks for a live edition in the same library sharing an identifier that can
 * merge (a strong scheme, or a platform id with the same scheme and value).
 * Returns the best candidate and any conflicts, or null when nothing matches.
 * Editions matched by a strong identifier come first, then the oldest.
 */
export function findIdentifierMatch(db: AppDatabase, incoming: IncomingRecord): IdentifierMatch | null {
  const strong = new Set<number>();
  const all = new Set<number>();
  const matchedBy = new Map<number, { scheme: string; value: string }>();
  for (const identifier of incoming.identifiers) {
    const normalized = normalizeIdentifier(identifier.scheme, identifier.value);
    if (!normalized.ok || !isMergeScheme(normalized.scheme)) continue;
    const rows = db
      .select({ editionId: editionIdentifiers.editionId })
      .from(editionIdentifiers)
      .innerJoin(editions, eq(editions.id, editionIdentifiers.editionId))
      .where(
        and(
          eq(editionIdentifiers.scheme, normalized.scheme),
          eq(editionIdentifiers.value, normalized.value),
          eq(editions.libraryId, incoming.libraryId),
          isNull(editions.trashedAt),
        ),
      )
      .orderBy(asc(editionIdentifiers.editionId))
      .all();
    for (const row of rows) {
      all.add(row.editionId);
      // A strong identifier names the match over a platform id.
      if (!matchedBy.has(row.editionId) || (STRONG_SCHEMES.has(normalized.scheme) && !strong.has(row.editionId))) {
        matchedBy.set(row.editionId, { scheme: normalized.scheme, value: normalized.value });
      }
      if (STRONG_SCHEMES.has(normalized.scheme)) strong.add(row.editionId);
    }
  }
  if (all.size === 0) return null;
  const ordered = [...all].sort((a, b) => Number(strong.has(b)) - Number(strong.has(a)) || a - b);
  const editionId = ordered[0]!;
  const conflicts = editionConflicts(db, editionId, incoming);
  if (all.size > 1) conflicts.push('ambiguous');
  return { editionId, conflicts, identifier: matchedBy.get(editionId)! };
}

/** Conflicts between an incoming record and one edition. */
export function editionConflicts(db: AppDatabase, editionId: number, incoming: IncomingRecord): MergeConflict[] {
  const edition = db.select({ title: editions.title }).from(editions).where(eq(editions.id, editionId)).get();
  if (!edition) return [];
  const conflicts: MergeConflict[] = [];
  const incomingTitle = incoming.title ? normalizeMatchKey(incoming.title) : '';
  if (incomingTitle) {
    const titles = [edition.title, ...loadAlternateTitles(db, editionId).map((item) => item.title)].map(normalizeMatchKey);
    if (!titles.includes(incomingTitle)) conflicts.push('title');
  }
  const incomingAuthors = new Set(incoming.authors.map(normalizeMatchKey).filter(Boolean));
  const authors = loadNames(db, editionId, 'author').map(normalizeMatchKey).filter(Boolean);
  if (incomingAuthors.size > 0 && authors.length > 0 && !authors.some((name) => incomingAuthors.has(name))) {
    conflicts.push('authors');
  }
  const sameFormat = db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(and(eq(fileAssets.editionId, editionId), eq(fileAssets.format, incoming.format), isNull(fileAssets.trashedAt)))
    .get();
  if (sameFormat) conflicts.push('format');
  return conflicts;
}
