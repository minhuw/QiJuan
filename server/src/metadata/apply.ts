import { readFileSync } from 'node:fs';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { writeImmutableBlob } from '../blobs.js';
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
  coverAbsolute,
} from '../edition-fields.js';
import { sniffImage } from '../metadata.js';
import { editions, fileAssets, metadataPreviews, metadataTrajectories, metadataTrajectorySteps, series } from '../schema.js';
import { runMetadataAgent } from './assistant/agent.js';
import { AssistantError, type AssistantTransport } from './assistant/client.js';
import { readAssistantSettings } from './assistant-settings.js';
import { assertNotPrivate, isEditionPrivate } from './privacy.js';
import { appendTrajectoryStep, linkTrajectoryPreview, startTrajectory, type TrajectoryRecorder } from './trajectory.js';
import { describeCoverResult, fetchVerifiedCover, imageDimensions } from './cover-fetch.js';
import { cleanCover, type AssistantCover } from './assistant/submit.js';
import { recordIdentifierSuggestions } from '../suggestions.js';
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

/** A cover image in the preview: the edition's current cover or the staged proposal. */
export interface CoverPreview {
  /** A same-origin image URL: the edition cover or the staged preview cover endpoint. */
  url: string;
  width: number | null;
  height: number | null;
  /** The page the image came from (or the image URL itself). Null for the current cover. */
  sourceUrl: string | null;
  host: string | null;
}

export interface TextFieldPreview {
  field: Exclude<PreviewField, 'cover'>;
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: string | null;
  proposed: string | null;
}

export interface CoverFieldPreview {
  field: 'cover';
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: CoverPreview | null;
  /** Null when no image was actually obtained. */
  proposed: CoverPreview | null;
}

export type FieldPreview = TextFieldPreview | CoverFieldPreview;

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
  identifiers: Array<{ scheme: string; value: string; sourceUrl?: string | null }>;
  series: string | null;
  seriesOrder: number | null;
  coverId: number | null;
  isbn: string | null;
  cover: AssistantCover | null;
}

/** A cover image downloaded for a preview, before it is written as a blob. */
interface ObtainedCover {
  bytes: Buffer;
  mediaType: string;
  width: number | null;
  height: number | null;
  url: string;
  sourceUrl: string | null;
  origin: 'agent' | 'open_library';
}

