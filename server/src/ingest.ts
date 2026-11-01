import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { hashFile, writeImmutableBlob } from './blobs.js';
import { CatalogError, addIndexedAsset, addManagedAsset, createEdition, findOrCreateSeries } from './catalog.js';
import type { AppDatabase } from './db.js';
import { fileKind, parseBookFile } from './books.js';
import { type IdentifierInput, addIdentifiers, loadLocks, releaseUnreferenced } from './edition-fields.js';
import { markEditionPrivate } from './metadata/privacy.js';
import { findIdentifierMatch } from './merge.js';
import { BookError, type BookMetadata } from './metadata.js';
import { upsertPerson } from './persons.js';
import { deriveCoverTint } from './cover-tint.js';
import { covers, editionContributors, editions, fileAssets, jobItems } from './schema.js';
import { recordEditionSuggestions } from './suggestions.js';
import {
  cleanDescription,
  cleanLanguage,
  cleanName,
  cleanPublishedDate,
  cleanPublisher,
  cleanTitle,
} from './text.js';

export interface ImportFileInput {
  dataDir: string;
  libraryId: number;
  storage: 'managed' | 'indexed';
  absolutePath: string;
  relativePath: string | null;
  originalFilename: string;
  itemId: number;
  maxBytes: number | null;
}

export type ImportMetadata = Omit<BookMetadata, 'identifiers'> & {
  /** Normalized by the caller. A missing source means 'embedded'. */
  identifiers: IdentifierInput[];
  publishedDate?: string | null;
  series?: string | null;
  seriesOrder?: number | null;
};

export interface PreparedImport extends ImportFileInput {
  kind: 'epub' | 'pdf';
  sha256: string;
  bytes: Buffer | null;
  metadata: BookMetadata | null;
  duplicate: { id: number; editionId: number } | null;
}

/**
 * Reads and hashes the original bytes, checks the format and size, looks for an
 * existing asset in this library, and parses embedded metadata when the file is
 * new. Nothing is written here, so a failed metadata step leaves no book blob.
 */
export function prepareImportedFile(db: AppDatabase, input: ImportFileInput): PreparedImport {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(input.absolutePath);
  } catch {
    throw new BookError('missing');
  }
  if (!stat.isFile()) throw new BookError('missing');
  const kind = fileKind(input.originalFilename);
  if (kind === 'unsupported') throw new BookError('unsupported');
  if (input.maxBytes !== null && stat.size > input.maxBytes) throw new BookError('malformed');

  const bytes = input.storage === 'managed' ? readFileSync(input.absolutePath) : null;
  if (input.storage === 'managed' && !bytes) throw new BookError('malformed');
  const sha256 =
    bytes === null ? hashFile(input.absolutePath).sha256 : createHash('sha256').update(bytes).digest('hex');
  const duplicate = findByHash(db, input.libraryId, sha256);
  const metadata = duplicate ? null : parseBookFile(input.originalFilename, input.absolutePath);
  return { ...input, kind, sha256, bytes, metadata, duplicate };
}

export interface CommitOptions {
  /** An admin's decision on an item that needed confirmation. */
  resolution?: { action: 'merge' | 'separate'; candidateEditionId: number | null };
  /** Stored with a needs_confirmation item, so a resolution can finish it without the agent. */
  pending?: unknown;
  /**
   * The batch kept this file private from the metadata assistant. A private file makes the
   * edition it creates, joins, or duplicates private; joining never makes a private edition public.
   */
  metadataPrivate?: boolean;
  now?: Date;
}

/** The file's own title, authors, format and the identifier that matched, for a needs_confirmation item. */
export interface IncomingSummary {
  title: string | null;
  authors: string[];
  format: 'epub' | 'pdf';
  identifier: { scheme: string; value: string };
}

export type CommitOutcome = 'created' | 'merged' | 'duplicate' | 'needs_confirmation';

/**
 * Commits a prepared file from the supplied metadata. A duplicate is recorded
 * without creating an edition. Folder imports pass their embedded metadata here;
 * uploads pass only the metadata agent's proposal.
 *
 * When the metadata carries an identifier matching a live edition of the same
 * library (see merge.ts), the file joins that edition as another asset. A
 * conflicting match is not merged: the item waits in needs_confirmation with the
 * candidate edition until an admin resolves it.
 */
