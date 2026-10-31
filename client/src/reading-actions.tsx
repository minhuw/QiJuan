import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BookMarked, ChevronLeft, ChevronRight, Heart, ListPlus, Plus, Star } from 'lucide-react';
import { api, type EditionDetail, type ReadingShelf, type ReadingStatus } from './api';
import { StatusMark } from './components/ui/status-mark';
import { useLocale } from './shell';

/** The stepper's sequence: no status first, then the states in reading order, ending on finished. */
const STEPS: (ReadingStatus | null)[] = [null, 'want', 'reading', 'on_hold', 'finished'];
/** The progress line's stages, with the locale key of each one's short name. */
const STAGES = [
  { status: 'want', name: 'reading.stageWant' },
  { status: 'reading', name: 'reading.stageReading' },
  { status: 'finished', name: 'reading.stageDone' },
] as const;
/** How far along the progress line each status reaches: the current stage's position, -1 for none. */
const STAGE_OF: Record<ReadingStatus, number> = { want: 0, reading: 1, on_hold: 1, finished: 2 };
/** How long the stepper waits after the last step before saving. */
const STATUS_SAVE_DELAY = 500;
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
  const [pending, setPending] = useState(false);
  /** A status save in flight; it holds the other controls, not the stepper. */
  const [statusPending, setStatusPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || statusPending;
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

  async function saveStatus(status: ReadingStatus | null, leaving: boolean): Promise<boolean> {
    if (leaving) {
      // The page or the book is going away: send, and leave its state alone.
      const result = await api(`/api/editions/${edition.id}/reading`, { method: 'PATCH', body: { status }, keepalive: true });
      return !result.error;
    }
    setStatusPending(true);
    setError(null);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}/reading`, {
      method: 'PATCH',
      body: { status },
    });
    setStatusPending(false);
    if (result.error || !result.data?.edition) {
      setError(result.error ?? 'internal');
      return false;
    }
    onEdition(result.data.edition);
    return true;
  }

  return (
    <section className="reading-panel" aria-label={t('reading.title')}>
      {error ? (
        <div className="alert alert-error" role="alert">
          {errorText(t, error)}
        </div>
      ) : null}

      <StatusStepper key={edition.id} status={reading.status ?? null} onSave={saveStatus} />

      <div className="reading-actions">
        <button
          type="button"
          className={reading.favorite ? 'btn btn-icon is-on' : 'btn btn-icon'}
          aria-label={reading.favorite ? t('reading.unfavorite') : t('reading.favorite')}
          title={reading.favorite ? t('reading.unfavorite') : t('reading.favorite')}
          aria-pressed={reading.favorite}
          disabled={busy}
          onClick={() => void save({ favorite: !reading.favorite })}
        >
          <Heart size={16} strokeWidth={1.5} fill={reading.favorite ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={reading.queued ? 'btn btn-icon is-on' : 'btn btn-icon'}
          aria-label={reading.queued ? t('reading.removeQueue') : t('reading.addQueue')}
          title={reading.queued ? t('reading.removeQueue') : t('reading.addQueue')}
          aria-pressed={reading.queued}
          disabled={busy}
          onClick={() => void save({ queued: !reading.queued })}
        >
          <ListPlus size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <div className="rating-control" role="group" aria-label={t('reading.rating')}>
          {[1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              className={reading.rating && score <= reading.rating ? 'rating-star rating-star-on' : 'rating-star'}
              aria-label={`${t('reading.rating')} ${score}`}
              aria-pressed={reading.rating === score}
              disabled={busy}
              onClick={() => void save({ rating: reading.rating === score ? null : score })}
            >
              <Star size={16} strokeWidth={1.5} fill={reading.rating && score <= reading.rating ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The book's shelves as one outline button that opens a panel below it (a disclosure, not a menu:
 * the panel holds toggle buttons and a form). The button names the one shelf holding the book, or
 * counts them when there are several. Escape or a press outside folds the panel; Escape returns
 * focus to the button, and tabbing out of the panel folds it.
 */
export function ShelfMenu({
  edition,
  onEdition,
}: {
  edition: EditionDetail;
  onEdition: (edition: EditionDetail) => void;
}) {
  const { t } = useLocale();
  const shelfId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [shelfName, setShelfName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shelves = edition.reading?.shelves ?? [];
  const included = shelves.filter((shelf) => shelf.included);

  // A press outside folds the panel without moving focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

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

  const label =
    included.length === 1
      ? t('reading.shelvesOne').replace('{name}', included[0].name)
      : included.length > 1
        ? t('reading.shelvesMany').replace('{count}', String(included.length))
        : undefined;

  return (
    <div
      className="shelf-menu-root"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }}
      onBlur={(event) => {
        // Focus moving to something outside (Tab past the panel) folds it; a press on a blank
        // part of the panel has no related target and is left to the outside-press handler.
        const next = event.relatedTarget as Node | null;
        if (open && next && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn shelf-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <BookMarked size={15} strokeWidth={1.5} aria-hidden="true" />
        {included.length === 1 ? (
          <span className="shelf-trigger-label shelf-trigger-name">{included[0].name}</span>
        ) : (
          <span className="shelf-trigger-label">
            {t('reading.shelves')}
            {included.length > 1 ? <span className="shelf-trigger-count"> · {included.length}</span> : null}
          </span>
        )}
        <span className="menu-caret" aria-hidden="true" />
      </button>
      <div className="reading-menu shelf-menu" id={panelId} role="group" aria-label={t('reading.shelves')} hidden={!open}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {errorText(t, error)}
          </div>
        ) : null}
        {shelves.length === 0 ? <p className="hint">{t('library.shelvesEmpty')}</p> : null}
        {shelves.length > 0 ? (
          <ul className="reading-shelf-list">
            {shelves.map((shelf) => (
              <li key={shelf.id} className="reading-shelf-row">
                <span className="reading-shelf-name">
                  <BookMarked size={14} strokeWidth={1.5} aria-hidden="true" />
                  {shelf.name}
                </span>
                <button
                  type="button"
                  className={shelf.included ? 'btn btn-sm is-on' : 'btn btn-sm'}
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
          <button className="btn" type="submit" disabled={pending}>
            <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
            {t('reading.createShelf')}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The reading status as a stepper: the current status, named in full, between a previous and a
 * next chevron, over a three-stage progress line (want, reading, done) that fills as the reading
 * goes on and turns dashed while it is on hold. The sequence is none, want, reading, on hold,
 * finished, with no wrapping.
 * Each step shows at once; the save waits until the steps stop and sends only the final state,
 * nothing when that is the saved one. Steps keep working while a save is in flight and queue the
 * next save behind it. A failed save falls back to the last saved state. Leaving the page, or the
 * book, sends a pending step at once.
 */
function StatusStepper({
  status,
  onSave,
}: {
  status: ReadingStatus | null;
  /** Saves a status; `leaving` sends it as the page goes away, with no result to show. */
  onSave: (status: ReadingStatus | null, leaving: boolean) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [shown, setShown] = useState(status);
  /** The direction of the last step, which the label slides in from; none when nothing moved. */
  const [travel, setTravel] = useState<-1 | 1 | null>(null);
  const saved = useRef(status);
  const draft = useRef(status);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<void> | null>(null);
  const left = useRef(false);
  const save = useRef(onSave);

  useEffect(() => {
    save.current = onSave;
  });

  // A status from the server (a save landing, or a fresh load) shows unless a step is waiting.
  useEffect(() => {
    saved.current = status;
    if (timer.current !== null || queue.current !== null) return;
    draft.current = status;
    setTravel(null);
    setShown(status);
  }, [status]);

  function clearTimer() {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }

  function send() {
    clearTimer();
    const run = async () => {
      const target = draft.current;
      if (target === saved.current) return;
      if (left.current) {
        saved.current = target;
        await save.current(target, true);
        return;
      }
      if (await save.current(target, false)) {
        saved.current = target;
        return;
      }
      clearTimer();
      draft.current = saved.current;
      setTravel(null);
      setShown(saved.current);
    };
    // With nothing in flight the request starts now, so a save sent on the way out is not left behind.
    const next = queue.current ? queue.current.then(run) : run();
    queue.current = next;
    void next.then(() => {
      if (queue.current === next) queue.current = null;
    });
  }

  // Leaving the page or the book sends a waiting step straight away.
  useEffect(() => {
    left.current = false;
    const flush = () => {
      if (timer.current === null) return;
      left.current = true;
      send();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      left.current = true;
      if (timer.current !== null) send();
    };
  }, []);

  function step(delta: -1 | 1) {
    const index = STEPS.indexOf(draft.current) + delta;
    if (index < 0 || index >= STEPS.length) return;
    left.current = false;
    draft.current = STEPS[index];
    setTravel(delta);
    setShown(STEPS[index]);
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      send();
    }, STATUS_SAVE_DELAY);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else return;
    event.preventDefault();
  }

  const name = (value: ReadingStatus | null) => (value ? t(`reading.${value}`) : t('reading.noStatus'));
  const index = STEPS.indexOf(shown);
  const previous = index > 0 ? STEPS[index - 1] : undefined;
  const next = index < STEPS.length - 1 ? STEPS[index + 1] : undefined;

  return (
    <div className="status-stepper" role="group" aria-label={t('reading.statusGroup')} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="status-step"
        aria-disabled={previous === undefined || undefined}
        aria-label={
          previous === undefined
            ? t('reading.previousStatus')
            : t('reading.previousStatusTo').replace('{status}', name(previous))
        }
        onClick={() => step(-1)}
      >
        <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <div className="status-stepper-now">
        <span className="status-stepper-label" role="status" aria-live="polite">
          <span
            key={shown ?? 'none'}
            className={travel === null ? 'status-stepper-value' : `status-stepper-value status-stepper-from-${travel < 0 ? 'next' : 'previous'}`}
          >
            {shown ? <StatusMark status={shown} /> : <span className="status-stepper-empty">{t('reading.noStatus')}</span>}
          </span>
        </span>
        <StatusProgress status={shown} />
      </div>
      <button
        type="button"
        className="status-step"
        aria-disabled={next === undefined || undefined}
        aria-label={next === undefined ? t('reading.nextStatus') : t('reading.nextStatusTo').replace('{status}', name(next))}
        onClick={() => step(1)}
      >
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The stepper's progress line: three equal segments for want, reading and done, each over its
 * short name. Segments up to the current stage are filled ink; on hold draws want and reading as a
 * dashed line instead. The line repeats the label, so assistive technology skips it.
 */
function StatusProgress({ status }: { status: ReadingStatus | null }) {
  const { t } = useLocale();
  const reached = status ? STAGE_OF[status] : -1;
  const paused = status === 'on_hold';
  return (
    <span className="status-progress" data-status={status ?? 'none'} aria-hidden="true">
      {STAGES.map((stage, position) => (
        <span
          key={stage.status}
          className="status-progress-stage"
          data-fill={position > reached ? 'empty' : paused ? 'paused' : 'solid'}
          data-current={position === reached || undefined}
        >
          <span className="status-progress-segment" />
          <span className="status-progress-name">{t(stage.name)}</span>
        </span>
      ))}
    </span>
  );
}
