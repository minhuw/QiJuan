import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, type MetadataTrajectory, type TrajectoryStep } from '../../api';
import { useLocale } from '../../shell';
import { EmptyState, ErrorNotice, LoadingState } from './states';

type Translate = (key: string) => string;

const OPEN_LIBRARY = 'https://openlibrary.org';
const OPEN_LIBRARY_KEY = /^\/(works\/OL\d+W|books\/OL\d+M|authors\/OL\d+A)$/;

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function OpenLibraryKey({ value }: { value: string }) {
  if (!OPEN_LIBRARY_KEY.test(value)) return <span>{value}</span>;
  return (
    <a className="text-link" href={`${OPEN_LIBRARY}${value}`} target="_blank" rel="noreferrer noopener">
      {value}
    </a>
  );
}

function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** A web address shown as its host and linked to the full URL. */
function HostLink({ url }: { url: URL }) {
  return (
    <a className="text-link" href={url.href} target="_blank" rel="noreferrer noopener" title={url.href}>
      {url.hostname}
    </a>
  );
}

const WEB_STEP_LABELS: Record<string, string> = {
  web_search: 'trajectory.step.webSearch',
  fetch_page: 'trajectory.step.fetchPage',
  google_books: 'trajectory.step.googleBooks',
  page_images: 'trajectory.step.pageImages',
};

interface Source {
  title: string;
  url: URL;
}

interface Row {
  key: string;
  label: string;
  tone?: 'error';
  detail?: ReactNode;
  result?: ReactNode;
  durationMs?: unknown;
  raw: unknown;
  /** Web search results, listed as title and host above the raw JSON. */
  sources?: Source[];
  /** page_images candidates, listed as full URLs above the raw JSON. */
  images?: PageImage[];
  omitted?: boolean;
}

function counted(t: Translate, count: number, kind: 'results' | 'volumes'): string {
  if (kind === 'volumes') {
    return count === 0 ? t('trajectory.noVolumes') : count === 1 ? t('trajectory.oneVolume') : fill(t('trajectory.volumes'), { count });
  }
  return count === 0 ? t('trajectory.noResults') : count === 1 ? t('trajectory.oneResult') : fill(t('trajectory.results'), { count });
}

interface PageImage {
  kind: string;
  url: URL;
}

function pageImageList(result: unknown): PageImage[] {
  const images = record(result)?.images;
  if (!Array.isArray(images)) return [];
  return images.flatMap((item) => {
    const entry = record(item);
    const url = httpUrl(entry?.url);
    return url ? [{ kind: str(entry?.kind) ?? 'img', url }] : [];
  });
}

function searchSources(result: unknown): Source[] {
  const results = record(result)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const entry = record(item);
    const url = httpUrl(entry?.url);
    return url ? [{ title: str(entry?.title) ?? url.hostname, url }] : [];
  });
}

function resultSummary(
  t: Translate,
  name: string,
  summary: Record<string, unknown> | null,
  requestedKey: string | null = null,
): ReactNode {
  if (!summary) return null;
  const error = str(summary.error);
  if (error) {
    const detail = str(summary.detail);
    return (
      <>
        <span className="trajectory-error">{fill(t('trajectory.toolError'), { code: error })}</span>
        {detail ? ` · ${detail}` : null}
      </>
    );
  }
  const key = str(summary.key);
  const title = str(summary.title);
  if (name === 'web_search' || name === 'google_books') {
    const count = typeof summary.count === 'number' ? summary.count : 0;
    return (
      <>
        <span className="num">{counted(t, count, name === 'web_search' ? 'results' : 'volumes')}</span>
        {title ? ` · ${title}` : ''}
      </>
    );
  }
  if (name === 'page_images') {
    const count = typeof summary.count === 'number' ? summary.count : 0;
    return (
      <span className="num">
        {count === 0 ? t('trajectory.noImages') : count === 1 ? t('trajectory.oneImage') : fill(t('trajectory.images'), { count })}
      </span>
    );
  }
  if (name === 'fetch_page') {
    const url = httpUrl(summary.url);
    return (
      <>
        {title ?? t('trajectory.untitled')}
        {url ? (
          <>
            {' · '}
            <HostLink url={url} />
          </>
        ) : null}
      </>
    );
  }
  if (name === 'search_open_library') {
    const count = typeof summary.count === 'number' ? summary.count : 0;
    const counted =
      count === 0 ? t('trajectory.noResults') : count === 1 ? t('trajectory.oneResult') : fill(t('trajectory.results'), { count });
    return (
      <>
        <span className="num">{counted}</span>
        {key ? (
          <>
            {' · '}
            <OpenLibraryKey value={key} />
            {title ? ` · ${title}` : ''}
          </>
        ) : null}
      </>
    );
  }
  // The requested key is already shown as the query; repeat it only when the record differs.
  const shownKey = key && key !== requestedKey ? key : null;
  if (!shownKey && !title) return null;
  return (
    <>
      {shownKey ? <OpenLibraryKey value={shownKey} /> : null}
      {shownKey && title ? ' · ' : ''}
      {title}
    </>
  );
}