type PreviewRow = typeof metadataPreviews.$inferSelect;

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
  options: { now?: Date; jobId?: number } = {},
): Promise<MetadataPreview | null> {
  const now = options.now ?? new Date();
  const edition = db.select().from(editions).where(eq(editions.id, editionId)).get();
  if (!edition || edition.trashedAt) return null;
  // Nothing about a private book is read for, or sent to, the assistant.
  assertNotPrivate(edition.metadataPrivate);
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
  const trajectory =
    options.jobId === undefined
      ? null
      : startTrajectory(db, { jobId: options.jobId, editionId: edition.id, model: config.model });
  const result = await runMetadataAgent({
    transport: assistant,
    openLibrary,
    config,
    metadataPrivate: edition.metadataPrivate,
    onStep: trajectory?.onStep,
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
  // A locked cover is never replaced, so nothing is downloaded for it.
  const coverLocked = loadLocks(db, edition.id).has('cover');
  if (coverLocked) trajectory?.note('Cover not fetched: the cover is locked', { cover: { status: 'locked' } });
  const obtained = coverLocked ? null : await obtainPreviewCover(result.proposal, assistant, openLibrary, trajectory);
  const blob = obtained ? writeImmutableBlob(dataDir, obtained.bytes) : null;
  let row: PreviewRow;
  let replaced: string[];
  try {
    ({ row, replaced } = db.transaction((tx) => {
      const query = tx as unknown as AppDatabase;
      // Made private while the agent ran: its result is dropped, never staged for review.
      if (isEditionPrivate(query, edition.id)) throw new AssistantError('metadata_private');
      const old = query
        .select({ coverSha256: metadataPreviews.coverSha256 })
        .from(metadataPreviews)
        .where(eq(metadataPreviews.editionId, edition.id))
        .all();
      query.delete(metadataPreviews).where(eq(metadataPreviews.editionId, edition.id)).run();
      const inserted = query
        .insert(metadataPreviews)
        .values({
          editionId: edition.id,
          proposal: JSON.stringify(result.proposal),
          createdAt: stamp,
          ...(obtained && blob
            ? {
                coverSha256: blob.sha256,
                coverBytes: blob.bytes,
                coverMediaType: obtained.mediaType,
                coverRelativePath: blob.relativePath,
                coverWidth: obtained.width,
                coverHeight: obtained.height,
                coverUrl: obtained.url,
                coverSourceUrl: obtained.sourceUrl,
                coverOrigin: obtained.origin,
              }
            : {}),
        })
        .returning()
        .get();
      if (!inserted) throw new Error('preview insert failed');
      const hashes = old.map((item) => item.coverSha256).filter((hash): hash is string => hash !== null);
      return { row: inserted, replaced: hashes };
    }, { behavior: 'immediate' }));
  } catch (error) {
    if (blob) releaseUnreferenced(db, dataDir, [blob.sha256]);
    throw error;
  }
  // A replaced preview's staged cover goes with it, unless a cover or another preview shares it.
  releaseUnreferenced(db, dataDir, replaced);
  if (trajectory) linkTrajectoryPreview(db, trajectory.id, row.id);
  // A coverless book takes the verified cover at once; every other field waits for review.
  autoApplyPreviewCover(db, dataDir, row.id, { trajectory, now });
  return {
    previewId: row.id,
    fields: buildFieldPreviews(db, dataDir, edition.id, result.proposal, row),
    source: 'assistant',
    model: result.model,
  };
}

/**
 * The agent's verified cover first; otherwise Open Library, but only when it returns an image.
 * Each outcome is noted in the trajectory. Never throws.
 */
async function obtainPreviewCover(
  proposal: StoredProposal,
  assistant: AssistantTransport,
  openLibrary: OpenLibraryTransport,
  trajectory: TrajectoryRecorder | null,
): Promise<ObtainedCover | null> {
  const agent = await fetchAgentCover(proposal.cover, assistant, trajectory);
  if (agent) return agent;
  return fetchFallbackCover(openLibrary, proposal, trajectory);
}

/** Downloads and verifies the agent's cover, noting the outcome. Shared with uploads. */
export async function fetchAgentCover(
  cover: AssistantCover | null,
  assistant: AssistantTransport,
  trajectory: TrajectoryRecorder | null,
): Promise<ObtainedCover | null> {
  if (!cover) return null;
  const result = await fetchVerifiedCover(cover, assistant.web ?? {});
  const message = describeCoverResult(result);
  if (result.ok) {
    const { width, height, mediaType, host, url } = result.cover;
    trajectory?.note(message, { cover: { status: 'verified', width, height, mediaType, host, url, sourceUrl: cover.sourceUrl } });
    return {
      bytes: result.cover.bytes,
      mediaType,
      width,
      height,
      url,
      sourceUrl: cover.sourceUrl,
      origin: 'agent',
    };
  }
  trajectory?.note(message, {
    cover: { status: 'rejected', reason: result.reason, detail: result.detail, host: result.host, url: cover.url },
  });
  return null;
}

/** Open Library's cover for the proposal's cover id or ISBN, when it actually has one. */
export async function fetchFallbackCover(
  openLibrary: OpenLibraryTransport,
  proposal: { coverId: number | null; isbn: string | null },
  trajectory: TrajectoryRecorder | null,
): Promise<ObtainedCover | null> {
  if (!proposal.coverId && !proposal.isbn) return null;
  let found: Awaited<ReturnType<typeof fetchOpenLibraryCover>> = null;
  try {
    found = await fetchOpenLibraryCover(openLibrary, { coverId: proposal.coverId, isbn: proposal.isbn });
  } catch {
    trajectory?.note('Open Library cover request failed', { cover: { status: 'error', host: 'covers.openlibrary.org' } });
    return null;
  }
  if (!found) {
    trajectory?.note('No cover from Open Library', { cover: { status: 'none', host: 'covers.openlibrary.org' } });
    return null;
  }
  const info = imageDimensions(found.bytes);
  const host = hostOf(found.url);
  const size = info ? `${info.width}×${info.height} ` : '';
  trajectory?.note(`Cover from Open Library ${size}${found.mediaType}`.trim(), {
    cover: { status: 'open_library', width: info?.width ?? null, height: info?.height ?? null, mediaType: found.mediaType, host, url: found.url },
  });
  return {
    bytes: found.bytes,
    mediaType: found.mediaType,
    width: info?.width ?? null,
    height: info?.height ?? null,
    url: found.url,
    sourceUrl: null,
    origin: 'open_library',
  };
}

/**
 * Writes only confirmed, unlocked fields from the stored preview.
 * A locked field stays as the user left it, even if it is confirmed.
 */
export async function applyMetadataPreview(
  db: AppDatabase,
  dataDir: string,
  input: { editionId: number; previewId: number; confirm: PreviewField[] },
  now = new Date(),
): Promise<void> {
  const preview = db.select().from(metadataPreviews).where(eq(metadataPreviews.id, input.previewId)).get();
  if (!preview || preview.editionId !== input.editionId) throw new CatalogError('not_found');
  const proposal = parseProposal(preview.proposal);
  if (!proposal) throw new CatalogError('not_found');
  const confirm = new Set(input.confirm);
  const locks = loadLocks(db, input.editionId);
  // Only the staged bytes the admin saw in the preview are ever applied; nothing is fetched now.
  const cover = confirm.has('cover') && !locks.has('cover') ? readStagedCover(dataDir, preview) : null;
  const stamp = now.toISOString();
  const retired = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = query.select().from(editions).where(eq(editions.id, input.editionId)).get();
    if (!edition || edition.trashedAt) throw new CatalogError('not_found');
    // Agent results are never applied to a private book, even from a preview made before it was private.
    if (edition.metadataPrivate) throw new AssistantError('metadata_private');
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
      replaceIdentifiers(query, edition.id, proposal.identifiers, 'loose', { source: 'agent', now: stamp });
      recordIdentifierSuggestions(query, edition.id, stamp);
      toLock.push('identifiers');
      changed = true;
    }
    const hashes: string[] = [];
    // A cover written automatically when the preview was created is the same image; saveCoverRow keeps it as is.
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
    // The staged cover has served its purpose; release it unless it became the cover.
    query
      .update(metadataPreviews)
      .set({ ...(preview.coverSha256 ? EMPTY_STAGED_COVER : {}), appliedAt: stamp })
      .where(eq(metadataPreviews.id, preview.id))
      .run();
    if (preview.coverSha256) hashes.push(preview.coverSha256);
    return hashes;
  }, { behavior: 'immediate' });
  releaseUnreferenced(db, dataDir, retired);
}

