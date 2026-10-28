import { useId, useState, type FormEvent } from 'react';
import { BookMarked, Heart, ListPlus, Plus, Star } from 'lucide-react';
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
    <section className="panel reading-panel">
      <div className="panel-head">
        <div>
          <p className="section-kicker">{t('reading.status')}</p>
          <h2>{t('reading.title')}</h2>
        </div>
        {reading.rating ? (
          <span className="rating-summary" aria-hidden="true">
            <Star size={14} fill="currentColor" />
            {reading.rating}/5
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="alert alert-error" role="alert">
          {errorText(t, error)}
        </div>
      ) : null}

      <div className="status-segments" role="group" aria-label={t('reading.title')}>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={`segment segment-${status}`}
            aria-pressed={reading.status === status}
            disabled={pending}
            onClick={() => void save({ status: reading.status === status ? null : status })}
          >
            <span className="status-dot" aria-hidden="true" />
            {t(`reading.${status}`)}
          </button>
        ))}
      </div>

      <div className="reading-actions">
        <button
          type="button"
          className={reading.favorite ? 'btn btn-secondary is-on' : 'btn btn-secondary'}
          aria-pressed={reading.favorite}
          disabled={pending}
          onClick={() => void save({ favorite: !reading.favorite })}
        >
          <Heart size={16} fill={reading.favorite ? 'currentColor' : 'none'} aria-hidden="true" />
          {reading.favorite ? t('reading.unfavorite') : t('reading.favorite')}
        </button>
        <button
          type="button"
          className={reading.queued ? 'btn btn-secondary is-on' : 'btn btn-secondary'}
          aria-pressed={reading.queued}
          disabled={pending}
          onClick={() => void save({ queued: !reading.queued })}
        >
          <ListPlus size={16} aria-hidden="true" />
          {reading.queued ? t('reading.removeQueue') : t('reading.addQueue')}
        </button>
        <div className="rating-control" role="group" aria-label={t('reading.rating')}>
          {[1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              className={reading.rating && score <= reading.rating ? 'rating-star rating-star-on' : 'rating-star'}
              aria-label={`${t('reading.rating')} ${score}`}
              aria-pressed={reading.rating === score}
              disabled={pending}
              onClick={() => void save({ rating: reading.rating === score ? null : score })}
            >
              <Star size={17} fill={reading.rating && score <= reading.rating ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <div className="shelf-block">
        <h3>{t('reading.shelves')}</h3>
        {reading.shelves.length === 0 ? <p className="hint">{t('library.shelvesEmpty')}</p> : null}
        {reading.shelves.length > 0 ? (
          <ul className="reading-shelf-list">
            {reading.shelves.map((shelf) => (
              <li key={shelf.id} className="reading-shelf-row">
                <span className="reading-shelf-name">
                  <BookMarked size={14} aria-hidden="true" />
                  {shelf.name}
                </span>
                <button
                  type="button"
                  className={shelf.included ? 'btn btn-secondary btn-sm is-on' : 'btn btn-ghost btn-sm'}
                  aria-pressed={shelf.included}
                  disabled={pending}
                  onClick={() => void toggleShelf(shelf)}
                >
                  {shelf.included ? t('reading.remove') : t('reading.add')} {shelf.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="inline-form" onSubmit={(event) => void createShelf(event)}>
          <label className="visually-hidden" htmlFor={shelfId}>
            {t('reading.newShelf')}
          </label>
          <input
            id={shelfId}
            value={shelfName}
            placeholder={t('reading.newShelf')}
            onChange={(event) => setShelfName(event.target.value)}
          />
          <button className="btn btn-secondary" type="submit" disabled={pending}>
            <Plus size={15} aria-hidden="true" />
            {t('reading.createShelf')}
          </button>
        </form>
      </div>
    </section>
  );
}
