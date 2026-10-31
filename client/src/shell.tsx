import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router';
import { LogOut, Menu, X } from 'lucide-react';
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
      <h1>{t('home.title')}</h1>
      <p className="placeholder">{t('home.placeholder')}</p>
    </div>
  );
}

function LanguageSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const id = useId();
  return (
    <label className="language-select" htmlFor={id}>
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

function Brand() {
  const { t } = useLocale();
  return (
    <Link className="brand" to="/" aria-label={`${t('brand.name')} — ${t('home.title')}`}>
      <span className="brand-mark" lang="zh-Hans" aria-hidden="true">
        {t('brand.mark')}
      </span>
      <span className="brand-name">{t('brand.name')}</span>
    </Link>
  );
}

function Revision({ revision }: { revision: string }) {
  const { t } = useLocale();
  return (
    <p className="build-chip" title={revision}>
      {t('shell.version')} <span className="build-chip-id">{revision.slice(0, 12)}</span>
    </p>
  );
}

function NavItem({
  to,
  label,
  active,
  admin = false,
  onNavigate,
}: {
  to: string;
  label: string;
  active: boolean;
  admin?: boolean;
  onNavigate: () => void;
}) {
  const className = ['nav-item', admin ? 'nav-item-admin' : '', active ? 'nav-item-active' : ''].filter(Boolean).join(' ');
  return (
    <Link className={className} to={to} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
      {label}
    </Link>
  );
}

function AppBar({
  account,
  path,
  active,
  menuOpen,
  onLocale,
  onMenu,
}: {
  account: AccountChrome;
  path: string;
  active: string;
  menuOpen: boolean;
  onLocale: (value: string) => void;
  onMenu: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const menuButton = useRef<HTMLButtonElement>(null);
  const admin = account.role === 'admin';
  const onLibrary = path === '/' || path.startsWith('/books/');
  const initial = account.username.trim().charAt(0).toLocaleUpperCase() || '?';
  const close = () => onMenu(false);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      onMenu(false);
      menuButton.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, onMenu]);

  return (
    <>
      <header className="app-bar">
        <Brand />
        <button
          ref={menuButton}
          type="button"
          className="icon-button menu-button"
          aria-label={menuOpen ? t('shell.closeMenu') : t('shell.openMenu')}
          aria-expanded={menuOpen}
          aria-controls="app-navigation"
          onClick={() => onMenu(!menuOpen)}
        >
          {menuOpen ? <X size={20} strokeWidth={1.5} aria-hidden="true" /> : <Menu size={20} strokeWidth={1.5} aria-hidden="true" />}
        </button>
        <div className={menuOpen ? 'app-bar-panel app-bar-panel-open' : 'app-bar-panel'} id="app-navigation">
          <nav className="app-nav" aria-label={t('shell.navigation')}>
            <NavItem to="/" label={t('home.title')} active={onLibrary} onNavigate={close} />
            <NavItem to="/import" label={t('import.open')} active={path === '/import'} onNavigate={close} />
            {admin ? (
              <>
                <span className="app-nav-divider" aria-hidden="true" />
                <NavItem to="/settings" label={t('settings.open')} active={path === '/settings'} admin onNavigate={close} />
                <NavItem to="/backup" label={t('backup.open')} active={path === '/backup'} admin onNavigate={close} />
              </>
            ) : null}
          </nav>
          <div className="app-bar-end">
            <LanguageSelect value={active} onChange={onLocale} />
            <div className="account">
              <span className="account-initial" aria-hidden="true">
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
                <LogOut size={17} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </header>
      {menuOpen ? <div className="sheet-scrim" aria-hidden="true" onClick={close} /> : null}
    </>
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
          {account ? (
            readerMode ? null : (
              <AppBar
                account={account}
                path={path}
                active={active}
                menuOpen={menuOpen}
                onLocale={setActive}
                onMenu={setMenuOpen}
              />
            )
          ) : (
            <header className="site-header">
              <Brand />
              <div className="site-header-end">
                {revision ? <Revision revision={revision} /> : null}
                <LanguageSelect value={active} onChange={setActive} />
              </div>
            </header>
          )}
          <main
            className={account ? (readerMode ? 'reader-content' : 'page-container') : 'auth-main'}
            id="content"
          >
            {children ?? <LibraryHome />}
          </main>
          {account && !readerMode ? (
            <footer className="folio">
              <p className="folio-tagline" lang="zh-Hans">
                {t('brand.tagline')}
              </p>
              {revision ? <Revision revision={revision} /> : null}
            </footer>
          ) : null}
        </div>
      </AccountChromeContext.Provider>
    </LocaleContext.Provider>
  );
}
