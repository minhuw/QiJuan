import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertCircle, Check, CheckCircle2, Clock, Loader2, Upload } from 'lucide-react';
import { api, apiForm, type EditionDetail, type ImportItem, type ImportJob, type LibraryInfo } from './api';
import { FileField } from './components/ui/file-field';
import { schemeLabel } from './components/ui/identifiers';
import { Entry } from './components/ui/entry';
import { PageHeader } from './components/ui/page-header';
import { StateTag, jobTone } from './components/ui/status-mark';
import { EmptyState, ErrorNotice, LoadingState } from './components/ui/states';
import { TrajectoryDisclosure } from './components/ui/trajectory';
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
  'invalid_path',
  'library_mode',
  'metadata_incomplete',
  'metadata_assistant_unconfigured',
]);

const ITEM_ERRORS = new Set([
  'unsupported',
  'malformed',
  'missing',
  'metadata_incomplete',
  'metadata_assistant_unconfigured',
]);
const ITEM_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'duplicate', 'needs_confirmation'] as const;
const CONFLICTS = new Set(['title', 'authors', 'format', 'ambiguous']);

type ResolveAction = 'merge' | 'keep-separate';

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

/** "Keep private from the metadata agent" for one import batch. */
function PrivateField({
  checked,
  hintId,
  onChange,
}: {
  checked: boolean;
  hintId: string;
  onChange: (value: boolean) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="private-field">
      <label className="check-row">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{t('metadataPrivate.label')}</span>
      </label>
      <p className="hint" id={hintId}>
        {t('metadataPrivate.hint')}
      </p>
    </div>
  );
}

function StatusIcon({ status }: { status: ImportJob['status'] }) {
  if (status === 'succeeded') return <CheckCircle2 size={13} strokeWidth={1.5} aria-hidden="true" />;
  if (status === 'failed') return <AlertCircle size={13} strokeWidth={1.5} aria-hidden="true" />;
  if (status === 'running') return <Loader2 className="spin" size={13} strokeWidth={1.5} aria-hidden="true" />;
  return <Clock size={13} strokeWidth={1.5} aria-hidden="true" />;
}

