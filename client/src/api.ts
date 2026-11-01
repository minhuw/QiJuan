export interface Account {
  id: number;
  username: string;
  role: 'admin' | 'reader';
}

export interface LibraryInfo {
  id: number;
  name: string;
  mode: 'managed' | 'indexed';
}

export interface Me {
  user: Account;
  libraries: LibraryInfo[];
}

export interface ListedUser extends Account {
  libraryIds: number[];
}

export interface SetupResponse {
  user: Account;
  library: LibraryInfo;
}

export interface ApiResult<T> {
  status: number;
  data: T | null;
  error: string | null;
  reason?: string | null;
  /** For invalid_identifier: the position of the rejected identifier in the request. */
  index?: number | null;
}

export interface MetadataAssistantInfo {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  /** The effective web search mode. */
  webSearch: 'deepseek' | 'off';
  /** True when web_search and fetch_page are offered to the agent. */
  webSearchAvailable: boolean;
  searchApiKeyConfigured: boolean;
  searchApiKeyHint: string | null;
  googleBooksApiKeyConfigured: boolean;
  googleBooksApiKeyHint: string | null;
}

export interface ImportItem {
  id: number;
  position: number;
  filename: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'duplicate' | 'needs_confirmation';
  error: string | null;
  editionId: number | null;
  assetId: number | null;
  sha256: string | null;
  /** The edition this file matched by identifier. */
  candidateEditionId: number | null;
  /** Why the match was not merged automatically. */
  conflicts: Array<'title' | 'authors' | 'format' | 'ambiguous'>;
  /** The file joined an existing edition. */
  merged: boolean;
  resolution: 'merge' | 'separate' | null;
  /** Admins only, while the item needs confirmation: what the file brings. */
  incoming?: {
    title: string | null;
    authors: string[];
    format: 'epub' | 'pdf';
    identifier: { scheme: string; value: string };
  };
  /** Admins only: the metadata assistant run for this file. */
  trajectoryId?: number;
  trajectoryStepCount?: number;
}

export interface ImportSummary {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  duplicate: number;
  needs_confirmation: number;
}

export interface ImportJob {
  id: number;
  libraryId: number;
  source: 'upload' | 'folder' | 'lookup' | 'apply' | 'refresh' | 'rescan';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  summary: ImportSummary;
  items: ImportItem[];
  /** Admins only: the metadata assistant run of a lookup job. */
  trajectoryId?: number;
  trajectoryStepCount?: number;
}

export type TrajectoryStepKind = 'input' | 'model' | 'tool_call' | 'tool_result' | 'submit' | 'note' | 'end';

export interface TrajectoryStep {
  seq: number;
  kind: TrajectoryStepKind;
  at: string;
  data: Record<string, unknown>;
}

export interface MetadataTrajectory {
  id: number;
  jobId: number;
  jobItemId: number | null;
  editionId: number | null;
  previewId: number | null;
  model: string | null;
  outcome: 'accepted' | 'failed' | 'timeout' | 'limit' | null;
  error: string | null;
  summary: { turns: number; toolCalls: number; totalMs: number } | null;
  truncated: boolean;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  steps: TrajectoryStep[];
}

export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown; keepalive?: boolean },
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      // Lets a save sent as the page is left outlive it.
      ...(init?.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    return { status: 0, data: null, error: 'network' };
  }

  if (response.status === 204) return { status: 204, data: null, error: null };

  const payload = (await response.json().catch(() => null)) as
    | ({ error?: string; reason?: string; index?: number } & T)
    | null;
  if (!response.ok) {
    return {
      status: response.status,
      data: null,
      error: payload?.error ?? 'internal',
      reason: typeof payload?.reason === 'string' ? payload.reason : null,
      index: typeof payload?.index === 'number' ? payload.index : null,
    };
  }
  return { status: response.status, data: payload as T | null, error: null };
}

export interface EditionSummary {
  id: number;
  libraryId: number;
  title: string;
  language: string | null;
  authors: string[];
  formats: Array<'epub' | 'pdf'>;
}

export type ReadingStatus = 'want' | 'reading' | 'finished' | 'on_hold';

export interface LibraryEdition {
  id: number;
  libraryId: number;
  title: string;
  authors: string[];
  language: string | null;
  formats: Array<'epub' | 'pdf'>;
  hasCover: boolean;
  status: ReadingStatus | null;
  rating: number | null;
  favorite: boolean;
  /** False for an Unidentified edition. Older servers omit it. */
  identified?: boolean;
  /** The file Read opens; null without a live file. */
  readAssetId?: number | null;
  /** This user's shelves that hold the edition. */
  shelfIds?: number[];
}

export interface LibraryShelf {
  id: number;
  name: string;
  count: number;
}

/** A book in progress: the file last read, and how far in (null until a reader reports it). */
export interface ContinueBook extends LibraryEdition {
  updatedAt: string;
  assetId?: number | null;
  /** The cover's band colours, by day and by night; null without a clear hue. */
  coverTint?: { light: string; dark: string } | null;
  progress?: { fraction: number; page: number | null; pageCount: number | null } | null;
}

export interface HomePayload {
  continueReading: Array<ContinueBook>;
  recent: LibraryEdition[];
  shelves: LibraryShelf[];
}