/**
 * Writes a preview's staged cover as the edition's cover, only when the edition has no cover
 * and its cover field is unlocked. A staged cover is always verified: the agent's image passed
 * cover-fetch verification, or Open Library actually returned one. Nothing is locked, no text
 * field is touched, and the preview stays pending; its cover row then reads 'unchanged'.
 * Returns whether the cover was written. Safe to repeat.
 */
export function autoApplyPreviewCover(
  db: AppDatabase,
  dataDir: string,
  previewId: number,
  options: { trajectory?: TrajectoryRecorder | null; now?: Date } = {},
): boolean {
  const preview = db.select().from(metadataPreviews).where(eq(metadataPreviews.id, previewId)).get();
  if (!preview || preview.appliedAt || !preview.coverSha256 || !preview.coverOrigin) return false;
  const staged = readStagedCover(dataDir, preview);
  if (!staged) return false;
  const stamp = (options.now ?? new Date()).toISOString();
  const retired = db.transaction((tx) => {
    const query = tx as unknown as AppDatabase;
    const edition = query.select().from(editions).where(eq(editions.id, preview.editionId)).get();
    if (!edition || edition.trashedAt || edition.metadataPrivate) return null;
    if (loadLocks(query, edition.id).has('cover') || latestCover(query, edition.id)) return null;
    const hashes = saveCoverRow(
      query,
      { dataDir, editionId: edition.id, bytes: staged.bytes, mediaType: staged.mediaType },
      stamp,
    );
    query.update(editions).set({ updatedAt: stamp }).where(eq(editions.id, edition.id)).run();
    return hashes;
  }, { behavior: 'immediate' });
  if (!retired) return false;
  releaseUnreferenced(db, dataDir, retired);
  const data = {
    cover: {
      status: 'auto_applied',
      width: preview.coverWidth,
      height: preview.coverHeight,
      host: hostOf(preview.coverSourceUrl ?? preview.coverUrl ?? ''),
    },
  };
  if (options.trajectory) options.trajectory.note('cover_auto_applied', data);
  else noteLinkedTrajectory(db, preview.id, 'cover_auto_applied', data);
  return true;
}

