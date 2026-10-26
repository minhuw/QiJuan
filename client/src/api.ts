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
