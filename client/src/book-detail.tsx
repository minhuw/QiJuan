import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, apiForm, type EditionDetail, type MetadataPreview } from './api';
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
]);

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
  const baseId = useId();

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
    setPending(true);
    setLookupNote(null);
    setPreview(null);
    const result = await api<MetadataPreview>(`/api/editions/${edition.id}/metadata/lookup`, { method: 'POST' });
    setPending(false);
    if (result.status === 404) {
      setLookupNote('none');
      return;
    }
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setPreview(result.data);
    setChecked(result.data.fields.filter((field) => field.status === 'change').map((field) => field.field));
  }

  async function applyPreview(event: FormEvent) {
    event.preventDefault();
    if (!edition || !preview) return;
    if (checked.length === 0) {
      setFormError('required');
      return;
    }
    setPending(true);
    setFormError(null);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}/metadata/apply`, {
      method: 'POST',
      body: { previewId: preview.previewId, confirm: checked },
    });
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setEdition(result.data.edition);
    setForm(toForm(result.data.edition));
    setPreview(null);
    setSaved(true);
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
    <>
      <div className="toolbar">
        <Link className="text-link" to="/">
          {t('book.back')}
        </Link>
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          {t('account.signOut')}
        </button>
      </div>
      <h1>{edition.title}</h1>
      {formError ? (
        <p className="alert" role="alert">
          {errorText(t, formError)}
        </p>
      ) : null}
      {saved ? <p role="status">{t('book.saved')}</p> : null}

      <section className="import-block">
        <h2>{t('book.cover')}</h2>
        {edition.cover ? (
          <img className="cover-preview" alt="" src={`/api/editions/${edition.id}/cover`} />
        ) : null}
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
      </section>

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
    </>
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
      <p className="placeholder">{t('book.readPlaceholder')}</p>
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