/** Appends a note to the trajectory that produced a preview, if it is still kept. Best effort. */
function noteLinkedTrajectory(db: AppDatabase, previewId: number, message: string, data: Record<string, unknown>): void {
  try {
    const trajectory = db
      .select({ id: metadataTrajectories.id })
      .from(metadataTrajectories)
      .where(eq(metadataTrajectories.previewId, previewId))
      .orderBy(desc(metadataTrajectories.id))
      .get();
    if (!trajectory) return;
    const last = db
      .select({ seq: sql<number>`max(${metadataTrajectorySteps.seq})` })
      .from(metadataTrajectorySteps)
      .where(eq(metadataTrajectorySteps.trajectoryId, trajectory.id))
      .get();
    const seq = Number(last?.seq ?? 0) + 1;
    appendTrajectoryStep(db, trajectory.id, {
      ...data,
      kind: 'note',
      message,
      seq,
      at: new Date().toISOString(),
    } as unknown as Parameters<typeof appendTrajectoryStep>[2]);
  } catch {
    // A note is informational.
  }
}

/**
 * Gives coverless editions the verified cover their pending preview staged. Runs once at start
 * for previews created before covers were applied automatically; repeating it changes nothing.
 */
export function backfillPreviewCovers(db: AppDatabase, dataDir: string, now = new Date()): number[] {
  const rows = db
    .select({ id: metadataPreviews.id, editionId: metadataPreviews.editionId })
    .from(metadataPreviews)
    .where(and(isNull(metadataPreviews.appliedAt), sql`${metadataPreviews.coverSha256} IS NOT NULL`))
    .orderBy(asc(metadataPreviews.id))
    .all();
  const applied: number[] = [];
  for (const row of rows) {
    if (autoApplyPreviewCover(db, dataDir, row.id, { now })) applied.push(row.editionId);
  }
  return applied;
}

/** A lookup preview still waiting for an admin, as shown on the book page. */
export interface PendingLookup {
  previewId: number;
  createdAt: string;
  changedFields: PreviewField[];
}

/**
 * The edition's latest preview that is neither applied nor dismissed and still proposes at least
 * one change. Previews do not expire: each lookup replaces the edition's previous preview,
 * dismissing deletes it, and applying marks it.
 */
export function pendingLookup(db: AppDatabase, editionId: number): PendingLookup | null {
  const preview = db
    .select()
    .from(metadataPreviews)
    .where(and(eq(metadataPreviews.editionId, editionId), isNull(metadataPreviews.appliedAt)))
    .orderBy(desc(metadataPreviews.id))
    .get();
  if (!preview) return null;
  const proposal = parseProposal(preview.proposal);
  if (!proposal) return null;
  const changedFields = buildFieldPreviews(db, null, editionId, proposal, preview)
    .filter((field) => field.status === 'change')
    .map((field) => field.field);
  if (changedFields.length === 0) return null;
  return { previewId: preview.id, createdAt: preview.createdAt, changedFields };
}

/** A stored, unapplied preview rebuilt against the edition as it is now, for review. */
export function loadMetadataPreview(db: AppDatabase, dataDir: string, editionId: number, previewId: number): MetadataPreview | null {
  const preview = db.select().from(metadataPreviews).where(eq(metadataPreviews.id, previewId)).get();
  if (!preview || preview.editionId !== editionId || preview.appliedAt) return null;
  const proposal = parseProposal(preview.proposal);
  if (!proposal) return null;
  const trajectory = db
    .select({ model: metadataTrajectories.model })
    .from(metadataTrajectories)
    .where(eq(metadataTrajectories.previewId, preview.id))
    .orderBy(desc(metadataTrajectories.id))
    .get();
  return {
    previewId: preview.id,
    fields: buildFieldPreviews(db, dataDir, editionId, proposal, preview),
    source: 'assistant',
    model: trajectory?.model ?? '',
  };
}

/** Discards a preview and its staged cover, unless a cover or another preview shares the image. */
export function dismissMetadataPreview(db: AppDatabase, dataDir: string, editionId: number, previewId: number): void {
  const preview = db.select().from(metadataPreviews).where(eq(metadataPreviews.id, previewId)).get();
  if (!preview || preview.editionId !== editionId) throw new CatalogError('not_found');
  db.delete(metadataPreviews).where(eq(metadataPreviews.id, preview.id)).run();
  if (preview.coverSha256) releaseUnreferenced(db, dataDir, [preview.coverSha256]);
}

