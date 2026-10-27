import { useId, useState, type FormEvent } from 'react';
import { api, type EditionDetail, type ReadingShelf, type ReadingStatus } from './api';
import { useLocale } from './shell';

const STATUSES: ReadingStatus[] = ['want', 'reading', 'finished', 'on_hold'];
const ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
  'conflict',
]);

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

export function ReadingActions({
  edition,
  onEdition,
}: {
  edition: EditionDetail;
  onEdition: (edition: EditionDetail) => void;
}) {
  const { t } = useLocale();
  const shelfId = useId();
  const [shelfName, setShelfName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = edition.reading ?? {
    status: null,
    rating: null,
    favorite: false,
    queued: false,
    shelves: [],
  };

  async function save(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}/reading`, {
      method: 'PATCH',
      body,
    });
    setPending(false);
    if (result.error || !result.data?.edition) {
      setError(result.error ?? 'internal');
      return;
    }
    onEdition(result.data.edition);
  }

  async function toggleShelf(shelf: ReadingShelf) {
    setPending(true);
    setError(null);
    const result = shelf.included
      ? await api<{ edition: EditionDetail }>(`/api/shelves/${shelf.id}/items/${edition.id}`, { method: 'DELETE' })
      : await api<{ edition: EditionDetail }>(`/api/shelves/${shelf.id}/items`, {
          method: 'POST',
          body: { editionId: edition.id },
        });
    setPending(false);
    if (result.error || !result.data?.edition) {
      setError(result.error ?? 'internal');
      return;
    }
    onEdition(result.data.edition);
  }

  async function createShelf(event: FormEvent) {
    event.preventDefault();
    const name = shelfName.trim();
    if (!name) {
      setError('required');
      return;
    }
    setPending(true);
    setError(null);
    const result = await api<{ edition?: EditionDetail }>(`/api/shelves`, {
      method: 'POST',
      body: { name, editionId: edition.id },
    });
    setPending(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'internal');
      return;
    }
    setShelfName('');
    if (result.data.edition) onEdition(result.data.edition);
  }

  return (
    <section className="import-block">
      <h2>{t('reading.title')}</h2>
      {error ? (
        <p className="alert" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
      <div className="toolbar" role="group" aria-label={t('reading.title')}>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className="button"
            aria-pressed={reading.status === status}
            disabled={pending}
            onClick={() => void save({ status: reading.status === status ? null : status })}
          >
            {t(`reading.${status}`)}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <button
          type="button"
          className="button"
          aria-pressed={reading.favorite}
          disabled={pending}
          onClick={() => void save({ favorite: !reading.favorite })}
        >
          {reading.favorite ? t('reading.unfavorite') : t('reading.favorite')}
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={reading.queued}
          disabled={pending}
          onClick={() => void save({ queued: !reading.queued })}
        >
          {reading.queued ? t('reading.removeQueue') : t('reading.addQueue')}
        </button>
      </div>
      <div className="toolbar" role="group" aria-label={t('reading.rating')}>
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            className="button"
            aria-label={`${t('reading.rating')} ${score}`}
            aria-pressed={reading.rating === score}
            disabled={pending}
            onClick={() => void save({ rating: reading.rating === score ? null : score })}
          >
            {score}
          </button>
        ))}
      </div>
      <h3>{t('reading.shelves')}</h3>
      {reading.shelves.length === 0 ? <p className="placeholder">{t('library.shelvesEmpty')}</p> : null}
      {reading.shelves.length > 0 ? (
        <ul className="plain-list">
          {reading.shelves.map((shelf) => (
            <li key={shelf.id} className="book-row">
              <span>{shelf.name}</span>
              <button type="button" className="button button-secondary" disabled={pending} onClick={() => void toggleShelf(shelf)}>
                {shelf.included ? t('reading.remove') : t('reading.add')} {shelf.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="form" onSubmit={(event) => void createShelf(event)}>
        <label className="field" htmlFor={shelfId}>
          {t('reading.newShelf')}
          <input id={shelfId} value={shelfName} onChange={(event) => setShelfName(event.target.value)} />
        </label>
        <button className="button" type="submit" disabled={pending}>
          {t('reading.createShelf')}
        </button>
      </form>
    </section>
  );
}
