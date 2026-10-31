import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type EditionDetail, type ExternalRating, type RatingProvider } from './api';
import { useLocale } from './shell';

/** How often, and how many times, the page asks again while the ratings worker has the edition queued. */
const RATINGS_POLL_MS = 3000;
const RATINGS_POLL_LIMIT = 20;

const PROVIDER_ORDER: RatingProvider[] = ['douban', 'goodreads', 'open_library', 'google_books'];

type IconProvider = RatingProvider | 'worldcat';

type RatingsUpdate = Pick<EditionDetail, 'ratings' | 'ratingsPending'>;

/**
 * External ratings under the byline, as one compact row: per provider with a score, one inline
 * link to the provider's page (icon, name, score on its own scale, muted count). Providers with a
 * page but no score, and WorldCat, follow on the same row after "Also on", with the admin refresh
 * control.
 */
export function BookRatings({
  edition,
  role,
  onRatings,
}: {
  edition: EditionDetail;
  role: 'admin' | 'reader';
  onRatings: (update: RatingsUpdate) => void;
}) {
  const { t, locale } = useLocale();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const pending = edition.ratingsPending === true;

  // The worker fetches in the background; ask again until it has finished with this edition.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(() => {
        polls += 1;
        void api<{ edition: EditionDetail }>(`/api/editions/${edition.id}`).then((result) => {
          if (!alive) return;
          const next = result.data?.edition;
          if (next) onRatings({ ratings: next.ratings, ratingsPending: next.ratingsPending });
          if ((!next || next.ratingsPending) && polls < RATINGS_POLL_LIMIT) poll();
        });
      }, RATINGS_POLL_MS);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // onRatings changes on every render of the page; polling follows the edition and its pending flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition.id, pending]);

  const admin = role === 'admin';
  const ratings = (edition.ratings ?? [])
    .filter((rating) => rating.rating !== null || (rating.url !== null && safeHttpUrl(rating.url) !== null))
    .sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
  const scored = ratings.filter((rating) => rating.rating !== null);
  const elsewhere: Array<{ provider: IconProvider; href: string }> = [];
  for (const rating of ratings) {
    const href = rating.rating === null && rating.url ? safeHttpUrl(rating.url) : null;
    if (href) elsewhere.push({ provider: rating.provider, href });
  }
  const worldcat = worldcatUrl(edition);
  if (worldcat) elsewhere.push({ provider: 'worldcat', href: worldcat });
  const lookupable = edition.identifiers.some((item) => ['isbn', 'douban', 'olid', 'google_books'].includes(item.scheme));
  // Nothing to show yet on a first fetch: render nothing rather than a block that fills in later.
  const firstFetch = pending && ratings.length === 0;
  const hasEntries = !firstFetch && (scored.length > 0 || elsewhere.length > 0);
  if (!hasEntries && !(admin && lookupable)) return null;

  const updated = latest(edition.ratings ?? []);
  const busy = refreshing || pending;
  const refreshLabel = busy ? t('ratings.refreshing') : t('ratings.refresh');

  async function refresh() {
    setRefreshing(true);
    setRefreshError(false);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}/ratings/refresh`, { method: 'POST' });
    setRefreshing(false);
    const next = result.data?.edition;
    if (!next) {
      setRefreshError(true);
      return;
    }
    onRatings({ ratings: next.ratings, ratingsPending: next.ratingsPending });
  }

  const showCards = hasEntries && scored.length > 0;
  const showElsewhere = hasEntries && elsewhere.length > 0;
  return (
    <div className="book-ratings">
      {showCards ? (
        <ul className="rating-cards" aria-label={t('ratings.label')}>
          {scored.map((rating) => (
            <li key={rating.provider}>
              <RatingCard rating={rating} />
            </li>
          ))}
        </ul>
      ) : null}
      {showElsewhere || admin ? (
        <div className="book-ratings-also">
          {showElsewhere ? (
            <p className="book-ratings-elsewhere">
              <span className="book-ratings-also-label">{t('ratings.alsoOn')}</span>{' '}
              {elsewhere.map((item, index) => (
                <span key={item.provider} className="book-ratings-elsewhere-item">
                  {index > 0 ? <span aria-hidden="true">{' · '}</span> : null}
                  <a className="book-ratings-link" href={item.href} target="_blank" rel="noopener noreferrer">
                    <ProviderIcon provider={item.provider} />
                    {t(`ratings.provider.${item.provider}`)}
                  </a>
                </span>
              ))}
            </p>
          ) : null}
          {admin ? (
            <span className="book-ratings-admin">
              <button
                type="button"
                className="icon-button book-ratings-refresh"
                onClick={() => void refresh()}
                disabled={busy}
                aria-label={refreshLabel}
                title={refreshLabel}
              >
                <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" className={busy ? 'spin' : undefined} />
              </button>
              {refreshError ? (
                <span className="book-ratings-meta" role="alert">
                  {t('ratings.refreshFailed')}
                </span>
              ) : updated ? (
                <span className="book-ratings-meta">{t('ratings.updated').replace('{date}', formatDate(updated, locale))}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One provider's score; the whole entry links to its page. */
function RatingCard({ rating }: { rating: ExternalRating }) {
  const { t, locale } = useLocale();
  const href = rating.url ? safeHttpUrl(rating.url) : null;
  const body = (
    <>
      <span className="rating-card-source">
        <ProviderIcon provider={rating.provider} />
        <span className="rating-card-name">{t(`ratings.provider.${rating.provider}`)}</span>
      </span>
      <span className="rating-card-score">
        <span className="rating-card-value num">{formatScore(rating.rating!, locale)}</span>
        <span className="rating-card-scale num">/{rating.scale}</span>
      </span>
      {rating.count !== null ? (
        <span className="rating-card-count">
          {t(rating.count === 1 ? 'ratings.countOne' : 'ratings.count').replace(
            '{count}',
            new Intl.NumberFormat(locale).format(rating.count),
          )}
        </span>
      ) : null}
    </>
  );
  if (!href) {
    return (
      <div className="rating-card" data-provider={rating.provider}>
        {body}
      </div>
    );
  }
  return (
    <a className="rating-card" data-provider={rating.provider} href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  );
}

/** The provider's own site icon, from the server's cache. Decorative: the name follows it. */
function ProviderIcon({ provider }: { provider: IconProvider }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="provider-icon"
      src={`/api/providers/${provider}/icon`}
      alt=""
      width={16}
      height={16}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** WorldCat by ISBN, unless an identifier already links there. */
function worldcatUrl(edition: EditionDetail): string | null {
  if (edition.identifiers.some((item) => item.url && /(^|\.)worldcat\.org$/.test(hostOf(item.url)))) return null;
  const isbn = edition.identifiers.find((item) => item.scheme === 'isbn' && /^97[89]\d{10}$/.test(item.value));
  return isbn ? `https://search.worldcat.org/search?q=bn:${isbn.value}` : null;
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Douban's 9.3 stays 9.3, Goodreads' 4.08 stays 4.08, and a whole 4 reads 4.0. */
function formatScore(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
}

function latest(ratings: ExternalRating[]): string | null {
  let newest: string | null = null;
  for (const rating of ratings) if (!newest || rating.fetchedAt > newest) newest = rating.fetchedAt;
  return newest;
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}
