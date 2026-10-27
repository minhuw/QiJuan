import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, apiForm, type EditionDetail, type ImportJob, type MetadataPreview } from './api';
import { EpubReader } from './reader/epub-reader';
import { PdfReader } from './reader/pdf-reader';
import { ReadingActions } from './reading-actions';
import { useLocale } from './shell';

const ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
  'payload_too_large',
  'metadata_unavailable',
  'conflict',
]);

/** Status poll for a metadata job. Open Library allows 10s for search, ISBN, and cover, and the worker runs one job at a time, so a lookup can stay queued much longer than a few seconds. */
const METADATA_JOB_POLL_MS = 200;

const FIELD_LABEL: Record<string, string> = {
  title: 'book.title',
  authors: 'book.authors',
  description: 'book.description',
  publisher: 'book.publisher',
  publishedDate: 'book.publishedDate',
  language: 'book.language',
  identifiers: 'book.identifiers',
  cover: 'book.cover',
};

interface RetryWait {
  cancel: () => void;
}

interface EditionForm {
  title: string;
  sortTitle: string;
  alternateTitles: string;
  authors: string;
  translators: string;
  description: string;
  series: string;
  seriesOrder: string;
  publisher: string;
  publishedDate: string;
  language: string;
  identifiers: string;
  tags: string;
}

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

