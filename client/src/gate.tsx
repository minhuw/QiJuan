import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { api, type Account, type LibraryInfo, type ListedUser, type Me, type SetupResponse } from './api';
import { BackupScreen } from './backup-screen';
import { BookDetail, ReaderPage } from './book-detail';
import { CatalogHome } from './catalog-home';
import { ImportScreen } from './import-screen';
import { LibraryBrowser } from './library';
import { useLocale } from './shell';

const ERROR_CODES = new Set([
  'invalid_request',
  'setup_complete',
  'invalid_credentials',
  'unauthorized',
  'forbidden',
  'username_taken',
  'not_found',
  'password_short',
  'required',
  'network',
  'internal',
]);

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready'; user: Account; libraries: LibraryInfo[] };

function pathId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

async function loadPhase(): Promise<Phase> {
  const setup = await api<{ needed: boolean }>('/api/setup');
  if (setup.error || !setup.data) return { kind: 'error', code: setup.error ?? 'network' };
  if (setup.data.needed) return { kind: 'setup' };
  const me = await api<Me>('/api/me');
  if (me.status === 401) return { kind: 'login' };
  if (me.error || !me.data) return { kind: 'error', code: me.error ?? 'network' };
  return { kind: 'ready', user: me.data.user, libraries: me.data.libraries };
}

export function Gate() {
  const { t } = useLocale();
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    void loadPhase().then((next) => {
      if (active) setPhase(next);
    });
    return () => {
      active = false;
    };
  }, [generation]);

  async function signOut() {
    const result = await api('/api/session/logout', { method: 'POST' });
    if (result.error && result.status !== 401) {
      setPhase({ kind: 'error', code: result.error });
      return;
    }
    setPhase({ kind: 'login' });
  }

  if (phase.kind === 'loading') {
    return <p role="status">{t('status.loading')}</p>;
  }

  if (phase.kind === 'error') {
    return (
      <>
        <p className="alert" role="alert">
          {errorText(t, phase.code)}
        </p>
        <button
          type="button"
          className="button"
          onClick={() => {
            setPhase({ kind: 'loading' });
            setGeneration((value) => value + 1);
          }}
        >
          {t('status.retry')}
        </button>
      </>
    );
  }

  if (phase.kind === 'setup') {
    return (
      <SetupForm
        onDone={(user, library) => setPhase({ kind: 'ready', user, libraries: [library] })}
      />
    );
  }

  if (phase.kind === 'login') {
    return <LoginForm onDone={(user, libraries) => setPhase({ kind: 'ready', user, libraries })} />;
  }

  if (location.pathname === '/backup') {
    if (phase.user.role !== 'admin') return <Navigate to="/" replace />;
    return <BackupScreen onSignOut={() => void signOut()} />;
  }

  if (location.pathname === '/settings') {
    if (phase.user.role !== 'admin') return <Navigate to="/" replace />;
    return <Settings onSignOut={() => void signOut()} />;
  }

  if (location.pathname === '/import') {
    return <ImportScreen libraries={phase.libraries} onSignOut={() => void signOut()} />;
  }

  const readMatch = location.pathname.match(/^\/books\/([1-9]\d*)\/read\/([1-9]\d*)$/);
  if (readMatch) {
    const editionId = pathId(readMatch[1] ?? '');
    const assetId = pathId(readMatch[2] ?? '');
    if (editionId && assetId) {
      return <ReaderPage editionId={editionId} assetId={assetId} onSignOut={() => void signOut()} />;
    }
  }
  const bookMatch = location.pathname.match(/^\/books\/([1-9]\d*)$/);
  if (bookMatch) {
    const editionId = pathId(bookMatch[1] ?? '');
    if (editionId) {
      return (
        <BookDetail editionId={editionId} role={phase.user.role} onSignOut={() => void signOut()} />
      );
    }
  }

  return (
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('home.title')}</h1>
      <p className="section-label">{t('home.libraries')}</p>
      {phase.libraries.length === 0 ? (
        <p className="placeholder">{t('home.noAccess')}</p>
      ) : (
        <ul className="plain-list">
          {phase.libraries.map((library) => (
            <li key={library.id}>{library.name}</li>
          ))}
        </ul>
      )}
      <LibraryBrowser />
      <CatalogHome />
      <div className="toolbar">
        <p className="signed-in">
          {t('account.signedIn')} <strong>{phase.user.username}</strong>
          {' · '}
          {t(`account.${phase.user.role}`)}
        </p>
        <Link className="text-link" to="/import">
          {t('import.open')}
        </Link>
        {phase.user.role === 'admin' ? (
          <Link className="text-link" to="/settings">
            {t('settings.open')}
          </Link>
        ) : null}
        {phase.user.role === 'admin' ? (
          <Link className="text-link" to="/backup">
            {t('backup.open')}
          </Link>
        ) : null}
        <button type="button" className="button button-secondary" onClick={() => void signOut()}>
          {t('account.signOut')}
        </button>
      </div>
    </>
  );
}