export function ImportScreen({
  libraries,
  role = 'reader',
}: {
  libraries: LibraryInfo[];
  role?: 'admin' | 'reader';
}) {
  const { t } = useLocale();
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [libraryId, setLibraryId] = useState(libraries[0]?.id ?? 0);
  const [folder, setFolder] = useState('');
  /** The batch's choice: keep these files away from the metadata assistant. */
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [pending, setPending] = useState(false);
  const [resolving, setResolving] = useState<{ itemId: number; action: ResolveAction } | null>(null);
  const [resolveError, setResolveError] = useState<{ itemId: number; code: string } | null>(null);
  /** Decisions made on this screen, shown on their rows after the block closes. */
  const [resolved, setResolved] = useState<Record<number, string>>({});
  const [announcement, setAnnouncement] = useState('');
  /** The books waiting items matched, for the side-by-side comparison. */
  const [candidates, setCandidates] = useState<Record<number, EditionDetail | 'error'>>({});
  const requested = useRef(new Set<number>());
  const focusResolved = useRef<number | null>(null);
  const fileId = useId();
  const libraryFieldId = useId();
  const folderId = useId();
  const resolvedId = useId();
  const privateHintId = useId();

  const selected = libraries.find((library) => library.id === libraryId) ?? libraries[0];
  const running = jobs?.some((job) => job.status === 'queued' || job.status === 'running') ?? false;

  useEffect(() => {
    let active = true;
    void api<{ jobs: ImportJob[] }>('/api/jobs').then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        setJobs(null);
        return;
      }
      setError(null);
      setJobs(result.data.jobs);
    });
    return () => {
      active = false;
    };
  }, [generation]);

  useEffect(() => {
    if (role !== 'admin' || !jobs) return;
    for (const job of jobs) {
      for (const item of job.items) {
        const id = item.status === 'needs_confirmation' ? item.candidateEditionId : null;
        if (!id || requested.current.has(id)) continue;
        requested.current.add(id);
        void api<{ edition: EditionDetail }>(`/api/editions/${id}`).then((result) => {
          const edition = result.data?.edition;
          setCandidates((current) => ({ ...current, [id]: edition ?? 'error' }));
        });
      }
    }
  }, [jobs, role]);

  // After a decision the block closes; keep focus on the note that replaced it.
  useEffect(() => {
    const itemId = focusResolved.current;
    if (itemId === null) return;
    focusResolved.current = null;
    document.getElementById(`${resolvedId}-${itemId}`)?.focus();
  }, [resolved, resolvedId]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setGeneration((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, [running]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!selected || selected.mode !== 'managed') {
      setFormError('library_mode');
      return;
    }
    const input = event.currentTarget.querySelector('input[type="file"]');
    const files = input instanceof HTMLInputElement ? input.files : null;
    if (!files || files.length === 0) {
      setFormError('required');
      return;
    }
    const body = new FormData();
    for (const file of files) body.append('files', file);
    setPending(true);
    setFormError(null);
    const query = `libraryId=${selected.id}${keepPrivate ? '&private=1' : ''}`;
    const result = await apiForm<{ job: ImportJob }>(`/api/imports?${query}`, body);
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    if (input instanceof HTMLInputElement) input.value = '';
    setGeneration((value) => value + 1);
  }

  async function importFolder(event: FormEvent) {
    event.preventDefault();
    if (!selected || selected.mode !== 'indexed') {
      setFormError('library_mode');
      return;
    }
    if (folder.trim() === '') {
      setFormError('required');
      return;
    }
    setPending(true);
    setFormError(null);
    const result = await api<{ job: ImportJob }>('/api/imports/folder', {
      method: 'POST',
      body: { libraryId: selected.id, path: folder.trim(), ...(keepPrivate ? { private: true } : {}) },
    });
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setFolder('');
    setGeneration((value) => value + 1);
  }

  async function resolve(job: ImportJob, item: ImportItem, action: ResolveAction) {
    setResolving({ itemId: item.id, action });
    setResolveError(null);
    setAnnouncement('');
    const result = await api<{ job: ImportJob }>(`/api/jobs/${job.id}/items/${item.id}/${action}`, { method: 'POST' });
    setResolving(null);
    if (result.error) {
      setResolveError({ itemId: item.id, code: result.error });
      return;
    }
    const candidate = item.candidateEditionId ? candidates[item.candidateEditionId] : undefined;
    const title = candidate && candidate !== 'error' ? candidate.title : '';
    const note =
      action === 'merge'
        ? t('import.resolve.merged').replace('{title}', title || `#${item.candidateEditionId ?? ''}`)
        : t('import.resolve.separated');
    focusResolved.current = item.id;
    setResolved((current) => ({ ...current, [item.id]: note }));
    setAnnouncement(note);
    const next = result.data?.job;
    if (next) setJobs((current) => current?.map((entry) => (entry.id === next.id ? next : entry)) ?? current);
    setGeneration((value) => value + 1);
  }

  return (
    <div className="import-page">
      <PageHeader
        title={t('import.title')}
        description={t('import.subtitle')}
      />

      {error && jobs === null ? (
        <ErrorNotice
          message={t('import.error')}
          onRetry={() => {
            setError(null);
            setGeneration((value) => value + 1);
          }}
        />
      ) : null}

      <div className="import-layout">
        <Entry
          title={t('import.newImport')}
          titleId="import-form-heading"
          className="import-form-panel"
          meta={
            running ? (
              <StateTag tone="warning">
                <Loader2 className="spin" size={12} strokeWidth={1.5} aria-hidden="true" />
                {t('import.status.running')}
              </StateTag>
            ) : null
          }
        >
          {libraries.length === 0 ? (
            <EmptyState compact title={t('import.noLibraries')} />
          ) : (
            <>
              <div className="field">
                <label htmlFor={libraryFieldId}>{t('import.library')}</label>
                <select
                  id={libraryFieldId}
                  value={selected?.id ?? ''}
                  onChange={(event) => setLibraryId(Number(event.target.value))}
                >
                  {libraries.map((library) => (
                    <option key={library.id} value={library.id}>
                      {library.name}
                    </option>
                  ))}
                </select>
                {selected ? (
                  <p className="hint">
                    {selected.mode === 'managed' ? t('import.managedHint') : t('import.indexedHint')}
                  </p>
                ) : null}
              </div>

              {formError ? (
                <div className="alert alert-error" role="alert">
                  {errorText(t, formError)}
                </div>
              ) : null}

              {selected?.mode === 'managed' ? (
                <form className="form" noValidate onSubmit={(event) => void upload(event)}>
                  <FileField
                    id={fileId}
                    name="files"
                    label={t('import.files')}
                    chooseLabel={t('import.choose')}
                    emptyLabel={t('import.none')}
                    multiple
                  />
                  <PrivateField
                    checked={keepPrivate}
                    hintId={privateHintId}
                    onChange={setKeepPrivate}
                  />
                  <button className="btn btn-primary" type="submit" disabled={pending}>
                    <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('import.upload')}
                  </button>
                </form>
              ) : (
                <form className="form" noValidate onSubmit={(event) => void importFolder(event)}>
                  <div className="field">
                    <label htmlFor={folderId}>{t('import.folder')}</label>
                    <input
                      id={folderId}
                      type="text"
                      value={folder}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setFolder(event.target.value)}
                    />
                    <p className="hint">{t('import.folderHint')}</p>
                  </div>
                  <PrivateField
                    checked={keepPrivate}
                    hintId={privateHintId}
                    onChange={setKeepPrivate}
                  />
                  <button className="btn btn-primary" type="submit" disabled={pending}>
                    <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('import.folderSubmit')}
                  </button>
                </form>
              )}
            </>
          )}
        </Entry>

        <Entry
          title={t('import.history')}
          titleId="import-history-heading"
          className="import-history-panel"
          meta={jobs ? <span className="num">{jobs.length}</span> : null}
        >
          {running ? (
            <p className="alert alert-info" role="status">
              <Loader2 className="spin" size={16} strokeWidth={1.5} aria-hidden="true" />
              {t('import.running')}
            </p>
          ) : null}
          <p className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          {jobs === null && !error ? <LoadingState /> : null}
          {jobs && jobs.length === 0 ? (
            <EmptyState
              compact
              title={t('import.empty')}
              description={t('import.emptyHint')}
            />
          ) : null}
          {jobs?.map((job) => {
            const done =
              job.summary.succeeded + job.summary.failed + job.summary.duplicate + (job.summary.needs_confirmation ?? 0);
            const percent = job.summary.total > 0 ? Math.round((done / job.summary.total) * 100) : 0;
            return (
              <article key={job.id} className="job-card">
                <div className="job-head">
                  <div>
                    <h3>{t('import.summary')}</h3>
                    <p className="job-source">
                      {t('import.source')} · {job.source}
                    </p>
                  </div>
                  <StateTag tone={jobTone(job.status)}>
                    <StatusIcon status={job.status} />
                    {t(`import.status.${job.status}`)}
                  </StateTag>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <span className={`progress-fill progress-${job.status}`} style={{ width: `${percent}%` }} />
                </div>
                <dl className="summary-grid">
                  {ITEM_STATUSES.map((status) => (
                    <div key={status} className="summary-cell">
                      <dt>{t(`import.status.${status}`)}</dt>
                      {/* A state colour only marks a count that is there; a zero stays ink. */}
                      <dd className={(job.summary[status] ?? 0) > 0 ? `num status-${status}` : 'num'}>
                        {job.summary[status] ?? 0}
                      </dd>
                    </div>
                  ))}
                </dl>
                <ul className="import-list">
                  {job.items.map((item) => (
                    <li key={item.id} className="import-row">
                      <span className="import-name">{item.filename}</span>
                      <span className={`import-status status-${item.status}`}>
                        {t(`import.status.${item.status}`)}
                        {item.error && ITEM_ERRORS.has(item.error) ? ` · ${t(`import.fileError.${item.error}`)}` : ''}
                        {item.status === 'succeeded' && item.merged ? ` · ${t('import.merged')}` : ''}
                        {item.error === 'metadata_assistant_unconfigured' && role === 'admin' ? (
                          <>
                            {' · '}
                            <Link className="text-link import-settings-link" to="/settings">
                              {t('import.settingsLink')}
                            </Link>
                          </>
                        ) : null}
                      </span>
                      {item.status === 'needs_confirmation' ? (
                        role === 'admin' ? (
                          <ConfirmMatch
                            item={item}
                            candidate={item.candidateEditionId ? candidates[item.candidateEditionId] : undefined}
                            pending={resolving?.itemId === item.id ? resolving.action : null}
                            disabled={resolving !== null}
                            error={resolveError?.itemId === item.id ? resolveError.code : null}
                            onResolve={(action) => void resolve(job, item, action)}
                          />
                        ) : (
                          <div className="import-resolve">
                            <p className="hint">
                              {item.candidateEditionId ? (
                                <Link className="text-link" to={`/books/${item.candidateEditionId}`}>
                                  {t('import.resolve.candidate').replace('{id}', String(item.candidateEditionId))}
                                </Link>
                              ) : null}
                              {(item.conflicts ?? [])
                                .filter((reason) => CONFLICTS.has(reason))
                                .map((reason) => ` · ${t(`import.conflict.${reason}`)}`)
                                .join('')}
                            </p>
                            <p className="hint">{t('import.resolve.waiting')}</p>
                          </div>
                        )
                      ) : null}
                      {resolved[item.id] && item.status !== 'needs_confirmation' ? (
                        <p className="import-resolved" id={`${resolvedId}-${item.id}`} tabIndex={-1}>
                          <Check size={14} strokeWidth={1.5} aria-hidden="true" />
                          {resolved[item.id]}
                        </p>
                      ) : null}
                      {item.trajectoryId ? (
                        <TrajectoryDisclosure
                          trajectoryId={item.trajectoryId}
                          stepCount={item.trajectoryStepCount}
                          active={item.status === 'running' || item.status === 'queued'}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </Entry>
      </div>
    </div>
  );
}

/** The file's format: from the server's summary, else from the file name. */
function incomingFormat(item: ImportItem): string | null {
  if (item.incoming) return item.incoming.format.toUpperCase();
  const match = /\.(epub|pdf)$/i.exec(item.filename);
  return match ? match[1]!.toUpperCase() : null;
}

/** Plain-language lede for a match that was not merged on its own. */
function confirmLede(t: (key: string) => string, item: ImportItem): string[] {
  const scheme = item.incoming ? schemeLabel(t, item.incoming.identifier.scheme) : t('import.confirm.anyScheme');
  const conflicts = new Set(item.conflicts ?? []);
  const key =
    conflicts.has('title') && conflicts.has('authors')
      ? 'both'
      : conflicts.has('title')
        ? 'title'
        : conflicts.has('authors')
          ? 'authors'
          : 'same';
  const sentences = [t(`import.confirm.${key}`).replace('{scheme}', scheme)];
  const format = incomingFormat(item);
  if (conflicts.has('format') && format) sentences.push(t('import.confirm.format').replace('{format}', format));
  if (conflicts.has('ambiguous')) sentences.push(t('import.confirm.ambiguous'));
  return sentences;
}

/**
 * A file that shares an identifier with a book in the library but differs from
 * it: the two side by side, the differing fields marked, and the two decisions.
 */
function ConfirmMatch({
  item,
  candidate,
  pending,
  disabled,
  error,
  onResolve,
}: {
  item: ImportItem;
  candidate: EditionDetail | 'error' | undefined;
  pending: ResolveAction | null;
  disabled: boolean;
  error: string | null;
  onResolve: (action: ResolveAction) => void;
}) {
  const { t } = useLocale();
  const ledeId = useId();
  const conflicts = new Set(item.conflicts ?? []);
  const existing = candidate && candidate !== 'error' ? candidate : null;
  const incoming = item.incoming;
  const unknown = <span className="confirm-unknown">{t('import.confirm.unknown')}</span>;
  const existingFormats = existing
    ? [...new Set(existing.assets.map((asset) => asset.format.toUpperCase()))].join(' · ')
    : null;
  const rows: Array<{ key: string; label: string; conflict: boolean; mine: ReactNode; theirs: ReactNode }> = [
    {
      key: 'title',
      label: t('book.title'),
      conflict: conflicts.has('title'),
      mine: incoming?.title ?? (incoming ? unknown : item.filename),
      theirs: existing ? (
        <Link className="text-link confirm-title" to={`/books/${existing.id}`}>
          {existing.title}
        </Link>
      ) : null,
    },
    {
      key: 'authors',
      label: t('book.authors'),
      conflict: conflicts.has('authors'),
      mine: incoming && incoming.authors.length > 0 ? incoming.authors.join(', ') : unknown,
      theirs: existing ? existing.authors.join(', ') || unknown : null,
    },
    {
      key: 'format',
      label: t('import.confirm.format_label'),
      conflict: conflicts.has('format'),
      mine: <span className="format-text">{incomingFormat(item) ?? ''}</span>,
      theirs: existing ? <span className="format-text">{existingFormats}</span> : null,
    },
  ];
  const errorMessage = error === 'not_found' ? t('import.resolve.gone') : t('import.resolve.error');
  return (
    <div
      className="confirm-block"
      role="group"
      aria-labelledby={ledeId}
      aria-busy={pending ? true : undefined}
    >
      <p className="confirm-lede" id={ledeId}>
        {confirmLede(t, item).join(' ')}
      </p>
      {candidate === 'error' ? null : (
        <table className="confirm-compare">
          <thead>
            <tr>
              <td />
              <th scope="col">{t('import.confirm.incoming')}</th>
              <th scope="col">{t('import.confirm.existing')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={row.conflict ? 'confirm-conflict' : undefined}>
                <th scope="row">
                  <span className="confirm-mark" aria-hidden="true" />
                  {row.label}
                  {row.conflict ? <span className="visually-hidden"> ({t('import.confirm.differs')})</span> : null}
                </th>
                <td>{row.mine}</td>
                <td>{existing ? row.theirs : <span className="confirm-unknown">{t('import.confirm.loading')}</span>}</td>
              </tr>
            ))}
            {incoming ? (
              <tr className="confirm-matched">
                <th scope="row">
                  <span className="confirm-mark" aria-hidden="true" />
                  {t('import.confirm.matched')}
                </th>
                <td colSpan={2}>
                  <span className="confirm-scheme">{schemeLabel(t, incoming.identifier.scheme)}</span>{' '}
                  <span className="num">{incoming.identifier.value}</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <div className="confirm-actions">
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={() => onResolve('merge')}>
          {pending === 'merge' ? <Loader2 className="spin" size={14} strokeWidth={1.5} aria-hidden="true" /> : null}
          {t('import.resolve.merge')}
        </button>
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={() => onResolve('keep-separate')}>
          {pending === 'keep-separate' ? (
            <Loader2 className="spin" size={14} strokeWidth={1.5} aria-hidden="true" />
          ) : null}
          {t('import.resolve.separate')}
        </button>
        {item.candidateEditionId ? (
          <Link className="text-link confirm-open" to={`/books/${item.candidateEditionId}`}>
            {t('import.confirm.open')}
          </Link>
        ) : null}
        {pending ? <span className="hint-inline">{t('import.resolve.pending')}</span> : null}
      </div>
      {error ? (
        <p className="alert alert-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
