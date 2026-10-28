import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, apiForm, type ImportJob, type LibraryInfo } from './api';
import { FileField } from './components/ui/file-field';
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
    <>
      <p className="tagline">{t('brand.tagline')}</p>
      <h1>{t('import.title')}</h1>
      <div className="toolbar">
        <Link className="text-link" to="/">
          {t('import.back')}
        </Link>
      </div>
      {error && jobs === null ? (
        <>
          <p className="alert" role="alert">
            {t('import.error')}
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setError(null);
              setGeneration((value) => value + 1);
            }}
          >
            {t('status.retry')}
          </button>
        </>
      ) : null}
      {jobs === null && !error ? <p role="status">{t('status.loading')}</p> : null}
      {jobs && jobs.length === 0 ? <p className="placeholder">{t('import.empty')}</p> : null}
      {running ? (
        <p className="import-progress" role="status">
          {t('import.running')}
        </p>
      ) : null}
      {jobs?.map((job) => (
        <section key={job.id} className="import-block">
          <h2>{t('import.summary')}</h2>
          <dl className="summary-list">
            {ITEM_STATUSES.map((status) => (
              <div key={status} className="summary-row">
                <dt>{t(`import.status.${status}`)}</dt>
                <dd className={`status-${status}`}>{job.summary[status]}</dd>
              </div>
            ))}
          </dl>
          <ul className="import-list">
            {job.items.map((item) => (
              <li key={item.id} className="import-row">
                <span className="import-name">{item.filename}</span>
                <span className={`status-${item.status}`}>
                  {t(`import.status.${item.status}`)}
                  {item.error && FILE_ERRORS.has(item.error) ? ` · ${t(`import.fileError.${item.error}`)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {libraries.length === 0 ? (
        <p className="placeholder">{t('import.noLibraries')}</p>
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
          </div>
          {selected?.mode === 'managed' ? (
            <form className="form" noValidate onSubmit={(event) => void upload(event)}>
              {formError ? (
                <p className="alert" role="alert">
                  {errorText(t, formError)}
                </p>
              ) : null}
              <FileField
                id={fileId}
                name="files"
                label={t('import.files')}
                chooseLabel={t('import.choose')}
                emptyLabel={t('import.none')}
                multiple
              />
              <button className="button" type="submit" disabled={pending}>
                {t('import.upload')}
              </button>
            </form>
          ) : (
            <form className="form" noValidate onSubmit={(event) => void importFolder(event)}>
              {formError ? (
                <p className="alert" role="alert">
                  {errorText(t, formError)}
                </p>
              ) : null}
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
              <button className="button" type="submit" disabled={pending}>
                {t('import.folderSubmit')}
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