function SetupForm({ onDone }: { onDone: (user: Account, library: LibraryInfo) => void }) {
  const { t } = useLocale();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [libraryName, setLibraryName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields = validateFields([
      [username.trim(), true],
      [password, false],
      [libraryName.trim(), true],
    ]);
    if (typeof fields === 'string') {
      setError(fields);
      return;
    }
    setPending(true);
    setError(null);
    const result = await api<SetupResponse>('/api/setup', {
      method: 'POST',
      body: { username: username.trim(), password, libraryName: libraryName.trim() },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'internal');
      return;
    }
    onDone(result.data.user, result.data.library);
  }

  return (
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('setup.title')}</h1>
      <form className="form" noValidate onSubmit={(event) => void submit(event)}>
        {error ? (
          <p className="alert" role="alert">
            {errorText(t, error)}
          </p>
        ) : null}
        <TextField label={t('setup.username')} type="text" value={username} autoComplete="username" onChange={setUsername} />
        <TextField
          label={t('setup.password')}
          type="password"
          value={password}
          autoComplete="new-password"
          hint={t('account.passwordHint')}
          onChange={setPassword}
        />
        <TextField
          label={t('setup.libraryName')}
          type="text"
          value={libraryName}
          autoComplete="off"
          onChange={setLibraryName}
        />
        <button className="button" type="submit" disabled={pending}>
          {t('setup.submit')}
        </button>
      </form>
    </>
  );
}

function LoginForm({ onDone }: { onDone: (user: Account, libraries: LibraryInfo[]) => void }) {
  const { t } = useLocale();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (username.trim() === '' || password === '') {
      setError('required');
      return;
    }
    setPending(true);
    setError(null);
    const result = await api<Me>('/api/session/login', {
      method: 'POST',
      body: { username: username.trim(), password },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'internal');
      return;
    }
    onDone(result.data.user, result.data.libraries);
  }

  return (
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('login.title')}</h1>
      <form className="form" noValidate onSubmit={(event) => void submit(event)}>
        {error ? (
          <p className="alert" role="alert">
            {errorText(t, error)}
          </p>
        ) : null}
        <TextField label={t('login.username')} type="text" value={username} autoComplete="username" onChange={setUsername} />
        <TextField
          label={t('login.password')}
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={setPassword}
        />
        <button className="button" type="submit" disabled={pending}>
          {t('login.submit')}
        </button>
      </form>
    </>
  );
}

