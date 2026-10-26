import { eq } from 'drizzle-orm';
import { CatalogError } from '../catalog.js';
import type { AppDatabase } from '../db.js';
import {
  type LockField,
  loadIdentifiers,
  loadLocks,
  loadNames,
  lockFields,
  releaseUnreferenced,
  replaceContributors,
  replaceIdentifiers,
  saveCoverRow,
  latestCover,
} from '../edition-fields.js';
import { editions, metadataPreviews } from '../schema.js';
import {
  type OpenLibraryProposal,
  type OpenLibraryTransport,
  fetchOpenLibraryCover,
  lookupOpenLibrary,
  preferIsbn,
} from './openLibrary.js';

export const PREVIEW_FIELDS = [
  'title',
  'authors',
  'description',
  'publisher',
  'publishedDate',
  'language',
  'identifiers',
  'cover',
] as const;

export type PreviewField = (typeof PREVIEW_FIELDS)[number];

export interface FieldPreview {
  field: PreviewField;
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: string | null;
  proposed: string | null;
}

const FIELD_LOCK: Record<PreviewField, LockField> = {
  title: 'title',
  authors: 'authors',
  description: 'description',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  identifiers: 'identifiers',
  cover: 'cover',
};

export async function createMetadataPreview(
  db: AppDatabase,
  transport: OpenLibraryTransport,
  editionId: number,
  now = new Date(),
): Promise<{ previewId: number; fields: FieldPreview[] } | null> {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) return null;
  const authors = loadNames(db, edition.id, 'author');
  const identifiers = loadIdentifiers(db, edition.id);
  const proposal = await lookupOpenLibrary(transport, {
    title: edition.title,
    author: authors[0] ?? null,
    isbn: preferIsbn(identifiers),
  });
  if (!proposal) return null;
  const stamp = now.toISOString();
  const previewId = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    query.delete(metadataPreviews).where(eq(metadataPreviews.editionId, edition.id)).run();
    const inserted = query
      .insert(metadataPreviews)
      .values({ editionId: edition.id, proposal: JSON.stringify(proposal), createdAt: stamp })
      .returning({ id: metadataPreviews.id })
      .get();
    if (!inserted) throw new Error('preview insert failed');
    return inserted.id;
  }, { behavior: 'immediate' });
  return { previewId, fields: buildFieldPreviews(db, edition.id, proposal) };
}

/**
 * Writes only confirmed, unlocked fields from the stored preview.
 * A locked field stays as the user left it, even if it is confirmed.
 */
export async function applyMetadataPreview(
  db: AppDatabase,
  dataDir: string,
  transport: OpenLibraryTransport,
  input: { editionId: number; previewId: number; confirm: PreviewField[] },
  now = new Date(),
): Promise<void> {
  const preview = db.select().from(metadataPreviews).where(eq(metadataPreviews.id, input.previewId)).get();
  if (!preview || preview.editionId !== input.editionId) throw new CatalogError('not_found');
  const proposal = parseProposal(preview.proposal);
  if (!proposal) throw new CatalogError('not_found');
  const confirm = new Set(input.confirm);
  const locks = loadLocks(db, input.editionId);
  let cover: { bytes: Buffer; mediaType: string } | null = null;
  if (confirm.has('cover') && !locks.has('cover') && (proposal.coverId || proposal.isbn)) {
    cover = await fetchOpenLibraryCover(transport, { coverId: proposal.coverId, isbn: proposal.isbn });
  }
  const stamp = now.toISOString();
  const retired = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = query.select().from(editions).where(eq(editions.id, input.editionId)).get();
    if (!edition || edition.trashedAt) throw new CatalogError('not_found');
    const currentLocks = loadLocks(query, edition.id);
    const values: Partial<typeof editions.$inferInsert> = {};
    let changed = false;
    const toLock: LockField[] = [];

    if (confirm.has('title') && !currentLocks.has('title') && proposal.title) {
      values.title = proposal.title;
      if (!currentLocks.has('sort_title') && edition.sortTitle === edition.title) values.sortTitle = proposal.title;
      toLock.push('title');
      changed = true;
    }
    if (confirm.has('description') && !currentLocks.has('description') && proposal.description) {
      values.description = proposal.description;
      toLock.push('description');
      changed = true;
    }
    if (confirm.has('publisher') && !currentLocks.has('publisher') && proposal.publisher) {
      values.publisher = proposal.publisher;
      toLock.push('publisher');
      changed = true;
    }
    if (confirm.has('publishedDate') && !currentLocks.has('published_date') && proposal.publishedDate) {
      values.publishedDate = proposal.publishedDate;
      toLock.push('published_date');
      changed = true;
    }
    if (confirm.has('language') && !currentLocks.has('language') && proposal.language) {
      values.language = proposal.language;
      toLock.push('language');
      changed = true;
    }
    if (changed) {
      values.updatedAt = stamp;
      query.update(editions).set(values).where(eq(editions.id, edition.id)).run();
    }
    if (confirm.has('authors') && !currentLocks.has('authors') && proposal.authors.length > 0) {
      replaceContributors(query, edition.id, 'author', proposal.authors, stamp, 'loose');
      toLock.push('authors');
      changed = true;
    }
    if (confirm.has('identifiers') && !currentLocks.has('identifiers') && proposal.identifiers.length > 0) {
      replaceIdentifiers(query, edition.id, proposal.identifiers, 'loose');
      toLock.push('identifiers');
      changed = true;
    }
    const hashes: string[] = [];
    if (confirm.has('cover') && !currentLocks.has('cover') && cover) {
      hashes.push(
        ...saveCoverRow(
          query,
          { dataDir, editionId: edition.id, bytes: cover.bytes, mediaType: cover.mediaType },
          stamp,
        ),
      );
      toLock.push('cover');
      changed = true;
    }
    if (changed) {
      query.update(editions).set({ updatedAt: stamp }).where(eq(editions.id, edition.id)).run();
      lockFields(query, edition.id, toLock, stamp);
    }
    return hashes;
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, retired);
}

