import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router';
import { BookOpen, CloudUpload, LogOut, Menu, Settings2, Upload, X } from 'lucide-react';
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
    <div className="empty-page">
      <div className="empty-page-mark" aria-hidden="true">
        <BookOpen size={30} strokeWidth={1.5} />
      </div>
      <p className="eyebrow">{t('brand.tagline')}</p>
      <h1>{t('home.title')}</h1>
      <p className="placeholder">{t('home.placeholder')}</p>
    </div>
  );
}

function LanguageSelect({
  value,
  onChange,
  tone = 'default',
}: {
  value: string;
  onChange: (value: string) => void;
  tone?: 'default' | 'inverse';
}) {
  const { t } = useLocale();
  const id = useId();
  return (
    <label className={tone === 'inverse' ? 'language-select language-select-inverse' : 'language-select'} htmlFor={id}>
      <span className="visually-hidden">{t('shell.language')}</span>
      <select id={id} value={value} aria-label={t('shell.language')} onChange={(event) => onChange(event.target.value)}>
        {localeIds().map((locale) => (
          <option key={locale} value={locale}>
            {catalogs[locale]?.meta.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useLocale();
  return (
    <Link className={compact ? 'brand brand-compact' : 'brand'} to="/" aria-label={`${t('brand.name')} — ${t('home.title')}`}>
      <span className="brand-seal" lang="zh-Hans" aria-hidden="true">
        {t('brand.mark')}
      </span>
      <span className="brand-copy">
        <span className="brand-name">{t('brand.name')}</span>
        {compact ? null : <span className="brand-tagline">{t('brand.tagline')}</span>}
      </span>
    </Link>
  );
}

function NavItem({
  to,
  label,
  icon,
  active,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      className={active ? 'nav-item nav-item-active' : 'nav-item'}
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <span className="nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}

function Sidebar({
  account,
  path,
  revision,
  active,
  onLocale,
  onClose,
}: {
  account: AccountChrome;
  path: string;
  revision: string | null;
  active: string;
  onLocale: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const admin = account.role === 'admin';
  const onLibrary = path === '/' || path.startsWith('/books/');
  const initial = account.username.trim().charAt(0).toLocaleUpperCase() || '?';

  return (
    <aside className="sidebar" id="app-navigation">
      <div className="sidebar-brand">
        <Brand />
        <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label={t('shell.closeMenu')}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label={t('shell.navigation')}>
        <p className="nav-section">{t('shell.workspace')}</p>
        <NavItem
          to="/"
          label={t('home.title')}
          icon={<BookOpen size={18} />}
          active={onLibrary}
          onNavigate={onClose}
        />
        <NavItem
          to="/import"
          label={t('import.open')}
          icon={<Upload size={18} />}
          active={path === '/import'}
          onNavigate={onClose}
        />

        {admin ? (
          <>
            <p className="nav-section nav-section-spaced">{t('shell.admin')}</p>
            <NavItem
              to="/settings"
              label={t('settings.open')}
              icon={<Settings2 size={18} />}
              active={path === '/settings'}
              onNavigate={onClose}
            />
            <NavItem
              to="/backup"
              label={t('backup.open')}
              icon={<CloudUpload size={18} />}
              active={path === '/backup'}
              onNavigate={onClose}
            />
          </>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        {revision ? (
          <p className="build-chip" title={revision}>
            <span className="visually-hidden">{t('shell.version')} </span>
            {revision.slice(0, 12)}
          </p>
        ) : null}
        <LanguageSelect value={active} onChange={onLocale} tone="inverse" />
        <div className="account-card">
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="account-copy">
            <span className="account-name">{account.username}</span>
            <span className="account-role">{t(admin ? 'account.admin' : 'account.reader')}</span>
          </span>
          <button
            type="button"
            className="icon-button account-signout"
            onClick={account.onSignOut}
            aria-label={t('account.signOut')}
            title={t('account.signOut')}
          >
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Shell({ locale, children }: { locale?: string; children?: ReactNode }) {
  const location = useLocation();
  const path = location.pathname;
  const [account, setAccountState] = useState<AccountChrome | null>(null);
  const setAccount = useCallback((next: AccountChrome | null) => {
    setAccountState(next);
  }, []);
  const [active, setActive] = useState(() =>
    resolveLocale(locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.lang = active;
  }, [active]);

  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const value = useMemo<LocaleValue>(
    () => ({
      locale: active,
      t: (key: string) => translate(active, key),
    }),
    [active],
  );
  const t = value.t;

  useEffect(() => {
    let alive = true;
    void api<{ revision?: unknown }>('/health').then((result) => {
      const next = result.data?.revision;
      if (!alive || typeof next !== 'string' || !REVISION.test(next)) return;
      setRevision(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const chrome = useMemo(() => ({ account, setAccount }), [account, setAccount]);
  const readerMode = Boolean(account) && /^\/books\/[1-9]\d*\/read\/[1-9]\d*$/.test(path);
  const bookMode = Boolean(account) && /^\/books\/[1-9]\d*$/.test(path);

  const skip = (
    <a className="skip-link" href="#content">
      {t('shell.skip')}
    </a>
  );

  return (
    <LocaleContext.Provider value={value}>
      <AccountChromeContext.Provider value={chrome}>
        <div
          className={account
            ? `app-shell${readerMode ? ' reader-mode' : bookMode ? ' book-mode' : ''}${menuOpen && !readerMode ? ' app-shell-nav-open' : ''}`
            : 'auth-shell'}
        >
          {skip}
          <div className="shell-chrome">
            {account && !readerMode ? (
              <>
                <button
                  type="button"
                  className="sidebar-scrim"
                  aria-label={t('shell.closeMenu')}
                  tabIndex={menuOpen ? 0 : -1}
                  onClick={() => setMenuOpen(false)}
                />
                <Sidebar
                  account={account}
                  path={path}
                  revision={revision}
                  active={active}
                  onLocale={setActive}
                  onClose={() => setMenuOpen(false)}
                />
              </>
            ) : null}
          </div>
          <div className={account ? 'app-body' : 'auth-body'}>
            {account ? (
              readerMode ? null : (
                <header className="mobile-bar">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('shell.openMenu')}
                    aria-expanded={menuOpen}
                    aria-controls="app-navigation"
                    onClick={() => setMenuOpen(true)}
                  >
                    <Menu size={20} aria-hidden="true" />
                  </button>
                  <span className="mobile-seal" lang="zh-Hans" aria-hidden="true">
                    {t('brand.mark')}
                  </span>
                  <span className="mobile-bar-spacer" />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('account.signOut')}
                    title={t('account.signOut')}
                    onClick={account.onSignOut}
                  >
                    <LogOut size={18} aria-hidden="true" />
                  </button>
                </header>
              )
            ) : (
              <header className="site-header">
                <div className="site-header-inner">
                  <Brand compact />
                  <div className="site-header-end">
                    {revision ? (
                      <p className="build-chip build-chip-light" title={revision}>
                        <span className="visually-hidden">{t('shell.version')} </span>
                        {revision.slice(0, 12)}
                      </p>
                    ) : null}
                    <LanguageSelect value={active} onChange={setActive} />
                  </div>
                </div>
              </header>
            )}
            <main
              className={account ? (readerMode ? 'reader-content' : 'page-container') : 'auth-main'}
              id="content"
            >
              {children ?? <LibraryHome />}
            </main>
          </div>
        </div>
      </AccountChromeContext.Provider>
    </LocaleContext.Provider>
  );

}
