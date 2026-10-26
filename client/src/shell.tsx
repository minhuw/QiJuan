import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { catalogs, localeIds, resolveLocale, translate } from './i18n';

interface LocaleValue {
  locale: string;
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleValue | null>(null);

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

  return (
    <LocaleContext.Provider value={value}>
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
          </div>
          <label className="lang">
            <span>{t('shell.language')}</span>
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
        </header>
        <main className="home" id="content">
          {children ?? <LibraryHome />}
        </main>
      </div>
    </LocaleContext.Provider>
  );
}