/** A contiguous run of one title initial in catalogue order: 'A'–'Z', '#', or 'cjk'. */
export interface LibraryIndexEntry {
  key: string;
  offset: number;
  count: number;
}

export interface LibraryPage {
  editions: LibraryEdition[];
  total: number;
  limit: number;
  offset: number;
  languages: string[];
  shelves: LibraryShelf[];
  /** Absent from servers that predate the thumb index. */
  index?: LibraryIndexEntry[];
}

export interface ReadingShelf {
  id: number;
  name: string;
  included: boolean;
}

export interface ReadingState {
  status: ReadingStatus | null;
  rating: number | null;
  favorite: boolean;
  queued: boolean;
  shelves: ReadingShelf[];
}

export interface SeriesNeighbor {
  id: number;
  title: string;
  seriesOrder: number | null;
}

export interface EditionAsset {
  id: number;
  format: 'epub' | 'pdf';
  originalFilename: string;
  /** Author - Title (Year).ext, computed by the server from current metadata. */
  displayFilename: string;
  /** PDFs: text recognition, when it was ever requested. */
  ocr?: AssetOcr | null;
  bytes: number;
  availability: 'present' | 'missing';
}

export interface AssetOcr {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** A recognized copy is in use by the reader; can stay true while a new run is queued. */
  ready: boolean;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EditionIdentifier {
  scheme: string;
  value: string;
  /** The identifier's canonical page, when its scheme has one. */
  url?: string | null;
  /** Admins only. */
  source?: 'embedded' | 'agent' | 'manual';
  sourceUrl?: string | null;
  createdAt?: string;
}

export type RatingProvider = 'douban' | 'goodreads' | 'open_library' | 'google_books';

/** One provider's rating, on its own scale (Douban /10, the rest /5). */
export interface ExternalRating {
  provider: RatingProvider;
  url: string | null;
  rating: number | null;
  scale: number;
  count: number | null;
  fetchedAt: string;
  /** Admins only. */
  status?: 'ok' | 'no_rating' | 'not_found' | 'error';
  error?: string | null;
}

export interface EditionDetail {
  id: number;
  libraryId: number;
  title: string;
  sortTitle: string;
  language: string | null;
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  series: { id: number; name: string } | null;
  seriesOrder: number | null;
  alternateTitles: Array<{ title: string; sortTitle: string | null }>;
  authors: string[];
  translators: string[];
  tags: string[];
  identifiers: EditionIdentifier[];
  locks: string[];
  /** Kept private from the metadata assistant: no lookup, and uploads skip the agent. */
  metadataPrivate: boolean;
  cover: { mediaType: string } | null;
  /** The book page's band colours, derived from the cover; absent or null without a clear hue. */
  coverTint?: { light: string; dark: string } | null;
  assets: EditionAsset[];
  suggestions: Array<{
    id: number;
    otherEditionId: number;
    otherTitle: string;
    reasons?: Array<'title_author' | 'identifier'>;
    /** With the identifier reason: the first identifier the two share. */
    identifier?: { scheme: string; value: string };
  }>;
  /** External ratings in provider order. Readers get scores and links only. */
  ratings?: ExternalRating[];
  /** True while the edition waits for a ratings fetch. */
  ratingsPending?: boolean;
  /** Admins only: the latest lookup preview still waiting for review, with the fields it would change. */
  pendingLookup?: PendingLookup | null;
  reading?: ReadingState;
  neighbors?: {
    previous: SeriesNeighbor | null;
    next: SeriesNeighbor | null;
    series: SeriesNeighbor[];
  };
}

export interface PendingLookup {
  previewId: number;
  createdAt: string;
  changedFields: string[];
}

/** A cover in the lookup preview: the edition's current image or the staged proposal. */
export interface CoverPreview {
  url: string;
  width: number | null;
  height: number | null;
  /** The page the proposed image came from. Null for the current cover. */
  sourceUrl: string | null;
  host: string | null;
}

export interface TextFieldPreview {
  field: string;
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
  /** Null when the lookup obtained no image. */
  proposed: CoverPreview | null;
}

export type FieldPreview = TextFieldPreview | CoverFieldPreview;

export interface MetadataPreview {
  previewId: number;
  fields: FieldPreview[];
}

export async function apiForm<T>(path: string, body: FormData): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', body });
  } catch {
    return { status: 0, data: null, error: 'network' };
  }
  const payload = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) {
    return { status: response.status, data: null, error: payload?.error ?? 'internal' };
  }
  return { status: response.status, data: payload as T | null, error: null };
}

/** A file in trash. managed: uploaded into QiJuan; indexed: a folder library's file, never touched on disk. */
export interface TrashFile {
  id: number;
  format: 'epub' | 'pdf';
  storage: 'managed' | 'indexed';
  originalFilename: string;
  displayFilename: string;
  bytes: number;
}

export interface TrashedEdition {
  id: number;
  libraryId: number;
  title: string;
  authors: string[];
  hasCover: boolean;
  trashedAt: string;
  files: TrashFile[];
}

export interface TrashedAsset extends TrashFile {
  editionId: number;
  editionTitle: string;
  trashedAt: string;
}

/** GET /api/trash, admins only. */
export interface TrashListing {
  editions: TrashedEdition[];
  /** Files trashed on their own from books still in the library. */
  assets: TrashedAsset[];
}