export function commitPreparedImport(
  db: AppDatabase,
  prepared: PreparedImport,
  metadata: ImportMetadata | null,
  options: CommitOptions = {},
): CommitOutcome {
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const released: string[] = [];
  const outcome = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const keepPrivate = (editionId: number): void => {
      if (options.metadataPrivate === true) released.push(...markEditionPrivate(query, editionId, stamp));
    };
    const existing = findByHash(query, prepared.libraryId, prepared.sha256);
    if (existing) {
      keepPrivate(existing.editionId);
      query
        .update(jobItems)
        .set({
          status: 'duplicate',
          error: null,
          editionId: existing.editionId,
          assetId: existing.id,
          sha256: prepared.sha256,
          pending: null,
          updatedAt: stamp,
        })
        .where(eq(jobItems.id, prepared.itemId))
        .run();
      return 'duplicate' as const;
    }
    if (!metadata) throw new BookError('malformed');

    const resolution = options.resolution;
    if (resolution?.action === 'merge') {
      const candidate = resolution.candidateEditionId;
      if (!candidate || !isLiveInLibrary(query, candidate, prepared.libraryId)) throw new CatalogError('not_found');
      attachToEdition(query, prepared, metadata, candidate, now);
      keepPrivate(candidate);
      return 'merged' as const;
    }
    if (!resolution) {
      const match = findIdentifierMatch(query, {
        libraryId: prepared.libraryId,
        identifiers: metadata.identifiers,
        title: cleanTitle(metadata.title),
        authors: metadata.creators.filter((creator) => creator.role === 'author').map((creator) => creator.name),
        format: prepared.kind,
      });
      if (match && match.conflicts.length === 0) {
        attachToEdition(query, prepared, metadata, match.editionId, now);
        keepPrivate(match.editionId);
        return 'merged' as const;
      }
      if (match) {
        // What the file brings, kept for the admin's side-by-side comparison.
        const incoming: IncomingSummary = {
          title: cleanTitle(metadata.title),
          authors: metadata.creators.filter((creator) => creator.role === 'author').map((creator) => creator.name),
          format: prepared.kind,
          identifier: match.identifier,
        };
        const kept = typeof options.pending === 'object' && options.pending !== null ? options.pending : {};
        query
          .update(jobItems)
          .set({
            status: 'needs_confirmation',
            error: null,
            editionId: null,
            assetId: null,
            sha256: prepared.sha256,
            candidateEditionId: match.editionId,
            conflicts: JSON.stringify(match.conflicts),
            pending: JSON.stringify({ ...kept, incoming }),
            resolution: null,
            updatedAt: stamp,
          })
          .where(eq(jobItems.id, prepared.itemId))
          .run();
        return 'needs_confirmation' as const;
      }
    }

    const seriesName = cleanName(metadata.series);
    const seriesOrder = seriesName ? metadata.seriesOrder ?? null : null;
    const seriesId = seriesName
      ? findOrCreateSeries(query, { libraryId: prepared.libraryId, name: seriesName }, now).id
      : null;
    const edition = createEdition(query, {
      libraryId: prepared.libraryId,
      title: displayTitle(metadata, prepared.originalFilename),
      language: cleanLanguage(metadata.language),
      publisher: cleanPublisher(metadata.publisher),
      publishedDate: cleanPublishedDate(metadata.publishedDate),
      description: cleanDescription(metadata.description),
      seriesId,
      seriesOrder,
    }, now);
    if (options.metadataPrivate === true) {
      query.update(editions).set({ metadataPrivate: true }).where(eq(editions.id, edition.id)).run();
    }
    linkCreators(query, edition.id, metadata, stamp);
    addIdentifiers(query, edition.id, metadata.identifiers, { source: 'embedded', now: stamp });
    recordEditionSuggestions(query, edition.id, stamp);
    const asset = addAsset(query, prepared, edition.id, now);
    if (metadata.cover) {
      const blob = writeImmutableBlob(prepared.dataDir, metadata.cover.bytes);
      query
        .insert(covers)
        .values({
          editionId: edition.id,
          sha256: blob.sha256,
          bytes: blob.bytes,
          mediaType: metadata.cover.mediaType,
          relativePath: blob.relativePath,
          tint: deriveCoverTint(metadata.cover.bytes, metadata.cover.mediaType) ?? '',
          createdAt: stamp,
        })
        .run();
    }
    query
      .update(jobItems)
      .set({
        status: 'succeeded',
        error: null,
        editionId: edition.id,
        assetId: asset.id,
        sha256: asset.sha256,
        pending: null,
        merged: false,
        updatedAt: stamp,
      })
      .where(eq(jobItems.id, prepared.itemId))
      .run();
    return 'created' as const;
  }, { behavior: 'immediate' });
  // Staged covers of discarded lookup previews, once nothing else refers to them.
  if (released.length > 0) releaseUnreferenced(db, prepared.dataDir, released);
  return outcome;
}

