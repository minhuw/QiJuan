import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { absoluteBlobPath, managedBlobRelativePath } from './blobs.js';
import { parseBookFile } from './books.js';
import type { AppDatabase } from './db.js';
import {
  latestCover,
  loadIdentifiers,
  loadLocks,
  loadNames,
  releaseUnreferenced,
  replaceContributors,
  replaceIdentifiers,
  saveCoverRow,
} from './edition-fields.js';
import { editions, fileAssets, libraries } from './schema.js';
import { resolveInsideRoot } from './library-files.js';
import type { BookMetadata } from './metadata.js';
import { cleanDescription, cleanIdentifierValue, cleanLanguage, cleanName, cleanPublisher, cleanScheme, cleanTitle } from './text.js';

/**
 * Re-reads embedded metadata and writes unlocked fields.
 * Locked fields, including the cover, are left as the user set them.
 * The book file is only read.
 */
export function refreshEditionMetadata(
  db: AppDatabase,
  dataDir: string,
  editionId: number,
  now = new Date(),
): boolean {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) return false;
  const library = db.select().from(libraries).where(eq(libraries.id, edition.libraryId)).get();
  if (!library) return false;
  const asset = db
    .select()
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.editionId, editionId),
        isNull(fileAssets.trashedAt),
        eq(fileAssets.availability, 'present'),
      ),
    )
    .orderBy(asc(fileAssets.id))
    .get();
  if (!asset) return false;
  const absolute = resolveAssetPath(dataDir, library.rootPath, asset);
  if (!absolute) return false;
  let metadata: BookMetadata;
  try {
    metadata = parseBookFile(asset.originalFilename, absolute);
  } catch {
    return false;
  }
  const stamp = now.toISOString();
  const result = db.transaction((tx) => {
    return applyEmbedded(tx as unknown as AppDatabase, dataDir, editionId, metadata, stamp);
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, result.hashes);
  return result.changed;
}

export function refreshLibraryMetadata(
  db: AppDatabase,
  dataDir: string,
  libraryId: number,
  now = new Date(),
): { refreshed: number } {
  const rows = db
    .select({ id: editions.id })
    .from(editions)
    .where(and(eq(editions.libraryId, libraryId), isNull(editions.trashedAt)))
    .orderBy(asc(editions.id))
    .all();
  let refreshed = 0;
  for (const row of rows) {
    if (refreshEditionMetadata(db, dataDir, row.id, now)) refreshed += 1;
  }
  return { refreshed };
}

function applyEmbedded(
  db: AppDatabase,
  dataDir: string,
  editionId: number,
  metadata: BookMetadata,
  now: string,
): { changed: boolean; hashes: string[] } {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) return { changed: false, hashes: [] };
  const locks = loadLocks(db, edition.id);
  let changed = false;
  const hashes: string[] = [];
  const values: Partial<typeof editions.$inferInsert> = {};

  const nextTitle = cleanTitle(metadata.title);
  if (nextTitle && !locks.has('title') && nextTitle !== edition.title) {
    values.title = nextTitle;
    if (!locks.has('sort_title') && edition.sortTitle === edition.title) values.sortTitle = nextTitle;
    changed = true;
  }
  const nextLanguage = cleanLanguage(metadata.language);
  if (nextLanguage && !locks.has('language') && nextLanguage !== edition.language) {
    values.language = nextLanguage;
    changed = true;
  }
  const nextDescription = cleanDescription(metadata.description);
  if (nextDescription && !locks.has('description') && nextDescription !== edition.description) {
    values.description = nextDescription;
    changed = true;
  }
  const nextPublisher = cleanPublisher(metadata.publisher);
  if (nextPublisher && !locks.has('publisher') && nextPublisher !== edition.publisher) {
    values.publisher = nextPublisher;
    changed = true;
  }
  if (changed) {
    values.updatedAt = now;
    db.update(editions).set(values).where(eq(editions.id, edition.id)).run();
  }

  const nextAuthors = uniqueNames(metadata.creators.filter((creator) => creator.role === 'author').map((creator) => creator.name));
  if (nextAuthors.length > 0 && !locks.has('authors') && !sameStrings(loadNames(db, edition.id, 'author'), nextAuthors)) {
    replaceContributors(db, edition.id, 'author', nextAuthors, now, 'loose');
    changed = true;
  }
  const nextTranslators = uniqueNames(
    metadata.creators.filter((creator) => creator.role === 'translator').map((creator) => creator.name),
  );
  if (
    nextTranslators.length > 0 &&
    !locks.has('translators') &&
    !sameStrings(loadNames(db, edition.id, 'translator'), nextTranslators)
  ) {
    replaceContributors(db, edition.id, 'translator', nextTranslators, now, 'loose');
    changed = true;
  }
  const nextIdentifiers = metadata.identifiers.flatMap((identifier) => {
    const scheme = cleanScheme(identifier.scheme);
    const value = cleanIdentifierValue(identifier.value);
    if (!scheme || !value) return [];
    return [{ scheme, value }];
  });
  if (nextIdentifiers.length > 0 && !locks.has('identifiers') && !sameIdentifiers(loadIdentifiers(db, edition.id), nextIdentifiers)) {
    replaceIdentifiers(db, edition.id, nextIdentifiers, 'loose');
    changed = true;
  }
  if (!locks.has('cover') && metadata.cover) {
    const nextHash = createHash('sha256').update(metadata.cover.bytes).digest('hex');
    const current = latestCover(db, edition.id);
    if (!current || current.sha256 !== nextHash || current.mediaType !== metadata.cover.mediaType) {
      hashes.push(
        ...saveCoverRow(
          db,
          {
            dataDir,
            editionId: edition.id,
            bytes: metadata.cover.bytes,
            mediaType: metadata.cover.mediaType,
          },
          now,
        ),
      );
      changed = true;
    }
  }
  if (changed) {
    db.update(editions).set({ updatedAt: now }).where(eq(editions.id, edition.id)).run();
  }
  return { changed, hashes };
}

function resolveAssetPath(
  dataDir: string,
  libraryRoot: string,
  asset: { storage: string; relativePath: string; sha256: string },
): string | null {
  try {
    if (asset.storage === 'managed') {
      if (asset.relativePath !== managedBlobRelativePath(asset.sha256)) return null;
      const absolute = absoluteBlobPath(dataDir, asset.sha256);
      return existsSync(absolute) ? absolute : null;
    }
    return resolveInsideRoot(libraryRoot, asset.relativePath);
  } catch {
    return null;
  }
}

function uniqueNames(names: string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = cleanName(name);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  return cleaned;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIdentifiers(
  left: Array<{ scheme: string; value: string }>,
  right: Array<{ scheme: string; value: string }>,
): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map((item) => `${item.scheme.toLowerCase()}\0${item.value.toLowerCase()}`));
  return right.every((item) => keys.has(`${item.scheme.toLowerCase()}\0${item.value.toLowerCase()}`));
}