function toForm(edition: EditionDetail): EditionForm {
  return {
    title: edition.title,
    sortTitle: edition.sortTitle,
    alternateTitles: edition.alternateTitles
      .map((item) => (item.sortTitle ? `${item.title}|${item.sortTitle}` : item.title))
      .join('\n'),
    authors: edition.authors.join('\n'),
    translators: edition.translators.join('\n'),
    description: edition.description ?? '',
    series: edition.series?.name ?? '',
    seriesOrder: edition.seriesOrder == null ? '' : String(edition.seriesOrder),
    publisher: edition.publisher ?? '',
    publishedDate: edition.publishedDate ?? '',
    language: edition.language ?? '',
    identifiers: edition.identifiers.map((item) => `${item.scheme}|${item.value}`).join('\n'),
    tags: edition.tags.join(', '),
  };
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function BookDetail({
  editionId,
  role,
  onSignOut,
}: {
  editionId: number;
  role: 'admin' | 'reader';
  onSignOut: () => void;
}) {
  const { t } = useLocale();
  const [edition, setEdition] = useState<EditionDetail | null>(null);
  const [form, setForm] = useState<EditionForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [preview, setPreview] = useState<MetadataPreview | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [activity, setActivity] = useState<'lookup' | 'apply' | null>(null);
  const baseId = useId();
  const requestId = useRef(0);
  const retryWait = useRef<RetryWait | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ edition: EditionDetail }>(`/api/editions/${editionId}`).then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        setEdition(null);
        return;
      }
      setError(null);
      setEdition(result.data.edition);
      setForm(toForm(result.data.edition));
    });
    return () => {
      active = false;
    };
  }, [editionId, generation]);

  useEffect(() => {
    setActivity(null);
    setPending(false);
    setPreview(null);
    setLookupNote(null);
    setFormError(null);
    return () => {
      requestId.current += 1;
      retryWait.current?.cancel();
    };
  }, [editionId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!edition || !form) return;
    const patch = diffEdition(edition, form);
    if (patch === 'invalid') {
      setFormError('invalid_request');
      return;
    }
    if (Object.keys(patch).length === 0) return;
    setPending(true);
    setFormError(null);
    setSaved(false);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}`, { method: 'PATCH', body: patch });
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setEdition(result.data.edition);
    setForm(toForm(result.data.edition));
    setSaved(true);
  }

  async function replaceCover(event: FormEvent) {
    event.preventDefault();
    if (!edition) return;
    const input = event.currentTarget.querySelector('input[type="file"]');
    const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
    if (!file) {
      setFormError('required');
      return;
    }
    const body = new FormData();
    body.append('cover', file);
    setPending(true);
    setFormError(null);
    const result = await apiForm<{ edition: EditionDetail }>(`/api/editions/${edition.id}/cover`, body);
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setEdition(result.data.edition);
    setForm(toForm(result.data.edition));
    setSaved(true);
    if (input instanceof HTMLInputElement) input.value = '';
  }

  async function dismiss(suggestionId: number) {
    if (!edition) return;
    const result = await api(`/api/suggestions/${suggestionId}/dismiss`, { method: 'POST' });
    if (result.error) {
      setFormError(result.error);
      return;
    }
    setGeneration((value) => value + 1);
  }

  async function lookup() {
    if (!edition) return;
    const editionId = edition.id;
    const token = ++requestId.current;
    setPending(true);
    setActivity('lookup');
    setLookupNote(null);
    setPreview(null);
    setSaved(false);
    setFormError(null);
    try {
      const started = await api<{ job: { id: number } }>(`/api/editions/${editionId}/metadata/lookup`, { method: 'POST' });
      if (requestId.current !== token) return;
      if (started.error || !started.data?.job?.id) {
        setFormError(started.error ?? 'internal');
        return;
      }
      const job = await pollJob(started.data.job.id, token);
      if (requestId.current !== token) return;
      if (!job || job.status === 'failed') {
        setFormError(job ? jobError(job) ?? 'internal' : 'internal');
        return;
      }
      setFormError(null);
      const next = jobPreview(job);
      if (!next) {
        setLookupNote('none');
        return;
      }
      setPreview(next);
      setChecked(next.fields.filter((field) => field.status === 'change').map((field) => field.field));
    } finally {
      if (requestId.current === token) {
        setPending(false);
        setActivity(null);
      }
    }
  }

  async function applyPreview(event: FormEvent) {
    event.preventDefault();
    if (!edition || !preview) return;
    if (checked.length === 0) {
      setFormError('required');
      return;
    }
    const editionId = edition.id;
    const previewId = preview.previewId;
    const confirm = checked;
    const token = ++requestId.current;
    setPending(true);
    setActivity('apply');
    setFormError(null);
    setSaved(false);
    try {
      const started = await api<{ job: { id: number } }>(`/api/editions/${editionId}/metadata/apply`, {
        method: 'POST',
        body: { previewId, confirm },
      });
      if (requestId.current !== token) return;
      if (started.error || !started.data?.job?.id) {
        setFormError(started.error ?? 'internal');
        return;
      }
      const job = await pollJob(started.data.job.id, token);
      if (requestId.current !== token) return;
      if (!job || job.status !== 'succeeded') {
        setFormError(job ? jobError(job) ?? 'internal' : 'internal');
        return;
      }
      const next = await loadEdition(editionId, token);
      if (requestId.current !== token || !next) return;
      setFormError(null);
      setEdition(next);
      setForm(toForm(next));
      setPreview(null);
      setSaved(true);
    } finally {
      if (requestId.current === token) {
        setPending(false);
        setActivity(null);
      }
    }
  }

  function waitForRetry(token: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (requestId.current !== token) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (retryWait.current?.cancel === cancel) retryWait.current = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(requestId.current === token), METADATA_JOB_POLL_MS);
      function cancel() {
        clearTimeout(timer);
        finish(false);
      }
      retryWait.current = { cancel };
    });
  }

  // Poll until the job itself finishes. Giving up while it is queued re-enables Save
  // with the pre-apply form, which can overwrite fields the job already locked.
  async function pollJob(jobId: number, token: number): Promise<ImportJob | null> {
    while (requestId.current === token) {
      const result = await api<{ job: ImportJob }>(`/api/jobs/${jobId}`);
      if (requestId.current !== token) return null;
      const job = result.error ? undefined : result.data?.job;
      if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
      const stillHere = await waitForRetry(token);
      if (!stillHere) return null;
    }
    return null;
  }

  async function loadEdition(id: number, token: number): Promise<EditionDetail | null> {
    while (requestId.current === token) {
      const loaded = await api<{ edition: EditionDetail }>(`/api/editions/${id}`);
      if (requestId.current !== token) return null;
      if (!loaded.error && loaded.data?.edition) return loaded.data.edition;
      const stillHere = await waitForRetry(token);
      if (!stillHere) return null;
    }
    return null;
  }

  if (error) {
    return (
      <>
        <p className="alert" role="alert">
          {errorText(t, error)}
        </p>
        <Link className="text-link" to="/">
          {t('book.back')}
        </Link>
      </>
    );
  }
  if (!edition || !form) return <p role="status">{t('status.loading')}</p>;

  const locks = new Set(edition.locks);
  const set =
    (key: keyof EditionForm) => (value: string) => {
      setSaved(false);
      setForm((current) => (current ? { ...current, [key]: value } : current));
    };

  return (
    <div className="book-page">
      <div className="toolbar">
        <Link className="text-link" to="/">
          {t('book.back')}
        </Link>
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          {t('account.signOut')}
        </button>
      </div>
      <div className="book-hero">
        {edition.cover ? (
          <img className="cover-preview" alt="" src={`/api/editions/${edition.id}/cover`} />
        ) : (
          <span className="cover-fallback">
            <span className="cover-fallback-title">{edition.title}</span>
            {edition.authors[0] ? <span className="cover-fallback-author">{edition.authors[0]}</span> : null}
          </span>
        )}
        <div className="book-hero-copy">
          <h1>{edition.title}</h1>
          {edition.authors.length > 0 ? <p className="byline">{edition.authors.join(', ')}</p> : null}
          {edition.translators.length > 0 ? (
            <p className="byline">{edition.translators.join(', ')}</p>
          ) : null}
          {edition.description ? <p>{edition.description}</p> : null}
        </div>
      </div>
      <ReadingActions
        edition={edition}
        onEdition={(next) => {
          setEdition(next);
          setForm(toForm(next));
        }}
      />
      {formError ? (
        <p className="alert" role="alert">
          {errorText(t, formError)}
        </p>
      ) : null}
      {saved ? <p role="status">{t('book.saved')}</p> : null}

      <section className="import-block">
        <h2>{t('book.cover')}</h2>
        {locks.has('cover') ? <p className="hint">{t('book.locked')}</p> : null}
        <form className="form" onSubmit={(event) => void replaceCover(event)}>
          <label className="field" htmlFor={`${baseId}-cover`}>
            {t('book.replaceCover')}
            <input id={`${baseId}-cover`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" />
          </label>
          <button className="button" type="submit" disabled={pending}>
            {t('book.replaceCover')}
          </button>
        </form>
      </section>

      <section className="import-block">
        <h2>{t('book.formats')}</h2>
        <ul className="plain-list">
          {edition.assets.map((asset) => (
            <li key={asset.id} className="book-row">
              <span>{asset.originalFilename}</span>
              <Link to={`/books/${edition.id}/read/${asset.id}`}>
                {t('book.read')} {asset.format.toUpperCase()}
              </Link>
              {asset.availability === 'missing' ? <span className="hint-inline">{t('book.missing')}</span> : null}
            </li>
          ))}
        </ul>
        <p>
          <a href={`/api/editions/${edition.id}/annotations?format=markdown`}>{t('book.exportMarkdown')}</a>
          {' · '}
          <a href={`/api/editions/${edition.id}/annotations?format=json`}>{t('book.exportJson')}</a>
        </p>
      </section>

      {edition.series ? (
        <section className="import-block">
          <h2>{t('reading.neighbors')}</h2>
          <p>
            {edition.series.name}
            {edition.seriesOrder == null ? '' : ` · ${edition.seriesOrder}`}
          </p>
          {edition.neighbors?.previous ? (
            <p>
              <Link className="text-link" to={`/books/${edition.neighbors.previous.id}`}>
                {t('reading.previous')}: {edition.neighbors.previous.title}
              </Link>
            </p>
          ) : null}
          {edition.neighbors?.next ? (
            <p>
              <Link className="text-link" to={`/books/${edition.neighbors.next.id}`}>
                {t('reading.next')}: {edition.neighbors.next.title}
              </Link>
            </p>
          ) : null}
          {!edition.neighbors?.previous && !edition.neighbors?.next ? (
            <p className="placeholder">{t('reading.noNeighbors')}</p>
          ) : null}
        </section>
      ) : null}

      <section className="import-block">
        <h2>{t('book.suggestions')}</h2>
        <p className="hint">{t('book.suggestionNote')}</p>
        {edition.suggestions.length === 0 ? <p className="placeholder">{t('book.noSuggestion')}</p> : null}
        <ul className="plain-list">
          {edition.suggestions.map((suggestion) => (
            <li key={suggestion.id} className="book-row">
              <Link to={`/books/${suggestion.otherEditionId}`}>{suggestion.otherTitle}</Link>
              <button type="button" className="button button-secondary" onClick={() => void dismiss(suggestion.id)}>
                {t('book.dismiss')}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <form className="form" onSubmit={(event) => void save(event)}>
        <Field id={`${baseId}-title`} label={t('book.title')} locked={locks.has('title')}>
          <input
            id={`${baseId}-title`}
            value={form.title}
            onChange={(event) => {
              const value = event.target.value;
              setSaved(false);
              setForm((current) =>
                current
                  ? { ...current, title: value, sortTitle: current.sortTitle === current.title ? value : current.sortTitle }
                  : current,
              );
            }}
          />
        </Field>
        <Field id={`${baseId}-sort`} label={t('book.sortTitle')} locked={locks.has('sortTitle')}>
          <input id={`${baseId}-sort`} value={form.sortTitle} onChange={(event) => set('sortTitle')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-alt`} label={t('book.alternateTitles')} hint={t('book.alternateHint')} locked={locks.has('alternateTitles')}>
          <textarea id={`${baseId}-alt`} value={form.alternateTitles} onChange={(event) => set('alternateTitles')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-authors`} label={t('book.authors')} hint={t('book.authorsHint')} locked={locks.has('authors')}>
          <textarea id={`${baseId}-authors`} value={form.authors} onChange={(event) => set('authors')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-translators`} label={t('book.translators')} hint={t('book.authorsHint')} locked={locks.has('translators')}>
          <textarea
            id={`${baseId}-translators`}
            value={form.translators}
            onChange={(event) => set('translators')(event.target.value)}
          />
        </Field>
        <Field id={`${baseId}-description`} label={t('book.description')} locked={locks.has('description')}>
          <textarea
            id={`${baseId}-description`}
            value={form.description}
            onChange={(event) => set('description')(event.target.value)}
          />
        </Field>
        <Field id={`${baseId}-series`} label={t('book.series')} locked={locks.has('series')}>
          <input id={`${baseId}-series`} value={form.series} onChange={(event) => set('series')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-order`} label={t('book.seriesOrder')} locked={locks.has('seriesOrder')}>
          <input id={`${baseId}-order`} value={form.seriesOrder} inputMode="decimal" onChange={(event) => set('seriesOrder')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-publisher`} label={t('book.publisher')} locked={locks.has('publisher')}>
          <input id={`${baseId}-publisher`} value={form.publisher} onChange={(event) => set('publisher')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-date`} label={t('book.publishedDate')} locked={locks.has('publishedDate')}>
          <input id={`${baseId}-date`} value={form.publishedDate} onChange={(event) => set('publishedDate')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-language`} label={t('book.language')} locked={locks.has('language')}>
          <input id={`${baseId}-language`} value={form.language} onChange={(event) => set('language')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-identifiers`} label={t('book.identifiers')} hint={t('book.identifiersHint')} locked={locks.has('identifiers')}>
          <textarea id={`${baseId}-identifiers`} value={form.identifiers} onChange={(event) => set('identifiers')(event.target.value)} />
        </Field>
        <Field id={`${baseId}-tags`} label={t('book.tags')} hint={t('book.tagsHint')} locked={locks.has('tags')}>
          <input id={`${baseId}-tags`} value={form.tags} onChange={(event) => set('tags')(event.target.value)} />
        </Field>
        <button className="button" type="submit" disabled={pending}>
          {t('book.save')}
        </button>
      </form>

      {role === 'admin' ? (
        <section className="import-block">
          <h2>{t('book.lookup')}</h2>
          <button className="button" type="button" disabled={pending} onClick={() => void lookup()}>
            {t('book.lookup')}
          </button>
          {activity === 'lookup' ? <p role="status">{t('book.lookupRunning')}</p> : null}
          {activity === 'apply' ? <p role="status">{t('book.applyRunning')}</p> : null}
          {lookupNote === 'none' ? <p>{t('book.noSuggestion')}</p> : null}
          {preview ? (
            <form className="form" onSubmit={(event) => void applyPreview(event)}>
              <h3>{t('book.preview')}</h3>
              <ul className="plain-list">
                {preview.fields.map((field) => (
                  <li key={field.field} className="book-row">
                    {field.status === 'change' ? (
                      <input
                        type="checkbox"
                        checked={checked.includes(field.field)}
                        aria-label={t(FIELD_LABEL[field.field] ?? 'book.title')}
                        onChange={() =>
                          setChecked((current) =>
                            current.includes(field.field)
                              ? current.filter((item) => item !== field.field)
                              : [...current, field.field],
                          )
                        }
                      />
                    ) : null}
                    <span>{t(FIELD_LABEL[field.field] ?? 'book.title')}</span>
                    {field.status === 'kept' ? <span>{t('book.kept')}</span> : null}
                    {field.status === 'unchanged' ? <span className="hint-inline">{t('book.unchanged')}</span> : null}
                    {field.proposed ? <span className="hint-inline">{field.proposed}</span> : null}
                  </li>
                ))}
              </ul>
              <button className="button" type="submit" disabled={pending}>
                {t('book.confirm')}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function ReaderPage({
  editionId,
  assetId,
  onSignOut,
}: {
  editionId: number;
  assetId: number;
  onSignOut: () => void;
}) {
  const { t } = useLocale();
  const [edition, setEdition] = useState<EditionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ edition: EditionDetail }>(`/api/editions/${editionId}`).then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        return;
      }
      setEdition(result.data.edition);
    });
    return () => {
      active = false;
    };
  }, [editionId]);

  if (error) {
    return (
      <p className="alert" role="alert">
        {errorText(t, error)}
      </p>
    );
  }
  if (!edition) return <p role="status">{t('status.loading')}</p>;
  const asset = edition.assets.find((item) => item.id === assetId);
  if (!asset) {
    return (
      <p className="alert" role="alert">
        {t('errors.not_found')}
      </p>
    );
  }
  if (asset.availability !== 'present' || (asset.format !== 'epub' && asset.format !== 'pdf')) {
    return (
      <>
        <div className="toolbar">
          <Link className="text-link" to={`/books/${edition.id}`}>
            {t('book.back')}
          </Link>
          <button type="button" className="button button-secondary" onClick={onSignOut}>
            {t('account.signOut')}
          </button>
        </div>
        <h1>{edition.title}</h1>
        <p>
          {t('book.read')} {asset.format.toUpperCase()}
        </p>
        <p className="placeholder">
          {asset.availability === 'missing' ? t('book.missing') : t('book.readPlaceholder')}
        </p>
      </>
    );
  }
  return (
    <>
      <div className="toolbar">
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          {t('account.signOut')}
        </button>
      </div>
      {asset.format === 'pdf' ? (
        <PdfReader editionId={edition.id} assetId={asset.id} title={edition.title} />
      ) : (
        <EpubReader editionId={edition.id} assetId={asset.id} title={edition.title} />
      )}
    </>
  );
}

function Field({
  id,
  label,
  hint,
  locked,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  locked?: boolean;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {locked ? <p className="hint">{t('book.locked')}</p> : null}
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

function jobPreview(job: ImportJob): MetadataPreview | null {
  const result = job.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const preview = (result as { preview?: unknown }).preview;
  if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) return null;
  const record = preview as { previewId?: unknown; fields?: unknown };
  if (typeof record.previewId !== 'number' || !Array.isArray(record.fields)) return null;
  return { previewId: record.previewId, fields: record.fields as MetadataPreview['fields'] };
}

function jobError(job: ImportJob): string | null {
  const result = job.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
}

function diffEdition(edition: EditionDetail, form: EditionForm): Record<string, unknown> | 'invalid' {
  const patch: Record<string, unknown> = {};
  const title = form.title.trim();
  const sortTitle = form.sortTitle.trim();
  if (!title || !sortTitle) return 'invalid';
  if (title !== edition.title) patch.title = title;
  if (sortTitle !== edition.sortTitle) patch.sortTitle = sortTitle;

  const alternate = lines(form.alternateTitles).map((line) => {
    const split = line.indexOf('|');
    if (split === -1) return { title: line, sortTitle: null as string | null };
    const name = line.slice(0, split).trim();
    const sort = line.slice(split + 1).trim();
    if (!name) return null;
    return { title: name, sortTitle: sort || null };
  });
  if (alternate.some((item) => item === null)) return 'invalid';
  const alternateTitles = alternate.filter((item): item is { title: string; sortTitle: string | null } => item !== null);
  if (JSON.stringify(alternateTitles) !== JSON.stringify(edition.alternateTitles)) patch.alternateTitles = alternateTitles;

  const authors = lines(form.authors);
  if (authors.join('\n') !== edition.authors.join('\n')) patch.authors = authors;
  const translators = lines(form.translators);
  if (translators.join('\n') !== edition.translators.join('\n')) patch.translators = translators;

  const description = form.description.trim();
  if (description !== (edition.description ?? '')) patch.description = description || null;
  const publisher = form.publisher.trim();
  if (publisher !== (edition.publisher ?? '')) patch.publisher = publisher || null;
  const publishedDate = form.publishedDate.trim();
  if (publishedDate !== (edition.publishedDate ?? '')) patch.publishedDate = publishedDate || null;
  const language = form.language.trim();
  if (language !== (edition.language ?? '')) patch.language = language || null;

  const series = form.series.trim();
  if (series !== (edition.series?.name ?? '')) patch.series = series || null;
  const orderText = form.seriesOrder.trim();
  let seriesOrder: number | null;
  if (!series || !orderText) seriesOrder = null;
  else {
    const parsed = Number(orderText);
    if (!Number.isFinite(parsed)) return 'invalid';
    seriesOrder = parsed;
  }
  if (seriesOrder !== edition.seriesOrder) patch.seriesOrder = seriesOrder;

  const identifiers = lines(form.identifiers).map((line) => {
    const split = line.indexOf('|');
    if (split <= 0 || split === line.length - 1) return null;
    return { scheme: line.slice(0, split).trim(), value: line.slice(split + 1).trim() };
  });
  if (identifiers.some((item) => item === null || !item.scheme || !item.value)) return 'invalid';
  const cleanIdentifiers = identifiers.filter((item): item is { scheme: string; value: string } => item !== null);
  if (JSON.stringify(cleanIdentifiers) !== JSON.stringify(edition.identifiers)) patch.identifiers = cleanIdentifiers;

  const tags = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.join('\n') !== edition.tags.join('\n')) patch.tags = tags;
  return patch;
}
