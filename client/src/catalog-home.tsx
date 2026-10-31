import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { api, type EditionSummary } from './api';
import { EmptyState, ErrorNotice, LoadingState } from './components/ui/states';
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
    <details className="entry batch-panel">
      <summary>
        <span className="entry-head batch-summary-head">
          <span className="batch-summary-title">{t('catalog.edit')}</span>
        </span>
        <span className="batch-summary-copy">
          <span className="batch-summary-hint">{t('catalog.editHint')}</span>
          <ChevronDown className="batch-chevron" size={17} strokeWidth={1.5} aria-hidden="true" />
        </span>
      </summary>
      <div className="batch-body">
        <div className="batch-list">
          <div className="panel-head">
            <h2>{t('catalog.books')}</h2>
            {editions && editions.length > 0 ? (
              <span className="panel-meta">
                {t('catalog.selected')} · <span className="num">{selected.length}</span>
              </span>
            ) : null}
          </div>
          {error ? (
            <ErrorNotice
              message={errorText(t, error)}
              onRetry={() => {
                setError(null);
                setGeneration((value) => value + 1);
              }}
            />
          ) : null}
          {editions === null && !error ? <LoadingState /> : null}
          {editions && editions.length === 0 ? (
            <EmptyState compact title={t('home.placeholder')} />
          ) : null}
          {editions && editions.length > 0 ? (
            <ul className="batch-book-list">
              {editions.map((edition) => (
                <li key={edition.id} className="batch-book-row">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selected.includes(edition.id)}
                      aria-label={`${t('catalog.select')} ${edition.title}`}
                      onChange={() => toggle(edition.id)}
                    />
                    <span className="batch-book-title">{edition.title}</span>
                  </label>
                  {edition.language ? <span className="hint-inline">{edition.language}</span> : null}
                  <Link className="text-link" to={`/books/${edition.id}`}>
                    {t('book.title')}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {editions && editions.length > 0 ? (
          <form className="form batch-form" onSubmit={(event) => void apply(event)}>
            <div className="panel-head">
              <h2>{t('catalog.apply')}</h2>
            </div>
            {formError ? (
              <div className="alert alert-error" role="alert">
                {errorText(t, formError)}
              </div>
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
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {t('catalog.apply')}
            </button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
