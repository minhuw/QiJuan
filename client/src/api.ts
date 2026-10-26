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

  const payload = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) {
    return { status: response.status, data: null, error: payload?.error ?? 'internal' };
  }
  return { status: response.status, data: payload as T | null, error: null };
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
