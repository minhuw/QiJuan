import { useEffect, useId, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Clock, Files, Loader2, Upload } from 'lucide-react';
import { api, apiForm, type ImportJob, type LibraryInfo } from './api';
import { FileField } from './components/ui/file-field';
import { PageHeader } from './components/ui/page-header';
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
  'payload_too_large',
  'invalid_path',
  'library_mode',
]);

const FILE_ERRORS = new Set(['unsupported', 'malformed', 'missing']);
const ITEM_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'duplicate'] as const;

function errorText(t: (key: string) => string, code: string | null): string {
  const known = code && ERROR_CODES.has(code) ? code : 'internal';
  return t(`errors.${known}`);
}

function StatusIcon({ status }: { status: ImportJob['status'] }) {
  if (status === 'succeeded') return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === 'failed') return <AlertCircle size={14} aria-hidden="true" />;
  if (status === 'running') return <Loader2 className="spin" size={14} aria-hidden="true" />;
  return <Clock size={14} aria-hidden="true" />;
}

export function ImportScreen({ libraries }: { libraries: LibraryInfo[] }) {
  const { t } = useLocale();
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [libraryId, setLibraryId] = useState(libraries[0]?.id ?? 0);
  const [folder, setFolder] = useState('');
  const [pending, setPending] = useState(false);
  const fileId = useId();
  const libraryFieldId = useId();
  const folderId = useId();

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
    const result = await apiForm<{ job: ImportJob }>(`/api/imports?libraryId=${selected.id}`, body);
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
      body: { libraryId: selected.id, path: folder.trim() },
    });
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    setFolder('');
    setGeneration((value) => value + 1);
  }

  return (
    <div className="import-page">
      <PageHeader
        eyebrow={
          <span className="eyebrow">
            <Upload size={13} aria-hidden="true" />
            {t('import.eyebrow')}
          </span>
        }
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
        <section className="panel import-form-panel" aria-labelledby="import-form-heading">
          <div className="panel-head">
            <div>
              <p className="section-kicker">{t('import.upload')}</p>
              <h2 id="import-form-heading">{t('import.newImport')}</h2>
            </div>
            {running ? (
              <span className="status-pill status-pill-running">
                <Loader2 className="spin" size={12} aria-hidden="true" />
                {t('import.status.running')}
              </span>
            ) : null}
          </div>

          {libraries.length === 0 ? (
            <EmptyState icon={<Files size={22} />} title={t('import.noLibraries')} />
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
                  <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
                    <Upload size={16} aria-hidden="true" />
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
                  <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
                    <Upload size={16} aria-hidden="true" />
                    {t('import.folderSubmit')}
                  </button>
                </form>
              )}
            </>
          )}
        </section>

        <section className="panel import-history-panel" aria-labelledby="import-history-heading">
          <div className="panel-head">
            <div>
              <p className="section-kicker">{t('import.progress')}</p>
              <h2 id="import-history-heading">{t('import.history')}</h2>
            </div>
            {jobs ? <span className="section-count">{jobs.length}</span> : null}
          </div>
          {running ? (
            <p className="alert alert-info" role="status">
              <Loader2 className="spin" size={16} aria-hidden="true" />
              {t('import.running')}
            </p>
          ) : null}
          {jobs === null && !error ? <LoadingState /> : null}
          {jobs && jobs.length === 0 ? (
            <EmptyState
              icon={<Files size={22} />}
              title={t('import.empty')}
              description={t('import.emptyHint')}
            />
          ) : null}
          {jobs?.map((job) => {
            const done = job.summary.succeeded + job.summary.failed + job.summary.duplicate;
            const percent = job.summary.total > 0 ? Math.round((done / job.summary.total) * 100) : 0;
            return (
              <article key={job.id} className="job-card">
                <div className="job-head">
                  <div>
                    <p className="section-kicker">
                      {t('import.source')} · {job.source}
                    </p>
                    <h2>{t('import.summary')}</h2>
                  </div>
                  <span className={`status-pill status-pill-${job.status}`}>
                    <StatusIcon status={job.status} />
                    {t(`import.status.${job.status}`)}
                  </span>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <span className={`progress-fill progress-${job.status}`} style={{ width: `${percent}%` }} />
                </div>
                <dl className="summary-grid">
                  {ITEM_STATUSES.map((status) => (
                    <div key={status} className="summary-cell">
                      <dt>
                        <span className={`status-dot status-dot-${status}`} aria-hidden="true" />
                        {t(`import.status.${status}`)}
                      </dt>
                      <dd className={`status-${status}`}>{job.summary[status]}</dd>
                    </div>
                  ))}
                </dl>
                <ul className="import-list">
                  {job.items.map((item) => (
                    <li key={item.id} className="import-row">
                      <span className="import-name">{item.filename}</span>
                      <span className={`import-status status-${item.status}`}>
                        {t(`import.status.${item.status}`)}
                        {item.error && FILE_ERRORS.has(item.error) ? ` · ${t(`import.fileError.${item.error}`)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}