/**
 * Adds the file to an existing edition as another asset. The edition's fields
 * stay as they are; identifiers it lacks are added unless its identifiers are locked.
 */
function attachToEdition(
  db: AppDatabase,
  prepared: PreparedImport,
  metadata: ImportMetadata,
  editionId: number,
  now: Date,
): void {
  const stamp = now.toISOString();
  const asset = addAsset(db, prepared, editionId, now);
  if (!loadLocks(db, editionId).has('identifiers')) {
    addIdentifiers(db, editionId, metadata.identifiers, { source: 'embedded', now: stamp });
  }
  db.update(editions).set({ updatedAt: stamp }).where(eq(editions.id, editionId)).run();
  db.update(jobItems)
    .set({
      status: 'succeeded',
      error: null,
      editionId,
      assetId: asset.id,
      sha256: asset.sha256,
      pending: null,
      merged: true,
      updatedAt: stamp,
    })
    .where(eq(jobItems.id, prepared.itemId))
    .run();
}

function addAsset(db: AppDatabase, prepared: PreparedImport, editionId: number, now: Date) {
  return prepared.storage === 'managed'
    ? addManagedAsset(db, {
        dataDir: prepared.dataDir,
        editionId,
        bytes: prepared.bytes ?? Buffer.alloc(0),
        format: prepared.kind,
        originalFilename: prepared.originalFilename,
      }, now)
    : addIndexedAsset(db, {
        editionId,
        relativePath: prepared.relativePath ?? '',
        format: prepared.kind,
        originalFilename: prepared.originalFilename,
      }, now);
}

function isLiveInLibrary(db: AppDatabase, editionId: number, libraryId: number): boolean {
  const row = db
    .select({ libraryId: editions.libraryId, trashedAt: editions.trashedAt })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  return Boolean(row && !row.trashedAt && row.libraryId === libraryId);
}

/** A live file of a live edition with these bytes. A copy only in trash is not a duplicate. */
function findByHash(db: AppDatabase, libraryId: number, sha256: string): { id: number; editionId: number } | null {
  const row = db
    .select({ id: fileAssets.id, editionId: fileAssets.editionId })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .where(
      and(
        eq(editions.libraryId, libraryId),
        eq(fileAssets.sha256, sha256),
        isNull(editions.trashedAt),
        isNull(fileAssets.trashedAt),
      ),
    )
    .orderBy(asc(fileAssets.id))
    .get();
  return row ?? null;
}

function linkCreators(db: AppDatabase, editionId: number, metadata: ImportMetadata, now: string): void {
  const seen = new Set<string>();
  let position = 0;
  for (const creator of metadata.creators) {
    const name = cleanName(creator.name);
    if (!name) continue;
    const key = `${creator.role}\0${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const personId = upsertPerson(db, name, now);
    db.insert(editionContributors)
      .values({ editionId, personId, role: creator.role, position, displayName: name })
      .run();
    position += 1;
  }
}

function displayTitle(metadata: ImportMetadata, filename: string): string {
  return cleanTitle(metadata.title) ?? cleanTitle(fileStem(filename)) ?? 'Untitled';
}

function fileStem(filename: string): string {
  const base = path.posix.basename(filename.replaceAll('\\', '/'));
  const stem = base.replace(/\.[^.]+$/, '');
  return stem || base;
}
