import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from './api';
import { catalogs, localeIds, resolveLocale, translate } from './i18n';

const REVISION = /^(dev|[0-9a-f]{7,40})$/;

interface LocaleValue {
  locale: string;
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleValue | null>(null);

export interface AccountChrome {
  username: string;
  role: 'admin' | 'reader';
  onSignOut: () => void;
}

const AccountChromeContext = createContext<{
  account: AccountChrome | null;
  setAccount: (account: AccountChrome | null) => void;
} | null>(null);

export function useAccountChrome(): {
  account: AccountChrome | null;
  setAccount: (account: AccountChrome | null) => void;
} {
  const value = useContext(AccountChromeContext);
  if (!value) throw new Error('useAccountChrome requires Shell');
  return value;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale requires Shell');
  return value;
}

export function LibraryHome() {
  const { t } = useLocale();
  return (
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('home.title')}</h1>
      <p className="placeholder">{t('home.placeholder')}</p>
    </>
  );
}

export function Shell({ locale, children }: { locale?: string; children?: ReactNode }) {
  const location = useLocation();
  const [account, setAccountState] = useState<AccountChrome | null>(null);
  const setAccount = useCallback((next: AccountChrome | null) => {
    setAccountState(next);
  }, []);
  const [active, setActive] = useState(() =>
    resolveLocale(locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)),
  );

  useEffect(() => {
    document.documentElement.lang = active;
  }, [active]);

  const value = useMemo<LocaleValue>(
    () => ({
      locale: active,
      t: (key: string) => translate(active, key),
    }),
    [active],
  );

  const t = value.t;
  const [revision, setRevision] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ revision?: unknown }>('/health').then((result) => {
      const value = result.data?.revision;
      if (!active || typeof value !== 'string' || !REVISION.test(value)) return;
      setRevision(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const path = location.pathname;
  const chrome = useMemo(() => ({ account, setAccount }), [account, setAccount]);

  return (
    <LocaleContext.Provider value={value}>
      <AccountChromeContext.Provider value={chrome}>
      <div className="shell">
        <a className="skip" href="#content">
          {t('shell.skip')}
        </a>
        <header className="topbar">
          <div className="brand">
            <p className="brand-mark" lang="zh-Hans">
              {t('brand.mark')}
            </p>
            <p className="brand-name">{t('brand.name')}</p>
            {revision ? (
              <p className="brand-revision" title={revision}>
                <span className="visually-hidden">{t('shell.version')} </span>
                {revision.slice(0, 12)}
              </p>
            ) : null}
          </div>
          {account ? (
            <nav className="app-nav" aria-label={t('shell.navigation')}>
              <Link to="/" aria-current={path === '/' ? 'page' : undefined}>
                {t('home.title')}
              </Link>
              <Link to="/import" aria-current={path === '/import' ? 'page' : undefined}>
                {t('import.open')}
              </Link>
              {account.role === 'admin' ? (
                <Link to="/settings" aria-current={path === '/settings' ? 'page' : undefined}>
                  {t('settings.open')}
                </Link>
              ) : null}
              {account.role === 'admin' ? (
                <Link to="/backup" aria-current={path === '/backup' ? 'page' : undefined}>
                  {t('backup.open')}
                </Link>
              ) : null}
            </nav>
          ) : null}
          <div className="topbar-end">
            {account ? (
              <div className="account-chip">
                <span>
                  <span className="visually-hidden">{t('account.signedIn')} </span>
                  <strong>{account.username}</strong>
                </span>
                <button type="button" className="button button-quiet" onClick={account.onSignOut}>
                  {t('account.signOut')}
                </button>
              </div>
            ) : null}
            <label className="lang">
              <span className="visually-hidden">{t('shell.language')}</span>
              <select
                value={active}
                aria-label={t('shell.language')}
                onChange={(event) => setActive(resolveLocale(event.target.value))}
              >
                {localeIds().map((id) => (
                  <option key={id} value={id}>
                    {catalogs[id]?.meta.nativeName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <main className="home" id="content">
          {children ?? <LibraryHome />}
        </main>
      </div>
      </AccountChromeContext.Provider>
    </LocaleContext.Provider>
  );
}
