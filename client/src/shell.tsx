import { useEffect, useState } from 'react';
import { catalogs, localeIds, resolveLocale, translate } from './i18n';

export function Shell({ locale }: { locale?: string }) {
  const [active, setActive] = useState(() =>
    resolveLocale(locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)),
  );

  useEffect(() => {
    document.documentElement.lang = active;
  }, [active]);

  const t = (key: string) => translate(active, key);

  return (
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
        <p className="tagline">{t('brand.tagline')}</p>
        <h1>{t('home.title')}</h1>
        <p className="placeholder">{t('home.placeholder')}</p>
      </main>
    </div>
  );
}
