import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { hashFile, writeImmutableBlob } from './blobs.js';
import { addIndexedAsset, addManagedAsset, createEdition } from './catalog.js';
import type { AppDatabase } from './db.js';
import { fileKind, parseBookFile } from './books.js';
import { BookError, type BookMetadata } from './metadata.js';
import { upsertPerson } from './persons.js';
import { covers, editionContributors, editions, fileAssets, identifiers, jobItems } from './schema.js';
import { recordEditionSuggestions } from './suggestions.js';
import { cleanDescription, cleanLanguage, cleanName, cleanPublisher, cleanTitle } from './text.js';

export interface ImportCommitInput {
  dataDir: string;
  libraryId: number;
  storage: 'managed' | 'indexed';
  absolutePath: string;
  relativePath: string | null;
  originalFilename: string;
  itemId: number;
  maxBytes: number | null;
}

/**
 * Hashes the original bytes, reuses an existing asset when the hash is already
 * in this library, and otherwise creates a new edition. A similar title with
 * different bytes is not merged.
 */
export function commitImportedFile(db: AppDatabase, input: ImportCommitInput, now = new Date()): void {
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
  const preliminary = findByHash(db, input.libraryId, sha256);
  const metadata = preliminary ? null : parseBookFile(input.originalFilename, input.absolutePath);
  const stamp = now.toISOString();

  db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const existing = findByHash(query, input.libraryId, sha256);
    if (existing) {
      query
        .update(jobItems)
        .set({
          status: 'duplicate',
          error: null,
          editionId: existing.editionId,
          assetId: existing.id,
          sha256,
          updatedAt: stamp,
        })
        .where(eq(jobItems.id, input.itemId))
        .run();
      return;
    }
    if (!metadata) throw new BookError('malformed');
    const edition = createEdition(query, {
      libraryId: input.libraryId,
      title: displayTitle(metadata, input.originalFilename),
      language: cleanLanguage(metadata.language),
      publisher: cleanPublisher(metadata.publisher),
      description: cleanDescription(metadata.description),
    }, now);
    linkCreators(query, edition.id, metadata, stamp);
    linkIdentifiers(query, edition.id, metadata);
    recordEditionSuggestions(query, edition.id, stamp);
    const asset =
      input.storage === 'managed'
        ? addManagedAsset(query, {
            dataDir: input.dataDir,
            editionId: edition.id,
            bytes: bytes ?? Buffer.alloc(0),
            format: kind,
            originalFilename: input.originalFilename,
          }, now)
        : addIndexedAsset(query, {
            editionId: edition.id,
            relativePath: input.relativePath ?? '',
            format: kind,
            originalFilename: input.originalFilename,
          }, now);
    if (metadata.cover) {
      const blob = writeImmutableBlob(input.dataDir, metadata.cover.bytes);
      query
        .insert(covers)
        .values({
          editionId: edition.id,
          sha256: blob.sha256,
          bytes: blob.bytes,
          mediaType: metadata.cover.mediaType,
          relativePath: blob.relativePath,
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
        updatedAt: stamp,
      })
      .where(eq(jobItems.id, input.itemId))
      .run();
  }, { behavior: 'immediate' });
}

function findByHash(db: AppDatabase, libraryId: number, sha256: string): { id: number; editionId: number } | null {
  const row = db
    .select({ id: fileAssets.id, editionId: fileAssets.editionId })
    .from(fileAssets)
    .innerJoin(editions, eq(editions.id, fileAssets.editionId))
    .where(and(eq(editions.libraryId, libraryId), eq(fileAssets.sha256, sha256)))
    .orderBy(asc(fileAssets.id))
    .get();
  return row ?? null;
}

function linkCreators(db: AppDatabase, editionId: number, metadata: BookMetadata, now: string): void {
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

function linkIdentifiers(db: AppDatabase, editionId: number, metadata: BookMetadata): void {
  const seen = new Set<string>();
  for (const identifier of metadata.identifiers) {
    const scheme = identifier.scheme.trim().toLowerCase().slice(0, 40);
    const value = identifier.value.trim().slice(0, 500);
    if (!scheme || !value || /[\u0000-\u001f\u007f]/.test(scheme) || /[\u0000-\u001f\u007f]/.test(value)) continue;
    const key = `${scheme}\0${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    db.insert(identifiers).values({ editionId, scheme, value }).run();
  }
}

function displayTitle(metadata: BookMetadata, filename: string): string {
  return cleanTitle(metadata.title) ?? cleanTitle(fileStem(filename)) ?? 'Untitled';
}

function fileStem(filename: string): string {
  const base = path.posix.basename(filename.replaceAll('\\', '/'));
  const stem = base.replace(/\.[^.]+$/, '');
  return stem || base;
}


