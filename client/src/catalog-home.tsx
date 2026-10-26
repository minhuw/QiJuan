import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type EditionSummary } from './api';
import { useLocale } from './shell';

const ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
]);

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

export function CatalogHome() {
  const { t } = useLocale();
  const [editions, setEditions] = useState<EditionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [language, setLanguage] = useState('');
  const [publisher, setPublisher] = useState('');
  const [tags, setTags] = useState('');
  const [series, setSeries] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const baseId = useId();

  useEffect(() => {
    let active = true;
    void api<{ editions: EditionSummary[] }>('/api/editions').then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        setEditions(null);
        return;
      }
      setError(null);
      setEditions(result.data.editions);
    });
    return () => {
      active = false;
    };
  }, [generation]);

  function toggle(id: number) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0) {
      setFormError('required');
      return;
    }
    const body: Record<string, unknown> = { editionIds: selected };
    if (language.trim()) body.language = language.trim();
    if (publisher.trim()) body.publisher = publisher.trim();
    if (tags.trim()) body.tags = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    if (series.trim()) body.series = series.trim();
    if (Object.keys(body).length === 1) {
      setFormError('required');
      return;
    }
    setPending(true);
    setFormError(null);
    const result = await api<{ updated: number }>('/api/editions/batch', { method: 'POST', body });
    setPending(false);
    if (result.error) {
      setFormError(result.error);
      return;
    }
    setLanguage('');
    setPublisher('');
    setTags('');
    setSeries('');
    setSelected([]);
    setGeneration((value) => value + 1);
  }

  return (
    <section className="import-block">
      <h2>{t('catalog.books')}</h2>
      {error ? (
        <p className="alert" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
      {editions === null && !error ? <p role="status">{t('status.loading')}</p> : null}
      {editions && editions.length === 0 ? <p className="placeholder">{t('home.placeholder')}</p> : null}
      {editions && editions.length > 0 ? (
        <ul className="plain-list">
          {editions.map((edition) => (
            <li key={edition.id} className="book-row">
              <input
                type="checkbox"
                checked={selected.includes(edition.id)}
                aria-label={`${t('catalog.select')} ${edition.title}`}
                onChange={() => toggle(edition.id)}
              />
              <Link className="book-main" to={`/books/${edition.id}`}>
                {edition.title}
              </Link>
              {edition.language ? <span className="hint-inline">{edition.language}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editions && editions.length > 0 ? (
        <form className="form" onSubmit={(event) => void apply(event)}>
          {formError ? (
            <p className="alert" role="alert">
              {errorText(t, formError)}
            </p>
          ) : null}
          <label className="field" htmlFor={`${baseId}-language`}>
            {t('catalog.language')}
            <input id={`${baseId}-language`} value={language} onChange={(event) => setLanguage(event.target.value)} />
          </label>
          <label className="field" htmlFor={`${baseId}-publisher`}>
            {t('catalog.publisher')}
            <input id={`${baseId}-publisher`} value={publisher} onChange={(event) => setPublisher(event.target.value)} />
          </label>
          <label className="field" htmlFor={`${baseId}-tags`}>
            {t('catalog.tags')}
            <input id={`${baseId}-tags`} value={tags} onChange={(event) => setTags(event.target.value)} />
            <span className="hint">{t('catalog.tagsHint')}</span>
          </label>
          <label className="field" htmlFor={`${baseId}-series`}>
            {t('catalog.series')}
            <input id={`${baseId}-series`} value={series} onChange={(event) => setSeries(event.target.value)} />
          </label>
          <button className="button" type="submit" disabled={pending}>
            {t('catalog.apply')}
          </button>
        </form>
      ) : null}
    </section>
  );
}