const EMPTY_STAGED_COVER = {
  coverSha256: null,
  coverBytes: null,
  coverMediaType: null,
  coverRelativePath: null,
  coverWidth: null,
  coverHeight: null,
  coverUrl: null,
  coverSourceUrl: null,
  coverOrigin: null,
} as const;

/** The staged preview cover's bytes, if the blob is still there and still the stored type. */
export function readStagedCover(
  dataDir: string,
  preview: Pick<PreviewRow, 'coverSha256' | 'coverRelativePath' | 'coverMediaType'>,
): { bytes: Buffer; mediaType: string } | null {
  if (!preview.coverSha256 || !preview.coverRelativePath || !preview.coverMediaType) return null;
  const absolute = coverAbsolute(dataDir, { sha256: preview.coverSha256, relativePath: preview.coverRelativePath });
  if (!absolute) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return null;
  }
  return sniffImage(bytes) === preview.coverMediaType ? { bytes, mediaType: preview.coverMediaType } : null;
}

/** The staged cover image endpoint for one preview. */
export function previewCoverPath(editionId: number, previewId: number): string {
  return `/api/editions/${editionId}/metadata/previews/${previewId}/cover`;
}

/** `dataDir` null skips reading the current cover's dimensions. */
export function buildFieldPreviews(
  db: AppDatabase,
  dataDir: string | null,
  editionId: number,
  proposal: StoredProposal,
  preview: PreviewRow | null,
): FieldPreview[] {
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
  const current: Record<Exclude<PreviewField, 'cover'>, string | null> = {
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
  };
  const proposed: Record<Exclude<PreviewField, 'cover'>, string | null> = {
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
  };
  return PREVIEW_FIELDS.map((field): FieldPreview => {
    const locked = locks.has(FIELD_LOCK[field]);
    if (field === 'cover') {
      const currentCover = cover ? currentCoverPreview(dataDir, edition.id, cover) : null;
      const proposedCover = preview ? stagedCoverPreview(preview) : null;
      let status: FieldPreview['status'] = 'unchanged';
      if (locked) status = 'kept';
      else if (proposedCover && cover?.sha256 !== preview?.coverSha256) status = 'change';
      return { field, locked, status, current: currentCover, proposed: proposedCover };
    }
    return {
      field,
      locked,
      status: fieldStatus(locked, current[field], proposed[field]),
      current: current[field],
      proposed: proposed[field],
    };
  });
}

function currentCoverPreview(
  dataDir: string | null,
  editionId: number,
  cover: { sha256: string; relativePath: string },
): CoverPreview {
  let size: { width: number; height: number } | null = null;
  const absolute = dataDir === null ? null : coverAbsolute(dataDir, cover);
  if (absolute) {
    try {
      size = imageDimensions(readFileSync(absolute));
    } catch {
      size = null;
    }
  }
  return {
    url: `/api/editions/${editionId}/cover?v=${cover.sha256.slice(0, 12)}`,
    width: size?.width ?? null,
    height: size?.height ?? null,
    sourceUrl: null,
    host: null,
  };
}

/** Null unless the preview actually holds a staged image. */
function stagedCoverPreview(preview: PreviewRow): CoverPreview | null {
  if (!preview.coverSha256 || !preview.coverUrl) return null;
  const sourceUrl = preview.coverSourceUrl ?? preview.coverUrl;
  return {
    url: previewCoverPath(preview.editionId, preview.id),
    width: preview.coverWidth,
    height: preview.coverHeight,
    sourceUrl,
    host: hostOf(sourceUrl),
  };
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
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

function fieldStatus(locked: boolean, current: string | null, proposed: string | null): FieldPreview['status'] {
  if (locked) return 'kept';
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
  const cover = cleanCover(record.cover);
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
    cover,
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

function asIdentifiers(value: unknown): Array<{ scheme: string; value: string; sourceUrl?: string | null }> | null {
  if (!Array.isArray(value)) return null;
  const items: Array<{ scheme: string; value: string; sourceUrl?: string | null }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.scheme !== 'string' || typeof record.value !== 'string') return null;
    const sourceUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl : null;
    items.push({ scheme: record.scheme, value: record.value, sourceUrl });
  }
  return items;
}