export function buildFieldPreviews(db: AppDatabase, editionId: number, proposal: OpenLibraryProposal): FieldPreview[] {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition) return [];
  const locks = loadLocks(db, edition.id);
  const authors = loadNames(db, edition.id, 'author').join(', ');
  const identifiers = loadIdentifiers(db, edition.id)
    .map((item) => `${item.scheme}|${item.value}`)
    .join(', ');
  const cover = latestCover(db, edition.id);
  const current: Record<PreviewField, string | null> = {
    title: edition.title,
    authors: authors || null,
    description: edition.description,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    language: edition.language,
    identifiers: identifiers || null,
    cover: cover ? 'present' : null,
  };
  const proposed: Record<PreviewField, string | null> = {
    title: proposal.title,
    authors: proposal.authors.length > 0 ? proposal.authors.join(', ') : null,
    description: proposal.description,
    publisher: proposal.publisher,
    publishedDate: proposal.publishedDate,
    language: proposal.language,
    identifiers: proposal.identifiers.length > 0 ? proposal.identifiers.map((item) => `${item.scheme}|${item.value}`).join(', ') : null,
    cover: proposal.coverId || proposal.isbn ? 'present' : null,
  };
  return PREVIEW_FIELDS.map((field) => {
    const locked = locks.has(FIELD_LOCK[field]);
    return {
      field,
      locked,
      status: fieldStatus(field, locked, current[field], proposed[field]),
      current: current[field],
      proposed: proposed[field],
    };
  });
}

function fieldStatus(
  field: PreviewField,
  locked: boolean,
  current: string | null,
  proposed: string | null,
): FieldPreview['status'] {
  if (locked) return 'kept';
  if (field === 'cover') {
    if (!proposed) return 'unchanged';
    return 'change';
  }
  if (!proposed) return 'unchanged';
  if ((current ?? '') === proposed) return 'unchanged';
  return 'change';
}

function parseProposal(text: string): OpenLibraryProposal | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = asNullableString(record.title);
  const description = asNullableString(record.description);
  const publisher = asNullableString(record.publisher);
  const publishedDate = asNullableString(record.publishedDate);
  const language = asNullableString(record.language);
  const isbn = asNullableString(record.isbn);
  const authors = asStringArray(record.authors);
  const identifiers = asIdentifiers(record.identifiers);
  const coverId = typeof record.coverId === 'number' && Number.isInteger(record.coverId) ? record.coverId : null;
  if (
    title === undefined ||
    description === undefined ||
    publisher === undefined ||
    publishedDate === undefined ||
    language === undefined ||
    isbn === undefined ||
    !authors ||
    !identifiers
  ) {
    return null;
  }
  return { title, authors, description, publisher, publishedDate, language, identifiers, coverId, isbn };
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value as string[];
}

function asIdentifiers(value: unknown): Array<{ scheme: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const items: Array<{ scheme: string; value: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.scheme !== 'string' || typeof record.value !== 'string') return null;
    items.push({ scheme: record.scheme, value: record.value });
  }
  return items;
}
