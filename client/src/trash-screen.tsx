import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Loader2, RotateCcw } from 'lucide-react';
import { api, type TrashFile, type TrashListing } from './api';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { CoverArt } from './components/ui/cover-art';
import { Entry } from './components/ui/entry';
import { PageHeader } from './components/ui/page-header';
import { EmptyState, ErrorNotice, LoadingState } from './components/ui/states';
import { useLocale } from './shell';

const ERROR_CODES = new Set(['unauthorized', 'forbidden', 'not_found', 'network', 'internal']);

function errorText(t: (key: string) => string, code: string | null): string {
  if (code === 'not_in_trash' || code === 'last_asset') return t(`trash.errors.${code}`);
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function removedText(t: (key: string) => string, locale: string, value: string): string {
  const date = new Date(value);
  const shown = Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  return fill(t('trash.removed'), { date: shown });
}

function FileFacts({ file }: { file: TrashFile }) {
  const { t } = useLocale();
  return (
    <span className="trash-file-facts">
      <span className="format-text">{file.format.toUpperCase()}</span>
      <span className="trash-storage">{file.storage === 'indexed' ? t('trash.folder') : t('trash.uploaded')}</span>
    </span>
  );
}

type Busy = { key: string; action: 'restore' | 'delete' } | null;
type Note = { tone: 'success' | 'error'; text: string } | null;

/** Removed books and files, admin only. Restore puts them back; delete is permanent after a confirm. */
export function TrashScreen() {
  const { t, locale } = useLocale();
  const baseId = useId();
  const [listing, setListing] = useState<TrashListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note>(null);
  /** A failed permanent delete, shown in its dialog. */
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<TrashListing>('/api/trash').then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        return;
      }
      setError(null);
      setListing(result.data);
    });
    return () => {
      active = false;
    };
  }, [generation]);

  async function act(key: string, action: 'restore' | 'delete', path: string, done: string) {
    setBusy({ key, action });
    setNote(null);
    const result = await api(path, { method: action === 'restore' ? 'POST' : 'DELETE' });
    setBusy(null);
    if (result.error) {
      if (action === 'delete') setDialogError(errorText(t, result.error));
      else setNote({ tone: 'error', text: errorText(t, result.error) });
      return;
    }
    setConfirming(null);
    setNote({ tone: 'success', text: done });
    setGeneration((value) => value + 1);
  }

  function openConfirm(key: string | null) {
    setConfirming(key);
    setDialogError(null);
    setNote(null);
  }

  const books = listing?.editions ?? [];
  const files = listing?.assets ?? [];
  const empty = listing !== null && books.length === 0 && files.length === 0;

  return (
    <div className="trash-page">
      <PageHeader title={t('trash.title')} description={t('trash.lede')} />
      {error ? (
        <ErrorNotice
          message={errorText(t, error)}
          onRetry={() => {
            setError(null);
            setGeneration((value) => value + 1);
          }}
        />
      ) : null}
      {note ? (
        <p className={`alert alert-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
          {note.text}
        </p>
      ) : null}
      {listing === null && !error ? <LoadingState /> : null}
      {empty ? <EmptyState title={t('trash.empty')} description={t('trash.emptyHint')} /> : null}

      {books.length > 0 ? (
        <Entry
          title={t('trash.books')}
          titleId={`${baseId}-books`}
          meta={
            <>
              {t('trash.booksMeta')} · <span className="num">{books.length}</span>
            </>
          }
        >
          <ul className="trash-list">
            {books.map((book) => {
              const key = `edition-${book.id}`;
              const open = confirming === key;
              const triggerId = `${baseId}-${key}-delete`;
              return (
                <li key={key} className="trash-row">
                  <span className="trash-thumb">
                    <CoverArt
                      editionId={book.id}
                      title={book.title}
                      author={book.authors[0]}
                      hasCover={book.hasCover}
                      variant="thumb"
                    />
                  </span>
                  <div className="trash-copy">
                    <span className="trash-title">{book.title}</span>
                    {book.authors.length > 0 ? <span className="trash-byline">{book.authors.join(', ')}</span> : null}
                    <span className="trash-when">
                      <time dateTime={book.trashedAt}>{removedText(t, locale, book.trashedAt)}</time>
                    </span>
                    {book.files.length > 0 ? (
                      <ul className="trash-files" aria-label={t('trash.files')}>
                        {book.files.map((file) => (
                          <li key={file.id}>
                            <span className="trash-file-name">{file.displayFilename}</span>
                            <FileFacts file={file} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <RowActions
                    label={book.title}
                    busy={busy?.key === key ? busy.action : null}
                    disabled={busy !== null}
                    triggerId={triggerId}
                    onRestore={() =>
                      void act(key, 'restore', `/api/editions/${book.id}/restore`, fill(t('trash.restored'), { title: book.title }))
                    }
                    onDelete={() => openConfirm(key)}
                  />
                  {open ? (
                    <ConfirmDialog
                      title={t('trash.deleteTitle')}
                      text={fill(t('trash.deleteBookConfirm'), { title: book.title })}
                      action={t('trash.deleteForever')}
                      cancel={t('trash.cancel')}
                      pending={busy?.key === key && busy.action === 'delete'}
                      error={dialogError}
                      returnFocusId={triggerId}
                      onConfirm={() =>
                        void act(key, 'delete', `/api/editions/${book.id}`, fill(t('trash.deleted'), { title: book.title }))
                      }
                      onCancel={() => openConfirm(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Entry>
      ) : null}

      {files.length > 0 ? (
        <Entry
          title={t('trash.files')}
          titleId={`${baseId}-files`}
          meta={
            <>
              {t('trash.filesMeta')} · <span className="num">{files.length}</span>
            </>
          }
        >
          <ul className="trash-list">
            {files.map((file) => {
              const key = `asset-${file.id}`;
              const open = confirming === key;
              const triggerId = `${baseId}-${key}-delete`;
              const base = `/api/editions/${file.editionId}/assets/${file.id}`;
              return (
                <li key={key} className="trash-row trash-row-file">
                  <div className="trash-copy">
                    <span className="trash-title">{file.displayFilename}</span>
                    <span className="trash-byline">
                      {t('trash.fromBook')}{' '}
                      <Link className="text-link" to={`/books/${file.editionId}`}>
                        {file.editionTitle}
                      </Link>
                    </span>
                    <span className="trash-when">
                      <FileFacts file={file} />
                      <time dateTime={file.trashedAt}>{removedText(t, locale, file.trashedAt)}</time>
                    </span>
                  </div>
                  <RowActions
                    label={file.displayFilename}
                    busy={busy?.key === key ? busy.action : null}
                    disabled={busy !== null}
                    triggerId={triggerId}
                    onRestore={() =>
                      void act(key, 'restore', `${base}/restore`, fill(t('trash.restored'), { title: file.displayFilename }))
                    }
                    onDelete={() => openConfirm(key)}
                  />
                  {open ? (
                    <ConfirmDialog
                      title={t('trash.deleteTitle')}
                      text={fill(t('trash.deleteFileConfirm'), { name: file.displayFilename })}
                      action={t('trash.deleteForever')}
                      cancel={t('trash.cancel')}
                      pending={busy?.key === key && busy.action === 'delete'}
                      error={dialogError}
                      returnFocusId={triggerId}
                      onConfirm={() => void act(key, 'delete', base, fill(t('trash.deleted'), { title: file.displayFilename }))}
                      onCancel={() => openConfirm(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Entry>
      ) : null}
    </div>
  );
}

function RowActions({
  label,
  busy,
  disabled,
  triggerId,
  onRestore,
  onDelete,
}: {
  label: string;
  busy: 'restore' | 'delete' | null;
  disabled: boolean;
  triggerId: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="trash-actions">
      <button
        className="btn btn-sm"
        type="button"
        disabled={disabled}
        aria-label={`${t('trash.restore')}: ${label}`}
        onClick={onRestore}
      >
        {busy === 'restore' ? (
          <Loader2 className="spin" size={14} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
        )}
        {t('trash.restore')}
      </button>
      <button
        className="btn btn-sm btn-danger"
        type="button"
        disabled={disabled}
        aria-label={`${t('trash.deleteForever')}: ${label}`}
        id={triggerId}
        aria-haspopup="dialog"
        onClick={onDelete}
      >
        {t('trash.deleteForever')}
      </button>
    </div>
  );
}