function webQuery(name: string, args: Record<string, unknown> | null): string | null {
  if (name === 'web_search') return str(args?.query);
  if (name === 'google_books') return str(args?.isbn) ?? str(args?.query);
  return null;
}

function searchQuery(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const parts = [str(args.title), str(args.author), str(args.isbn)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Folds each tool call and its result into one readable row; `end` is returned separately. */
function buildRows(t: Translate, steps: TrajectoryStep[]): { rows: Row[]; end: TrajectoryStep | null } {
  const rows: Row[] = [];
  const results = new Map<string, TrajectoryStep>();
  for (const step of steps) {
    const callId = str(step.data.callId);
    if (step.kind === 'tool_result' && callId) results.set(callId, step);
  }
  const used = new Set<TrajectoryStep>();
  let end: TrajectoryStep | null = null;
  for (const step of steps) {
    const data = step.data;
    const omitted = data.omitted === true;
    if (step.kind === 'end') {
      end = step;
      continue;
    }
    if (step.kind === 'input') {
      const input = record(data.input);
      const parts = [str(input?.filename), str(input?.format)?.toUpperCase()].filter(Boolean);
      rows.push({
        key: `s${step.seq}`,
        label: t('trajectory.step.input'),
        detail: parts.length > 0 ? parts.join(' · ') : null,
        result: str(data.model),
        raw: data.input ?? data,
        omitted,
      });
      continue;
    }
    if (step.kind === 'model') {
      const text = str(data.text);
      rows.push({
        key: `s${step.seq}`,
        label: text ? t('trajectory.step.note') : fill(t('trajectory.step.turn'), { turn: Number(data.turn) || 0 }),
        detail: text ? <span className="trajectory-note">{text}</span> : null,
        durationMs: data.durationMs,
        raw: data,
        omitted,
      });
      continue;
    }
    if (step.kind === 'tool_call') {
      const name = str(data.name) ?? '';
      const result = results.get(str(data.callId) ?? '');
      if (result) used.add(result);
      const args = record(data.args);
      const label =
        name === 'search_open_library'
          ? t('trajectory.step.search')
          : name === 'get_open_library_record'
            ? t('trajectory.step.record')
            : name in WEB_STEP_LABELS
              ? t(WEB_STEP_LABELS[name]!)
              : fill(t('trajectory.step.tool'), { name: name || '—' });
      const key = str(args?.key);
      const pageUrl = name === 'fetch_page' || name === 'page_images' ? httpUrl(args?.url) : null;
      const parsedResult = parseMaybe(result?.data.result);
      rows.push({
        key: `s${step.seq}`,
        label,
        detail:
          name === 'get_open_library_record' && key ? (
            <OpenLibraryKey value={key} />
          ) : pageUrl ? (
            <HostLink url={pageUrl} />
          ) : (
            (webQuery(name, args) ?? searchQuery(args) ?? str(data.argsText))
          ),
        result: result ? resultSummary(t, name, record(result.data.summary), key) : null,
        durationMs: result?.data.durationMs,
        raw: { args: data.args ?? data.argsText ?? null, result: parsedResult },
        sources: name === 'web_search' ? searchSources(parsedResult) : undefined,
        images: name === 'page_images' ? pageImageList(parsedResult) : undefined,
        omitted: omitted || result?.data.omitted === true,
      });
      continue;
    }
    if (step.kind === 'tool_result') {
      if (used.has(step)) continue;
      rows.push({
        key: `s${step.seq}`,
        label: fill(t('trajectory.step.tool'), { name: str(data.name) ?? '—' }),
        result: resultSummary(t, str(data.name) ?? '', record(data.summary)),
        durationMs: data.durationMs,
        raw: parseMaybe(data.result),
        omitted,
      });
      continue;
    }
    if (step.kind === 'note') {
      const dropped = Array.isArray(data.dropped) ? (data.dropped as unknown[]).map(record).filter(Boolean) : [];
      const coverStatus = str(record(data.cover)?.status);
      rows.push({
        key: `s${step.seq}`,
        label:
          str(data.message) === 'identifiers_dropped'
            ? t('trajectory.step.dropped')
            : coverStatus
              ? t('trajectory.step.cover')
              : t('trajectory.step.pipeline'),
        tone: dropped.length > 0 || coverStatus === 'rejected' || coverStatus === 'error' ? 'error' : undefined,
        detail:
          dropped.map((item) => `${str(item?.scheme) ?? '?'}: ${str(item?.value) ?? ''} (${str(item?.reason) ?? ''})`).join(', ') ||
          (str(data.message) === 'wrap_up'
            ? t('trajectory.wrapUp')
            : str(data.message) === 'cover_auto_applied'
              ? t('trajectory.coverAutoApplied')
              : str(data.message)),
        raw: data,
        omitted,
      });
      continue;
    }
    if (step.kind === 'submit') {
      const accepted = data.accepted === true;
      const proposal = record(data.proposal);
      const authors = Array.isArray(proposal?.authors) ? (proposal.authors as unknown[]).filter((a) => typeof a === 'string') : [];
      const missing = Array.isArray(data.missing) ? (data.missing as unknown[]).filter((m) => typeof m === 'string') : [];
      rows.push({
        key: `s${step.seq}`,
        label: accepted ? t('trajectory.step.submitted') : t('trajectory.step.rejected'),
        tone: accepted ? undefined : 'error',
        detail: accepted
          ? [str(proposal?.title), authors.join(', ')].filter(Boolean).join(' · ') || null
          : missing.length > 0
            ? fill(t('trajectory.missing'), { fields: missing.join(', ') })
            : fill(t('trajectory.toolError'), { code: str(data.error) ?? 'invalid_arguments' }),
        raw: accepted ? data.proposal : (data.args ?? data.argsText ?? data),
        omitted,
      });
    }
  }
  return { rows, end };
}

function parseMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function RawBlock({ value, sources, images }: { value: unknown; sources?: Source[]; images?: PageImage[] }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="trajectory-raw">
      <button
        type="button"
        className="trajectory-raw-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {t('trajectory.raw')}
      </button>
      {open ? (
        <div id={id}>
          {sources && sources.length > 0 ? (
            <ol className="trajectory-sources">
              {sources.map((source, index) => (
                <li key={`${index}-${source.url.href}`}>
                  <span className="trajectory-source-title">{source.title}</span> <HostLink url={source.url} />
                </li>
              ))}
            </ol>
          ) : null}
          {images && images.length > 0 ? (
            <ol className="trajectory-sources">
              {images.map((image, index) => (
                <li key={`${index}-${image.url.href}`}>
                  <span className="trajectory-source-title">{image.kind}</span>{' '}
                  <a className="text-link" href={image.url.href} target="_blank" rel="noreferrer noopener">
                    {image.url.href}
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
          <pre className="trajectory-json" tabIndex={0}>
            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One metadata assistant run as a numbered, ruled list. Refetches while `active`
 * whenever the parent's polled step count changes, and once more when the run ends.
 */
export function Trajectory({
  trajectoryId,
  active,
  stepCount,
}: {
  trajectoryId: number;
  active: boolean;
  stepCount?: number;
}) {
  const { t } = useLocale();
  const [trajectory, setTrajectory] = useState<MetadataTrajectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    void api<{ trajectory: MetadataTrajectory }>(`/api/metadata/trajectories/${trajectoryId}`).then((result) => {
      if (!current) return;
      if (result.error || !result.data) {
        setError(result.error ?? 'network');
        return;
      }
      setError(null);
      setTrajectory(result.data.trajectory);
    });
    return () => {
      current = false;
    };
  }, [trajectoryId, stepCount, active, generation]);

  if (error && !trajectory) {
    return (
      <ErrorNotice
        message={error === 'not_found' ? t('trajectory.gone') : t('trajectory.error')}
        onRetry={error === 'not_found' ? undefined : () => setGeneration((value) => value + 1)}
      />
    );
  }
  if (!trajectory) return <LoadingState label={t('trajectory.loading')} />;

  const { rows, end } = buildRows(t, trajectory.steps);
  const working = active && !end;
  const endData = end?.data;
  const outcome = str(endData?.outcome) ?? trajectory.outcome;

  return (
    <div className="trajectory">
      {rows.length === 0 && !working ? <EmptyState compact title={t('trajectory.empty')} /> : null}
      {rows.length > 0 ? (
        <ol className="trajectory-steps">
          {rows.map((row, index) => (
            <li key={row.key} className="trajectory-step">
              <span className="trajectory-index num" aria-hidden="true">
                {index + 1}
              </span>
              <div className="trajectory-body">
                <p className="trajectory-line">
                  <span className={row.tone === 'error' ? 'trajectory-label trajectory-error' : 'trajectory-label'}>
                    {row.label}
                  </span>
                  {row.detail ? <span className="trajectory-detail">{row.detail}</span> : null}
                </p>
                {row.result ? <p className="trajectory-result">{row.result}</p> : null}
                {row.omitted ? <p className="trajectory-result">{t('trajectory.omitted')}</p> : null}
                <RawBlock value={row.raw} sources={row.sources} images={row.images} />
              </div>
              <span className="trajectory-time num">{formatDuration(row.durationMs)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {working ? (
        <p className="trajectory-working" role="status">
          <span className="trajectory-pulse" aria-hidden="true" />
          {t('trajectory.working')}
        </p>
      ) : null}
      {end ? (
        <p className="trajectory-end" role="status">
          <span className={outcome === 'accepted' ? 'trajectory-label' : 'trajectory-label trajectory-error'}>
            {t(`trajectory.outcome.${outcomeKey(outcome)}`)}
          </span>
          <span className="trajectory-detail num">
            {fill(t('trajectory.totals'), {
              turns: Number(endData?.turns) || 0,
              toolCalls: Number(endData?.toolCalls) || 0,
              time: formatDuration(endData?.totalMs),
            })}
          </span>
          {str(endData?.error) && outcome !== 'accepted' ? (
            <span className="trajectory-detail">{str(endData?.error)}</span>
          ) : null}
        </p>
      ) : null}
      {trajectory.truncated ? <p className="hint">{t('trajectory.truncated')}</p> : null}
    </div>
  );
}

function outcomeKey(value: string | null): 'accepted' | 'failed' | 'timeout' | 'limit' {
  return value === 'accepted' || value === 'timeout' || value === 'limit' ? value : 'failed';
}

/** A collapsed "Trajectory" control that mounts the live list only when opened. */
export function TrajectoryDisclosure({
  trajectoryId,
  active,
  stepCount,
}: {
  trajectoryId: number;
  active: boolean;
  stepCount?: number;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="trajectory-disclosure">
      <button
        type="button"
        className="trajectory-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {t('trajectory.title')}
      </button>
      {open ? (
        <div id={id} className="trajectory-panel">
          <Trajectory trajectoryId={trajectoryId} active={active} stepCount={stepCount} />
        </div>
      ) : null}
    </div>
  );
}
