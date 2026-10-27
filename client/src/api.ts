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
}

export interface ImportItem {
  id: number;
  position: number;
  filename: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'duplicate';
  error: string | null;
  editionId: number | null;
  assetId: number | null;
  sha256: string | null;
}

export interface ImportSummary {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  duplicate: number;
}

export interface ImportJob {
  id: number;
  libraryId: number;
  source: 'upload' | 'folder';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: ImportSummary;
  items: ImportItem[];
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { status: 0, data: null, error: 'network' };
  }

  if (response.status === 204) return { status: 204, data: null, error: null };

  const payload = (await response.json().catch(() => null)) as ({ error?: string; reason?: string } & T) | null;
  if (!response.ok) {
    return {
      status: response.status,
      data: null,
      error: payload?.error ?? 'internal',
      reason: typeof payload?.reason === 'string' ? payload.reason : null,
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
}

export interface LibraryShelf {
  id: number;
  name: string;
  count: number;
}

export interface HomePayload {
  continueReading: Array<LibraryEdition & { updatedAt: string }>;
  recent: LibraryEdition[];
  shelves: LibraryShelf[];
}

export interface LibraryPage {
  editions: LibraryEdition[];
  total: number;
  limit: number;
  offset: number;
  languages: string[];
  shelves: LibraryShelf[];
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
  bytes: number;
  availability: 'present' | 'missing';
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
  identifiers: Array<{ scheme: string; value: string }>;
  locks: string[];
  cover: { mediaType: string } | null;
  assets: EditionAsset[];
  suggestions: Array<{ id: number; otherEditionId: number; otherTitle: string }>;
  reading?: ReadingState;
  neighbors?: {
    previous: SeriesNeighbor | null;
    next: SeriesNeighbor | null;
    series: SeriesNeighbor[];
  };
}

export interface FieldPreview {
  field: string;
  locked: boolean;
  status: 'kept' | 'change' | 'unchanged';
  current: string | null;
  proposed: string | null;
}

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