function Settings({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useLocale();
  const [users, setUsers] = useState<ListedUser[] | null>(null);
  const [libraries, setLibraries] = useState<LibraryInfo[] | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reload() {
    const [userResult, libraryResult] = await Promise.all([
      api<{ users: ListedUser[] }>('/api/users'),
      api<{ libraries: LibraryInfo[] }>('/api/libraries'),
    ]);
    if (userResult.error || !userResult.data) {
      setError(userResult.error ?? 'internal');
      return;
    }
    if (libraryResult.error || !libraryResult.data) {
      setError(libraryResult.error ?? 'internal');
      return;
    }
    setUsers(userResult.data.users);
    setLibraries(libraryResult.data.libraries);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const [userResult, libraryResult] = await Promise.all([
        api<{ users: ListedUser[] }>('/api/users'),
        api<{ libraries: LibraryInfo[] }>('/api/libraries'),
      ]);
      if (!active) return;
      if (userResult.error || !userResult.data || libraryResult.error || !libraryResult.data) {
        setError(userResult.error ?? libraryResult.error ?? 'internal');
        return;
      }
      setUsers(userResult.data.users);
      setLibraries(libraryResult.data.libraries);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    const fields = validateFields([
      [username.trim(), true],
      [password, false],
    ]);
    if (typeof fields === 'string') {
      setError(fields);
      return;
    }
    setPending(true);
    setError(null);
    const result = await api('/api/users', {
      method: 'POST',
      body: { username: username.trim(), password },
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setUsername('');
    setPassword('');
    await reload();
  }

  async function toggle(userId: number, libraryId: number, granted: boolean) {
    setError(null);
    const result = granted
      ? await api(`/api/libraries/${libraryId}/grants/${userId}`, { method: 'DELETE' })
      : await api(`/api/libraries/${libraryId}/grants`, { method: 'POST', body: { userId } });
    if (result.error) {
      setError(result.error);
      return;
    }
    await reload();
  }

  const readers = (users ?? []).filter((user) => user.role === 'reader');

  return (
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('settings.title')}</h1>
      <div className="toolbar">
        <Link className="text-link" to="/">
          {t('settings.back')}
        </Link>
        <Link className="text-link" to="/backup">
          {t('backup.open')}
        </Link>
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          {t('account.signOut')}
        </button>
      </div>
      <form className="form" noValidate onSubmit={(event) => void create(event)}>
        {error ? (
          <p className="alert" role="alert">
            {errorText(t, error)}
          </p>
        ) : null}
        <TextField
          label={t('settings.username')}
          type="text"
          value={username}
          autoComplete="off"
          onChange={setUsername}
        />
        <TextField
          label={t('settings.password')}
          type="password"
          value={password}
          autoComplete="new-password"
          hint={t('account.passwordHint')}
          onChange={setPassword}
        />
        <button className="button" type="submit" disabled={pending}>
          {t('settings.create')}
        </button>
      </form>
      {users === null ? (
        <p role="status">{t('status.loading')}</p>
      ) : readers.length === 0 ? (
        <p className="placeholder">{t('settings.empty')}</p>
      ) : (
        <ul className="reader-list">
          {readers.map((reader) => (
            <li key={reader.id} className="reader-row">
              <h2>{reader.username}</h2>
              <p className="hint">{t('account.reader')}</p>
              <ul className="plain-list">
                {(libraries ?? []).map((library) => {
                  const granted = reader.libraryIds.includes(library.id);
                  const action = granted ? t('settings.revoke') : t('settings.grant');
                  return (
                    <li key={library.id} className="grant-row">
                      <span>{library.name}</span>
                      <button
                        type="button"
                        className="button button-secondary"
                        aria-label={`${action} ${library.name} ${reader.username}`}
                        onClick={() => void toggle(reader.id, library.id, granted)}
                      >
                        {action}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TextField({
  label,
  type,
  value,
  autoComplete,
  hint,
  onChange,
}: {
  label: string;
  type: 'text' | 'password';
  value: string;
  autoComplete: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  const inputId = useId();
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type={type}
        value={value}
        name={type === 'password' ? 'password' : label}
        autoComplete={autoComplete}
        autoCapitalize={type === 'text' ? 'none' : undefined}
        spellCheck={false}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function validateFields(fields: Array<[string, boolean]>): true | string {
  for (const [value, trimEmpty] of fields) {
    if (trimEmpty ? value.trim() === '' : value === '') return 'required';
  }
  for (const [value, trimEmpty] of fields) {
    if (!trimEmpty && value.length < 8) return 'password_short';
  }
  return true;
}
