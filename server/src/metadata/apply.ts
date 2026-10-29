import { and, asc, eq, isNull } from 'drizzle-orm';
import { CatalogError, findOrCreateSeries } from '../catalog.js';
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
import { editions, fileAssets, metadataPreviews, series } from '../schema.js';
import { runMetadataAgent } from './assistant/agent.js';
import { AssistantError, type AssistantTransport } from './assistant/client.js';
import { readAssistantSettings } from './assistant-settings.js';
import { type OpenLibraryTransport, fetchOpenLibraryCover } from './openLibrary.js';

export const PREVIEW_FIELDS = [
  'title',
  'authors',
  'translators',
  'description',
  'publisher',
  'publishedDate',
  'language',
  'identifiers',
  'series',
  'seriesOrder',
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

export interface MetadataPreview {
  previewId: number;
  fields: FieldPreview[];
  source: 'assistant';
  model: string;
}

/** Older previews came from a direct Open Library proposal and may lack the newer fields. */
interface StoredProposal {
  title: string | null;
  authors: string[];
  translators: string[];
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  identifiers: Array<{ scheme: string; value: string }>;
  series: string | null;
  seriesOrder: number | null;
  coverId: number | null;
  isbn: string | null;
}

const FIELD_LOCK: Record<PreviewField, LockField> = {
  title: 'title',
  authors: 'authors',
  translators: 'translators',
  description: 'description',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  identifiers: 'identifiers',
  series: 'series',
  seriesOrder: 'series_order',
  cover: 'cover',
};

export async function createMetadataPreview(
  db: AppDatabase,
  dataDir: string,
  assistant: AssistantTransport,
  openLibrary: OpenLibraryTransport,
  editionId: number,
  now = new Date(),
): Promise<MetadataPreview | null> {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) return null;
  const authors = loadNames(db, edition.id, 'author');
  const translators = loadNames(db, edition.id, 'translator');
  const identifiers = loadIdentifiers(db, edition.id);
  const seriesRow =
    edition.seriesId == null
      ? null
      : db.select({ name: series.name }).from(series).where(eq(series.id, edition.seriesId)).get() ?? null;
  const asset = loadPromptAsset(db, edition.id);
  const config = readAssistantSettings(dataDir);
  if (!config) throw new AssistantError('metadata_assistant_unconfigured');
  const result = await runMetadataAgent({
    transport: assistant,
    openLibrary,
    config,
    input: {
      filename: asset?.originalFilename ?? edition.title,
      format: asset?.format ?? 'epub',
      fields: {
        title: edition.title,
        authors,
        translators,
        description: edition.description,
        publisher: edition.publisher,
        publishedDate: edition.publishedDate,
        language: edition.language,
        identifiers,
        series: seriesRow?.name ?? null,
        seriesOrder: edition.seriesOrder,
      },
    },
  });
  const stamp = now.toISOString();
  const previewId = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    query.delete(metadataPreviews).where(eq(metadataPreviews.editionId, edition.id)).run();
    const inserted = query
      .insert(metadataPreviews)
      .values({ editionId: edition.id, proposal: JSON.stringify(result.proposal), createdAt: stamp })
      .returning({ id: metadataPreviews.id })
      .get();
    if (!inserted) throw new Error('preview insert failed');
    return inserted.id;
  }, { behavior: 'immediate' });
  return {
    previewId,
    fields: buildFieldPreviews(db, edition.id, result.proposal),
    source: 'assistant',
    model: result.model,
  };
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
    let seriesId = edition.seriesId;
    let seriesOrder = edition.seriesOrder;
    let seriesChanged = false;
    if (confirm.has('series') && !currentLocks.has('series')) {
      const nextSeriesId = proposal.series
        ? findOrCreateSeries(query, { libraryId: edition.libraryId, name: proposal.series }, now).id
        : null;
      const hadSeries = seriesId != null || seriesOrder != null;
      if (nextSeriesId == null) {
        // Clearing a series also clears its order; neither value may outlive the other.
        seriesId = null;
        seriesOrder = null;
        toLock.push('series');
        if (hadSeries) toLock.push('series_order');
      } else {
        // An order belongs to its series, so a switch drops the old order unless confirmed below.
        if (nextSeriesId !== seriesId) seriesOrder = null;
        seriesId = nextSeriesId;
        toLock.push('series');
      }
      seriesChanged = true;
    }
    if (confirm.has('seriesOrder') && !currentLocks.has('series_order')) {
      if (proposal.seriesOrder == null) {
        seriesOrder = null;
        seriesChanged = true;
        toLock.push('series_order');
      } else if (seriesId != null) {
        seriesOrder = proposal.seriesOrder;
        seriesChanged = true;
        toLock.push('series_order');
      } else if (seriesOrder != null) {
        // A series order requires a series, so drop any stale value without locking the proposal.
        seriesOrder = null;
        seriesChanged = true;
      }
      // A non-null order without a series is not persisted and does not lock the field.
    }
    if (seriesChanged) {
      values.seriesId = seriesId;
      values.seriesOrder = seriesOrder;
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
    if (confirm.has('translators') && !currentLocks.has('translators')) {
      replaceContributors(query, edition.id, 'translator', proposal.translators, stamp, 'loose');
      toLock.push('translators');
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

export function buildFieldPreviews(db: AppDatabase, editionId: number, proposal: StoredProposal): FieldPreview[] {
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition) return [];
  const locks = loadLocks(db, edition.id);
  const authors = loadNames(db, edition.id, 'author').join(', ');
  const translators = loadNames(db, edition.id, 'translator').join(', ');
  const identifiers = loadIdentifiers(db, edition.id)
    .map((item) => `${item.scheme}|${item.value}`)
    .join(', ');
  const seriesRow =
    edition.seriesId == null
      ? null
      : db.select({ name: series.name }).from(series).where(eq(series.id, edition.seriesId)).get() ?? null;
  const cover = latestCover(db, edition.id);
  const current: Record<PreviewField, string | null> = {
    title: edition.title,
    authors: authors || null,
    translators: translators || null,
    description: edition.description,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    language: edition.language,
    identifiers: identifiers || null,
    series: seriesRow?.name ?? null,
    seriesOrder: edition.seriesOrder == null ? null : String(edition.seriesOrder),
    cover: cover ? 'present' : null,
  };
  const proposed: Record<PreviewField, string | null> = {
    title: proposal.title,
    authors: proposal.authors.length > 0 ? proposal.authors.join(', ') : null,
    translators: proposal.translators.length > 0 ? proposal.translators.join(', ') : null,
    description: proposal.description,
    publisher: proposal.publisher,
    publishedDate: proposal.publishedDate,
    language: proposal.language,
    identifiers: proposal.identifiers.length > 0 ? proposal.identifiers.map((item) => `${item.scheme}|${item.value}`).join(', ') : null,
    series: proposal.series,
    seriesOrder: proposal.seriesOrder == null ? null : String(proposal.seriesOrder),
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

function loadPromptAsset(
  db: AppDatabase,
  editionId: number,
): { originalFilename: string; format: 'epub' | 'pdf' } | null {
  const columns = { originalFilename: fileAssets.originalFilename, format: fileAssets.format };
  const present = db
    .select(columns)
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
  if (present) return present;
  // A missing indexed file still has a filename and format worth identifying.
  return (
    db
      .select(columns)
      .from(fileAssets)
      .where(and(eq(fileAssets.editionId, editionId), isNull(fileAssets.trashedAt)))
      .orderBy(asc(fileAssets.id))
      .get() ?? null
  );
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

function parseProposal(text: string): StoredProposal | null {
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
  const translators = record.translators === undefined ? [] : asStringArray(record.translators);
  const identifiers = asIdentifiers(record.identifiers);
  const series = record.series === undefined ? null : asNullableString(record.series);
  const seriesOrder = record.seriesOrder === undefined ? null : asNullableNumber(record.seriesOrder);
  const coverId = typeof record.coverId === 'number' && Number.isInteger(record.coverId) ? record.coverId : null;
  if (
    title === undefined ||
    description === undefined ||
    publisher === undefined ||
    publishedDate === undefined ||
    language === undefined ||
    isbn === undefined ||
    !authors ||
    !translators ||
    !identifiers ||
    series === undefined ||
    seriesOrder === undefined
  ) {
    return null;
  }
  return {
    title,
    authors,
    translators,
    description,
    publisher,
    publishedDate,
    language,
    identifiers,
    series,
    seriesOrder,
    coverId,
    isbn,
  };
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
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
