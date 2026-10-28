import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { BookOpen, Lock, ShieldCheck, User, Users } from 'lucide-react';
import { api, type Account, type LibraryInfo, type ListedUser, type Me, type SetupResponse } from './api';
import { BackupScreen } from './backup-screen';
import { BookDetail, ReaderPage } from './book-detail';
import { PageHeader } from './components/ui/page-header';
import { EmptyState, ErrorNotice, LoadingState } from './components/ui/states';
import { ImportScreen } from './import-screen';
import { LibraryBrowser } from './library';
import { useAccountChrome, useLocale } from './shell';

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

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const { setAccount } = useAccountChrome();
  const signedInName = phase.kind === 'ready' ? phase.user.username : null;
  const signedInRole = phase.kind === 'ready' ? phase.user.role : null;
  useEffect(() => {
    if (phase.kind === 'loading') return;
    if (!signedInName || !signedInRole) {
      setAccount(null);
      return;
    }
    setAccount({
      username: signedInName,
      role: signedInRole,
      onSignOut: () => {
        void signOutRef.current();
      },
    });
  }, [phase.kind, signedInName, signedInRole, setAccount]);

  if (phase.kind === 'loading') {
    return <LoadingState />;
  }

  if (phase.kind === 'error') {
    return (
      <div className="state-page">
        <ErrorNotice
          message={errorText(t, phase.code)}
          onRetry={() => {
            setPhase({ kind: 'loading' });
            setGeneration((value) => value + 1);
          }}
        />
      </div>
    );
  }

  if (phase.kind === 'setup') {
    return <SetupForm onDone={(user, library) => setPhase({ kind: 'ready', user, libraries: [library] })} />;
  }

  if (phase.kind === 'login') {
    return <LoginForm onDone={(user, libraries) => setPhase({ kind: 'ready', user, libraries })} />;
  }

  if (location.pathname === '/backup') {
    if (phase.user.role !== 'admin') return <Navigate to="/" replace />;
    return <BackupScreen />;
  }

  if (location.pathname === '/settings') {
    if (phase.user.role !== 'admin') return <Navigate to="/" replace />;
    return <Settings />;
  }

  if (location.pathname === '/import') {
    return <ImportScreen libraries={phase.libraries} />;
  }

  const readMatch = location.pathname.match(/^\/books\/([1-9]\d*)\/read\/([1-9]\d*)$/);
  if (readMatch) {
    const editionId = pathId(readMatch[1] ?? '');
    const assetId = pathId(readMatch[2] ?? '');
    if (editionId && assetId) {
      return <ReaderPage editionId={editionId} assetId={assetId} />;
    }
  }
  const bookMatch = location.pathname.match(/^\/books\/([1-9]\d*)$/);
  if (bookMatch) {
    const editionId = pathId(bookMatch[1] ?? '');
    if (editionId) {
      return <BookDetail editionId={editionId} role={phase.user.role} />;
    }
  }

  return <LibraryBrowser libraries={phase.libraries} />;
}

function AuthLayout({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="auth-layout">
      <section className="auth-story" aria-label="QiJuan">
        <div className="auth-story-inner">
          <span className="auth-seal" lang="zh-Hans" aria-hidden="true">
            栖卷
          </span>
          <p className="auth-quote" lang="zh-Hans">
            书有归处，
            <br />
            人有闲读。
          </p>
          <div className="auth-spines" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <p className="auth-story-foot">{t('auth.media')}</p>
        </div>
      </section>
      <section className="auth-panel-wrap">
        <div className="auth-panel">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {description ? <p className="auth-lede">{description}</p> : null}
          {children}
        </div>
      </section>
    </div>
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
    <AuthLayout eyebrow={t('setup.eyebrow')} title={t('setup.title')} description={t('setup.description')}>
      <form className="form" noValidate onSubmit={(event) => void submit(event)}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {errorText(t, error)}
          </div>
        ) : null}
        <TextField
          label={t('setup.username')}
          type="text"
          value={username}
          autoComplete="username"
          icon={<User size={16} />}
          onChange={setUsername}
        />
        <TextField
          label={t('setup.password')}
          type="password"
          value={password}
          autoComplete="new-password"
          hint={t('account.passwordHint')}
          icon={<Lock size={16} />}
          onChange={setPassword}
        />
        <TextField
          label={t('setup.libraryName')}
          type="text"
          value={libraryName}
          autoComplete="off"
          icon={<BookOpen size={16} />}
          onChange={setLibraryName}
        />
        <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
          {t('setup.submit')}
        </button>
      </form>
    </AuthLayout>
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
    <AuthLayout eyebrow={t('brand.tagline')} title={t('login.title')} description={t('login.description')}>
      <form className="form" noValidate onSubmit={(event) => void submit(event)}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {errorText(t, error)}
          </div>
        ) : null}
        <TextField
          label={t('login.username')}
          type="text"
          value={username}
          autoComplete="username"
          icon={<User size={16} />}
          onChange={setUsername}
        />
        <TextField
          label={t('login.password')}
          type="password"
          value={password}
          autoComplete="current-password"
          icon={<Lock size={16} />}
          onChange={setPassword}
        />
        <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
          {t('login.submit')}
        </button>
      </form>
      <p className="auth-foot">
        <ShieldCheck size={14} aria-hidden="true" />
        {t('login.foot')}
      </p>
    </AuthLayout>
  );
}

