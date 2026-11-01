import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../db.js';
import { releaseUnreferenced } from '../edition-fields.js';
import { editions, metadataPreviews } from '../schema.js';
import { AssistantError } from './assistant/client.js';

/**
 * A private edition is never sent to the metadata assistant: no filename, text, page images,
 * fields or identifiers, and no web_search or fetch_page on its behalf.
 */
export function isEditionPrivate(db: AppDatabase, editionId: number): boolean {
  const row = db.select({ metadataPrivate: editions.metadataPrivate }).from(editions).where(eq(editions.id, editionId)).get();
  return row?.metadataPrivate === true;
}

/** Thrown before anything about a private book reaches the assistant. */
export function assertNotPrivate(isPrivate: boolean | undefined): void {
  if (isPrivate !== false) throw new AssistantError('metadata_private');
}

/**
 * Marks an edition private inside the caller's transaction and deletes its pending
 * (unapplied) lookup previews, so stale agent results can never be applied. Returns the
 * staged cover hashes the caller releases once the transaction has committed.
 */
export function markEditionPrivate(db: AppDatabase, editionId: number, stamp: string): string[] {
  db.update(editions).set({ metadataPrivate: true, updatedAt: stamp }).where(eq(editions.id, editionId)).run();
  return discardPendingPreviews(db, editionId);
}

/**
 * Deletes an edition's pending (unapplied) lookup previews inside the caller's transaction.
 * Returns the staged cover hashes the caller releases once the transaction has committed.
 */
export function discardPendingPreviews(db: AppDatabase, editionId: number): string[] {
  const pending = and(eq(metadataPreviews.editionId, editionId), isNull(metadataPreviews.appliedAt));
  const staged = db.select({ coverSha256: metadataPreviews.coverSha256 }).from(metadataPreviews).where(pending).all();
  db.delete(metadataPreviews).where(pending).run();
  return staged.map((row) => row.coverSha256).filter((hash): hash is string => hash !== null);
}

/** The edition page's toggle. Making a book private discards its pending lookup preview. */
export function setEditionMetadataPrivate(
  db: AppDatabase,
  dataDir: string,
  editionId: number,
  value: boolean,
  now = new Date(),
): void {
  const stamp = now.toISOString();
  const released = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    if (value) return markEditionPrivate(query, editionId, stamp);
    query.update(editions).set({ metadataPrivate: false, updatedAt: stamp }).where(eq(editions.id, editionId)).run();
    return [];
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, released);
}