function Settings() {
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
    <div className="settings-page">
      <PageHeader
        eyebrow={
          <span className="eyebrow">
            <Users size={13} aria-hidden="true" />
            {t('settings.eyebrow')}
          </span>
        }
        title={t('settings.title')}
        description={t('settings.subtitle')}
      />

      {error ? (
        <ErrorNotice message={errorText(t, error)} onRetry={() => void reload()} />
      ) : null}

      <div className="settings-grid">
        <section className="panel create-reader-panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">{t('settings.accounts')}</p>
              <h2>{t('settings.newReader')}</h2>
            </div>
          </div>
          <p className="panel-lede">{t('settings.readerHint')}</p>
          <form className="form" noValidate onSubmit={(event) => void create(event)}>
            <TextField
              label={t('settings.username')}
              type="text"
              value={username}
              autoComplete="off"
              icon={<User size={16} />}
              onChange={setUsername}
            />
            <TextField
              label={t('settings.password')}
              type="password"
              value={password}
              autoComplete="new-password"
              hint={t('account.passwordHint')}
              icon={<Lock size={16} />}
              onChange={setPassword}
            />
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {t('settings.create')}
            </button>
          </form>
        </section>

        <section className="panel readers-panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">{t('settings.access')}</p>
              <h2>{t('settings.allReaders')}</h2>
            </div>
            {users ? <span className="section-count">{readers.length}</span> : null}
          </div>
          {users === null ? (
            <LoadingState />
          ) : readers.length === 0 ? (
            <EmptyState icon={<Users size={22} />} title={t('settings.empty')} />
          ) : (
            <ul className="reader-list">
              {readers.map((reader) => (
                <li key={reader.id} className="reader-row">
                  <div className="reader-head">
                    <span className="avatar avatar-light" aria-hidden="true">
                      {reader.username.charAt(0).toLocaleUpperCase()}
                    </span>
                    <div>
                      <h2>{reader.username}</h2>
                      <p className="hint">{t('account.reader')}</p>
                    </div>
                  </div>
                  <ul className="grant-list">
                    {(libraries ?? []).map((library) => {
                      const granted = reader.libraryIds.includes(library.id);
                      const action = granted ? t('settings.revoke') : t('settings.grant');
                      return (
                        <li key={library.id} className="grant-row">
                          <span className="grant-library">{library.name}</span>
                          <button
                            type="button"
                            className={granted ? 'btn btn-secondary btn-sm grant-on' : 'btn btn-ghost btn-sm'}
                            aria-label={`${action} ${library.name} ${reader.username}`}
                            aria-pressed={granted}
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
        </section>
      </div>
    </div>
  );
}

function TextField({
  label,
  type,
  value,
  autoComplete,
  hint,
  icon,
  onChange,
}: {
  label: string;
  type: 'text' | 'password';
  value: string;
  autoComplete: string;
  hint?: string;
  icon?: ReactNode;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  const inputId = useId();
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className={icon ? 'input-with-icon' : undefined}>
        {icon ? (
          <span className="input-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
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
      </div>
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
