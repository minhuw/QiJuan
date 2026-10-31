import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Download,
  FileText,
  Loader2,
  Lock,
  Minus,
  Plus,
  Wand2,
  X,
} from 'lucide-react';
import {
  api,
  apiForm,
  type EditionDetail,
  type CoverPreview,
  type EditionIdentifier,
  type FieldPreview,
  type ImportJob,
  type MetadataPreview,
} from './api';
import { CoverArt } from './components/ui/cover-art';
import {
  IDENTIFIER_SCHEMES,
  IdentifierValue,
  UnidentifiedMark,
  schemeLabel,
} from './components/ui/identifiers';
import { ErrorNotice, LoadingState } from './components/ui/states';
import { EpubReader } from './reader/epub-reader';
import { PdfReader } from './reader/pdf-reader';
import { FileField } from './components/ui/file-field';
import { StateTag } from './components/ui/status-mark';
import { TrajectoryDisclosure } from './components/ui/trajectory';
import { BookRatings } from './book-ratings';
import { BookTabs, useTabHash, type BookTab } from './book-tabs';
import { ReadingActions, ShelfMenu } from './reading-actions';
import { useLocale } from './shell';

const ERROR_CODES = new Set([
  'invalid_request',
  'invalid_identifier',
  'unauthorized',
  'forbidden',
  'not_found',
  'required',
  'network',
  'internal',
  'payload_too_large',
  'metadata_unavailable',
  'metadata_incomplete',
  'metadata_assistant_unconfigured',
  'metadata_private',
  'conflict',
]);

/** Status poll for a metadata job. The agent allows up to 90 seconds and the worker runs one job at a time, so a lookup can stay queued much longer than a few seconds. */
const METADATA_JOB_POLL_MS = 200;

const FIELD_LABEL: Record<string, string> = {
  title: 'book.title',
  authors: 'book.authors',
  description: 'book.description',
  publisher: 'book.publisher',
  publishedDate: 'book.publishedDate',
  language: 'book.language',
  identifiers: 'book.identifiers',
  series: 'book.series',
  seriesOrder: 'book.seriesOrder',
  translators: 'book.translators',
  cover: 'book.cover',
};

interface RetryWait {
  cancel: () => void;
}

interface LookupTrace {
  trajectoryId: number;
  stepCount: number;
  active: boolean;
}

interface LookupPreview extends MetadataPreview {
  source: string | null;
  model: string | null;
}

interface IdentifierRow {
  key: number;
  scheme: string;
  value: string;
}

let nextRowKey = 0;

function identifierRow(scheme: string, value: string): IdentifierRow {
  nextRowKey += 1;
  return { key: nextRowKey, scheme, value };
}

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
  identifiers: IdentifierRow[];
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
    identifiers: edition.identifiers.map((item) => identifierRow(item.scheme, item.value)),
    tags: edition.tags.join(', '),
  };
}

/** The rows a save sends: blank rows are dropped, so an empty row never blocks a save. */
function sentIdentifiers(rows: IdentifierRow[]): IdentifierRow[] {
  return rows
    .map((row) => ({ ...row, scheme: row.scheme.trim(), value: row.value.trim() }))
    .filter((row) => row.value !== '');
}

/** Whether the Series section has anything to show: the edition's series, or other books in it. */
function hasSeriesContent(edition: EditionDetail): boolean {
  const neighbors = edition.neighbors;
  return Boolean(edition.series || neighbors?.previous || neighbors?.next || (neighbors?.series.length ?? 0) > 0);
}

/** The page's tabs that have something in them, in order. Files and Details always do. */
function tabsFor(edition: EditionDetail): string[] {
  const ids: string[] = [];
  const overview = Boolean(
    edition.description ||
      edition.series ||
      edition.publisher ||
      edition.publishedDate ||
      edition.language ||
      edition.assets.length > 0 ||
      edition.identifiers.length > 0,
  );
  if (overview) ids.push('overview');
  if (hasSeriesContent(edition)) ids.push('series');
  ids.push('files', 'details');
  if (edition.suggestions.length > 0) ids.push('similar');
  return ids;
}

/**
 * What the desktop cover needs to size itself, set on the card's left column: the height of
 * everything under the cover (Read and the reader's controls, with the gaps above them) as
 * --side-controls, and the cover image's width over height as --cover-ratio. The cover is as wide
 * as the column and gives up height, in proportion, only when the window is too short for it and
 * these controls inside the card's cap. The narrow layout ignores both.
 */
function useCoverRoom(side: HTMLElement | null, layoutKey: string) {
  useEffect(() => {
    if (!side || typeof ResizeObserver === 'undefined') return;
    const controls = [...side.children].filter((child) => !child.classList.contains('book-jacket-cover'));
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(side).rowGap) || 0;
      const used = controls.reduce((sum, child) => sum + (child as HTMLElement).offsetHeight + gap, 0);
      side.style.setProperty('--side-controls', `${Math.ceil(used)}px`);
    };
    const image = side.querySelector<HTMLImageElement>('.book-jacket-cover .cover-image');
    const ratio = () => {
      if (!image) side.style.removeProperty('--cover-ratio');
      else if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        side.style.setProperty('--cover-ratio', String(image.naturalWidth / image.naturalHeight));
      }
    };
    measure();
    ratio();
    image?.addEventListener('load', ratio);
    const observer = new ResizeObserver(measure);
    for (const child of controls) observer.observe(child);
    return () => {
      observer.disconnect();
      image?.removeEventListener('load', ratio);
    };
  }, [side, layoutKey]);
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
}: {
  editionId: number;
  role: 'admin' | 'reader';
}) {
  const { t } = useLocale();
  const [edition, setEdition] = useState<EditionDetail | null>(null);
  const [form, setForm] = useState<EditionForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** The identifier row the server rejected, by row key. */
  const [identifierError, setIdentifierError] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [preview, setPreview] = useState<LookupPreview | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [activity, setActivity] = useState<'lookup' | 'apply' | null>(null);
  const [lookupTrace, setLookupTrace] = useState<LookupTrace | null>(null);
  /** Set by Review: once the loaded preview renders, move to it. */
  const [revealPreview, setRevealPreview] = useState(false);
  const lookupRef = useRef<HTMLDetailsElement>(null);
  /** The card's left column; on desktop the cover gives up height to its controls only when short. */
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  const tabIds = edition ? tabsFor(edition) : [];
  const [tab, selectTab] = useTabHash(tabIds);
  useCoverRoom(side, edition ? `${edition.id}:${edition.assets.length}:${edition.cover ? 'cover' : 'plate'}` : '');
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const baseId = useId();
  const privateHintId = useId();
  const requestId = useRef(0);
  const retryWait = useRef<RetryWait | null>(null);

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

  useEffect(() => {
    setActivity(null);
    setPending(false);
    setPreview(null);
    setLookupNote(null);
    setLookupTrace(null);
    setFormError(null);
    setIdentifierError(null);
    return () => {
      requestId.current += 1;
      retryWait.current?.cancel();
    };
  }, [editionId]);

  useEffect(() => {
    if (!revealPreview || !preview) return;
    setRevealPreview(false);
    // Move on to the preview unless focus has left the lookup disclosure while it loaded.
    const summary = lookupRef.current?.querySelector('summary');
    const here = document.activeElement;
    if (here && here !== summary && here !== document.body) return;
    const heading = previewHeadingRef.current;
    heading?.scrollIntoView?.({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }, [revealPreview, preview]);

  // Move to the rejected row once it renders as invalid, so its error is read with it.
  useEffect(() => {
    if (identifierError !== null) document.getElementById(`${baseId}-identifier-${identifierError}`)?.focus();
  }, [identifierError, baseId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!edition || !form) return;
    const patch = diffEdition(edition, form);
    if (patch === 'invalid') {
      setFormError('invalid_request');
      return;
    }
    if (Object.keys(patch).length === 0) return;
    const sent = sentIdentifiers(form.identifiers);
    setPending(true);
    setFormError(null);
    setIdentifierError(null);
    setSaved(false);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${edition.id}`, { method: 'PATCH', body: patch });
    setPending(false);
    if (result.error || !result.data) {
      // The server names the rejected identifier; mark that row instead of the whole form.
      const rejected = result.error === 'invalid_identifier' && typeof result.index === 'number' ? sent[result.index] : undefined;
      if (rejected) {
        setIdentifierError(rejected.key);
        return;
      }
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

  /** Admins only. Making a book private drops any lookup preview, here and on the server. */
  async function setMetadataPrivate(value: boolean) {
    if (!edition) return;
    const editionId = edition.id;
    if (value) {
      // A lookup still polling must not stage its result on this page.
      requestId.current += 1;
      setActivity(null);
      setLookupTrace(null);
      setLookupNote(null);
      setPreview(null);
      setChecked([]);
    }
    setPending(true);
    setSaved(false);
    setFormError(null);
    const result = await api<{ edition: EditionDetail }>(`/api/editions/${editionId}`, {
      method: 'PATCH',
      body: { metadataPrivate: value },
    });
    setPending(false);
    if (result.error || !result.data) {
      setFormError(result.error ?? 'internal');
      return;
    }
    // The edit form keeps any unsaved changes; only the setting and the pending lookup change.
    setEdition(result.data.edition);
  }

  async function lookup() {
    if (!edition || edition.metadataPrivate) return;
    const editionId = edition.id;
    const token = ++requestId.current;
    setPending(true);
    setActivity('lookup');
    setLookupNote(null);
    setLookupTrace(null);
    setPreview(null);
    setSaved(false);
    setFormError(null);
    try {
      const started = await api<{ job: { id: number } }>(`/api/editions/${editionId}/metadata/lookup`, { method: 'POST' });
      if (requestId.current !== token) return;
      if (started.error || !started.data?.job?.id) {
        setFormError(started.error ?? 'internal');
        return;
      }
      const job = await pollJob(started.data.job.id, token, (polled) => {
        // Admin job payloads carry the trajectory id and step count; the disclosure refetches as the count grows.
        if (typeof polled.trajectoryId !== 'number') return;
        setLookupTrace({
          trajectoryId: polled.trajectoryId,
          stepCount: polled.trajectoryStepCount ?? 0,
          active: polled.status === 'queued' || polled.status === 'running',
        });
      });
      if (requestId.current !== token) return;
      if (!job || job.status === 'failed') {
        setFormError(job ? jobError(job) ?? 'internal' : 'internal');
        return;
      }
      setFormError(null);
      const next = jobPreview(job);
      if (!next) {
        setLookupNote('none');
        return;
      }
      setPreview(next);
      setChecked(next.fields.filter((field) => field.status === 'change').map((field) => field.field));
      // A coverless book may have taken the found cover already; the form keeps any unsaved edits.
      const refreshed = await api<{ edition: EditionDetail }>(`/api/editions/${editionId}`);
      if (requestId.current === token && refreshed.data?.edition) setEdition(refreshed.data.edition);
    } finally {
      if (requestId.current === token) {
        setPending(false);
        setActivity(null);
      }
    }
  }

  /** Opens the lookup disclosure on the pending lookup preview, loaded from the server. */
  async function reviewLookup() {
    if (!edition?.pendingLookup) return;
    const editionId = edition.id;
    const previewId = edition.pendingLookup.previewId;
    // Switch to Details, open the lookup disclosure at once and move to it; the preview fills it in when it loads.
    flushSync(() => selectTab('details'));
    const disclosure = lookupRef.current;
    if (disclosure) {
      disclosure.open = true;
      disclosure.scrollIntoView?.({ block: 'start' });
      disclosure.querySelector('summary')?.focus({ preventScroll: true });
    }
    const token = ++requestId.current;
    setPending(true);
    setFormError(null);
    setLookupNote(null);
    setSaved(false);
    try {
      const loaded = await api<{ preview: MetadataPreview & { source?: string; model?: string } }>(
        `/api/editions/${editionId}/metadata/previews/${previewId}`,
      );
      if (requestId.current !== token) return;
      if (loaded.error || !loaded.data?.preview) {
        // Applied or dismissed elsewhere: reload so the notice goes with it.
        if (loaded.error === 'not_found') setGeneration((value) => value + 1);
        else setFormError(loaded.error ?? 'internal');
        return;
      }
      const next = loaded.data.preview;
      setPreview({ ...next, source: next.source ?? null, model: next.model || null });
      setChecked(next.fields.filter((field) => field.status === 'change').map((field) => field.field));
      setRevealPreview(true);
    } finally {
      if (requestId.current === token) setPending(false);
    }
  }

  /** Discards the preview on the server, staged cover included. Nothing is applied. */
  async function discardPreview() {
    if (!edition || !preview) return;
    const editionId = edition.id;
    const token = ++requestId.current;
    setPending(true);
    setFormError(null);
    setSaved(false);
    try {
      const result = await api<{ edition: EditionDetail }>(
        `/api/editions/${editionId}/metadata/previews/${preview.previewId}`,
        { method: 'DELETE' },
      );
      if (requestId.current !== token) return;
      if (result.error === 'not_found') {
        setPreview(null);
        setGeneration((value) => value + 1);
        return;
      }
      if (result.error || !result.data) {
        setFormError(result.error ?? 'internal');
        return;
      }
      setPreview(null);
      setEdition(result.data.edition);
    } finally {
      if (requestId.current === token) setPending(false);
    }
  }

  async function applyPreview(event: FormEvent) {
    event.preventDefault();
    if (!edition || !preview) return;
    if (checked.length === 0) {
      setFormError('required');
      return;
    }
    const editionId = edition.id;
    const previewId = preview.previewId;
    const confirm = checked;
    const token = ++requestId.current;
    setPending(true);
    setActivity('apply');
    setFormError(null);
    setSaved(false);
    try {
      const started = await api<{ job: { id: number } }>(`/api/editions/${editionId}/metadata/apply`, {
        method: 'POST',
        body: { previewId, confirm },
      });
      if (requestId.current !== token) return;
      if (started.error || !started.data?.job?.id) {
        setFormError(started.error ?? 'internal');
        return;
      }
      const job = await pollJob(started.data.job.id, token);
      if (requestId.current !== token) return;
      if (!job || job.status !== 'succeeded') {
        setFormError(job ? jobError(job) ?? 'internal' : 'internal');
        return;
      }
      const next = await loadEdition(editionId, token);
      if (requestId.current !== token || !next) return;
      setFormError(null);
      setEdition(next);
      setForm(toForm(next));
      setPreview(null);
      setSaved(true);
    } finally {
      if (requestId.current === token) {
        setPending(false);
        setActivity(null);
      }
    }
  }

  function waitForRetry(token: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (requestId.current !== token) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (retryWait.current?.cancel === cancel) retryWait.current = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(requestId.current === token), METADATA_JOB_POLL_MS);
      function cancel() {
        clearTimeout(timer);
        finish(false);
      }
      retryWait.current = { cancel };
    });
  }

  // Poll until the job itself finishes. Giving up while it is queued re-enables Save
  // with the pre-apply form, which can overwrite fields the job already locked.
  async function pollJob(
    jobId: number,
    token: number,
    onPoll?: (job: ImportJob) => void,
  ): Promise<ImportJob | null> {
    while (requestId.current === token) {
      const result = await api<{ job: ImportJob }>(`/api/jobs/${jobId}`);
      if (requestId.current !== token) return null;
      const job = result.error ? undefined : result.data?.job;
      if (job) onPoll?.(job);
      if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
      const stillHere = await waitForRetry(token);
      if (!stillHere) return null;
    }
    return null;
  }

  async function loadEdition(id: number, token: number): Promise<EditionDetail | null> {
    while (requestId.current === token) {
      const loaded = await api<{ edition: EditionDetail }>(`/api/editions/${id}`);
      if (requestId.current !== token) return null;
      if (!loaded.error && loaded.data?.edition) return loaded.data.edition;
      const stillHere = await waitForRetry(token);
      if (!stillHere) return null;
    }
    return null;
  }

  if (error) {
    return (
      <div className="state-page">
        <ErrorNotice message={errorText(t, error)} />
        <Link className="back-link" to="/">
          <ArrowLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('book.back')}
        </Link>
      </div>
    );
  }
  if (!edition || !form) return <LoadingState />;

  const locks = new Set(edition.locks);
  const set =
    (key: keyof EditionForm) => (value: string) => {
      setSaved(false);
      setForm((current) => (current ? { ...current, [key]: value } : current));
    };

  const readable = edition.assets.filter((asset) => asset.availability === 'present');
  const firstReadable = readable[0];
  const formats = [...new Set(edition.assets.map((asset) => asset.format.toUpperCase()))];
  const seriesLabel = edition.series
    ? `${edition.series.name}${edition.seriesOrder == null ? '' : ` · ${edition.seriesOrder}`}`
    : null;
  // The quick facts in the card; a field without a value is left out.
  const glance: [string, ReactNode][] = [];
  if (edition.series) {
    const order = edition.seriesOrder == null ? '' : ` · #${edition.seriesOrder}`;
    glance.push([
      t('book.series'),
      <a
        className="text-link"
        href="#series"
        onClick={(event) => {
          event.preventDefault();
          // Switch to the Series tab and move focus to its heading.
          flushSync(() => selectTab('series'));
          document.getElementById(`${baseId}-series-head`)?.focus();
        }}
      >
        {edition.series.name}
        {order ? <span className="num">{order}</span> : null}
      </a>,
    ]);
  }
  if (edition.publisher) glance.push([t('book.publisher'), edition.publisher]);
  if (edition.publishedDate) glance.push([t('book.published'), <span className="num">{edition.publishedDate}</span>]);
  if (formats.length > 0) {
    glance.push([
      formats.length === 1 ? t('book.format') : t('book.formats'),
      <span className="format-text">{formats.join(' · ')}</span>,
    ]);
  }
  if (edition.language) glance.push([t('book.language'), edition.language]);
  const firstIdentifier = edition.identifiers.find((item) => item.scheme === 'isbn') ?? edition.identifiers[0];
  if (firstIdentifier) glance.push([schemeLabel(t, firstIdentifier.scheme), <IdentifierValue identifier={firstIdentifier} />]);

  const facts: [string, ReactNode][] = [[t('book.title'), edition.title]];
  if (edition.sortTitle !== edition.title) facts.push([t('book.sortTitle'), edition.sortTitle]);
  if (edition.alternateTitles.length > 0) {
    facts.push([t('book.alternateTitles'), edition.alternateTitles.map((item) => item.title).join(' · ')]);
  }
  if (edition.authors.length > 0) facts.push([t('book.authors'), edition.authors.join(', ')]);
  if (edition.translators.length > 0) facts.push([t('book.translators'), edition.translators.join(', ')]);
  if (seriesLabel) facts.push([t('book.series'), seriesLabel]);
  if (edition.publisher) facts.push([t('book.publisher'), edition.publisher]);
  if (edition.publishedDate) facts.push([t('book.publishedDate'), <span className="num">{edition.publishedDate}</span>]);
  if (edition.language) facts.push([t('book.language'), edition.language]);
  if (formats.length > 0) facts.push([t('book.formats'), <span className="format-text">{formats.join(' · ')}</span>]);
  if (edition.tags.length > 0) facts.push([t('book.tags'), edition.tags.join(', ')]);

  const neighbors = edition.neighbors;
  const seriesBooks = neighbors?.series ?? [];
  const showNotice =
    role === 'admin' &&
    !edition.metadataPrivate &&
    edition.pendingLookup &&
    preview?.previewId !== edition.pendingLookup.previewId;
  const tint = edition.coverTint ?? null;
  const tintStyle = tint ? ({ '--tint-day': tint.light, '--tint-night': tint.dark } as CSSProperties) : undefined;
  const cover = (
    <CoverArt
      editionId={edition.id}
      title={edition.title}
      author={edition.authors[0]}
      hasCover={Boolean(edition.cover)}
      variant="detail"
      eager
    />
  );

  const panelLabel = (id: string, title: string) => (
    <h2 className="book-panel-label" id={`${baseId}-${id}-head`} tabIndex={-1}>
      {title}
    </h2>
  );

  const tabs: BookTab[] = [];
  if (tabIds.includes('overview')) {
    tabs.push({
      id: 'overview',
      label: t('book.overview'),
      content: (
        <>
          {glance.length > 0 ? (
            <dl className="book-glance" aria-label={t('book.atAGlance')}>
              {glance.map(([term, value]) => (
                <div className="book-glance-row" key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {edition.description ? (
            <section className="book-panel-section" aria-labelledby={`${baseId}-description-head`}>
              {panelLabel('description', t('book.description'))}
              <p className="book-description">{edition.description}</p>
            </section>
          ) : null}
        </>
      ),
    });
  }
  if (tabIds.includes('series')) {
    tabs.push({
      id: 'series',
      label: t('book.series'),
      content: (
        <>
          <div className="book-series-head">
            <h2 id={`${baseId}-series-head`} tabIndex={-1}>
              {edition.series?.name ?? t('book.series')}
            </h2>
            {neighbors?.previous || neighbors?.next ? (
              <p className="book-series-nav">
                {neighbors.previous ? (
                  <Link
                    className="book-series-step"
                    to={`/books/${neighbors.previous.id}`}
                    title={neighbors.previous.title}
                    aria-label={`${t('reading.previous')}: ${neighbors.previous.title}`}
                  >
                    <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" />
                    {t('reading.previous')}
                  </Link>
                ) : null}
                {neighbors.next ? (
                  <Link
                    className="book-series-step"
                    to={`/books/${neighbors.next.id}`}
                    title={neighbors.next.title}
                    aria-label={`${t('reading.next')}: ${neighbors.next.title}`}
                  >
                    {t('reading.next')}
                    <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
                  </Link>
                ) : null}
              </p>
            ) : null}
          </div>
          {seriesBooks.length > 1 ? (
            <ol className="series-list" aria-label={t('reading.neighbors')}>
              {seriesBooks.map((book) => (
                <li key={book.id} className="series-row">
                  <span className="series-order num">{book.seriesOrder ?? '·'}</span>
                  {book.id === edition.id ? (
                    <span className="series-title" aria-current="page">
                      {book.title}
                    </span>
                  ) : (
                    <Link className="series-title series-link" to={`/books/${book.id}`}>
                      {book.title}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          ) : neighbors?.previous || neighbors?.next ? null : (
            <p className="hint">{t('reading.noNeighbors')}</p>
          )}
        </>
      ),
    });
  }
  tabs.push({
    id: 'files',
    label: t('book.filesExports'),
    content: (
      <>
        <ul className="format-list" aria-label={t('book.formats')}>
          {edition.assets.map((asset) => (
            <li key={asset.id} className="format-item">
              <FileText className="format-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="format-copy">
                <span className="format-name">{asset.displayFilename}</span>
                {asset.originalFilename !== asset.displayFilename ? (
                  <span className="format-original" title={t('book.originalFilename')}>
                    {asset.originalFilename}
                  </span>
                ) : null}
                <span className="format-meta">
                  <span className="format-text">{asset.format.toUpperCase()}</span>
                  {asset.availability === 'missing' ? <StateTag tone="error">{t('book.missing')}</StateTag> : null}
                </span>
              </span>
              <span className="format-actions">
                {asset.availability === 'present' ? (
                  <a
                    className="text-link"
                    href={`/api/editions/${edition.id}/assets/${asset.id}/file?download=1`}
                    download={asset.displayFilename}
                    aria-label={`${t('book.download')} ${asset.displayFilename}`}
                  >
                    <Download size={14} strokeWidth={1.5} aria-hidden="true" />
                    {t('book.download')}
                  </a>
                ) : null}
                <Link className="btn btn-sm" to={`/books/${edition.id}/read/${asset.id}`}>
                  {t('book.read')} {asset.format.toUpperCase()}
                </Link>
              </span>
            </li>
          ))}
        </ul>
        <div className="export-row">
          <a className="text-link" href={`/api/editions/${edition.id}/annotations?format=markdown`}>
            <Download size={14} strokeWidth={1.5} aria-hidden="true" />
            {t('book.exportMarkdown')}
          </a>
          <a className="text-link" href={`/api/editions/${edition.id}/annotations?format=json`}>
            <Download size={14} strokeWidth={1.5} aria-hidden="true" />
            {t('book.exportJson')}
          </a>
        </div>
      </>
    ),
  });
  tabs.push({
    id: 'details',
    label: t('book.detailsTitle'),
    content: (
      <>
        <dl className="fact-list book-facts">
          {facts.map(([term, value]) => (
            <div className="fact-row" key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <IdentifierList identifiers={edition.identifiers} locked={locks.has('identifiers')} />
        {role === 'admin' ? (
          <div className="private-field book-private-field">
            <label className="check-row">
              <input
                type="checkbox"
                checked={edition.metadataPrivate}
                disabled={pending}
                aria-describedby={privateHintId}
                onChange={(event) => void setMetadataPrivate(event.target.checked)}
              />
              <span>{t('metadataPrivate.label')}</span>
            </label>
            <p className="hint" id={privateHintId}>
              {t('metadataPrivate.hint')}
            </p>
          </div>
        ) : null}
        <div className="book-disclosures">
          <details className="book-editor book-disclosure">
            <summary>{t('book.editDetails')}</summary>
            <div className="book-edit-body">
              <section className="book-metadata-panel">
                <div className="panel-head">
                  <h3>{t('book.metadata')}</h3>
                  {pending ? <Loader2 className="spin" size={15} strokeWidth={1.5} aria-hidden="true" /> : null}
                </div>
                <form className="form book-edit-form" onSubmit={(event) => void save(event)}>
                  <div className="field-grid">
                    <Field id={`${baseId}-title`} label={t('book.title')} locked={locks.has('title')}>
                      <input
                        id={`${baseId}-title`}
                        value={form.title}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSaved(false);
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  title: value,
                                  sortTitle: current.sortTitle === current.title ? value : current.sortTitle,
                                }
                              : current,
                          );
                        }}
                      />
                    </Field>
                    <Field id={`${baseId}-sort`} label={t('book.sortTitle')} locked={locks.has('sortTitle')}>
                      <input id={`${baseId}-sort`} value={form.sortTitle} onChange={(event) => set('sortTitle')(event.target.value)} />
                    </Field>
                    <Field
                      id={`${baseId}-series`}
                      label={t('book.series')}
                      locked={locks.has('series')}
                    >
                      <input id={`${baseId}-series`} value={form.series} onChange={(event) => set('series')(event.target.value)} />
                    </Field>
                    <Field id={`${baseId}-order`} label={t('book.seriesOrder')} locked={locks.has('seriesOrder')}>
                      <input
                        id={`${baseId}-order`}
                        value={form.seriesOrder}
                        inputMode="decimal"
                        onChange={(event) => set('seriesOrder')(event.target.value)}
                      />
                    </Field>
                    <Field id={`${baseId}-publisher`} label={t('book.publisher')} locked={locks.has('publisher')}>
                      <input
                        id={`${baseId}-publisher`}
                        value={form.publisher}
                        onChange={(event) => set('publisher')(event.target.value)}
                      />
                    </Field>
                    <Field id={`${baseId}-date`} label={t('book.publishedDate')} locked={locks.has('publishedDate')}>
                      <input
                        id={`${baseId}-date`}
                        value={form.publishedDate}
                        onChange={(event) => set('publishedDate')(event.target.value)}
                      />
                    </Field>
                    <Field id={`${baseId}-language`} label={t('book.language')} locked={locks.has('language')}>
                      <input
                        id={`${baseId}-language`}
                        value={form.language}
                        onChange={(event) => set('language')(event.target.value)}
                      />
                    </Field>
                    <Field id={`${baseId}-tags`} label={t('book.tags')} hint={t('book.tagsHint')} locked={locks.has('tags')}>
                      <input id={`${baseId}-tags`} value={form.tags} onChange={(event) => set('tags')(event.target.value)} />
                    </Field>
                  </div>
                  <Field
                    id={`${baseId}-authors`}
                    label={t('book.authors')}
                    hint={t('book.authorsHint')}
                    locked={locks.has('authors')}
                  >
                    <textarea id={`${baseId}-authors`} value={form.authors} onChange={(event) => set('authors')(event.target.value)} />
                  </Field>
                  <Field
                    id={`${baseId}-translators`}
                    label={t('book.translators')}
                    hint={t('book.authorsHint')}
                    locked={locks.has('translators')}
                  >
                    <textarea
                      id={`${baseId}-translators`}
                      value={form.translators}
                      onChange={(event) => set('translators')(event.target.value)}
                    />
                  </Field>
                  <Field
                    id={`${baseId}-description`}
                    label={t('book.description')}
                    locked={locks.has('description')}
                  >
                    <textarea
                      id={`${baseId}-description`}
                      value={form.description}
                      onChange={(event) => set('description')(event.target.value)}
                    />
                  </Field>
                  <Field
                    id={`${baseId}-alt`}
                    label={t('book.alternateTitles')}
                    hint={t('book.alternateHint')}
                    locked={locks.has('alternateTitles')}
                  >
                    <textarea
                      id={`${baseId}-alt`}
                      value={form.alternateTitles}
                      onChange={(event) => set('alternateTitles')(event.target.value)}
                    />
                  </Field>
                  <IdentifierEditor
                    baseId={baseId}
                    rows={form.identifiers}
                    locked={locks.has('identifiers')}
                    errorKey={identifierError}
                    onChange={(rows, changedKey) => {
                      setSaved(false);
                      if (changedKey === identifierError) setIdentifierError(null);
                      setForm((current) => (current ? { ...current, identifiers: rows } : current));
                    }}
                  />
                  <div className="form-footer">
                    <button className="btn btn-primary" type="submit" disabled={pending}>
                      {t('book.save')}
                    </button>
                  </div>
                </form>
              </section>

              <section className="cover-edit-panel">
                <h3>{t('book.cover')}</h3>
                {locks.has('cover') ? <p className="hint">{t('book.locked')}</p> : null}
                <form className="form" onSubmit={(event) => void replaceCover(event)}>
                  <FileField
                    id={`${baseId}-cover`}
                    label={t('book.replaceCover')}
                    chooseLabel={t('book.chooseCover')}
                    emptyLabel={t('import.none')}
                    accept="image/png,image/jpeg,image/gif,image/webp"
                  />
                  <button className="btn" type="submit" disabled={pending}>
                    {t('book.replaceCover')}
                  </button>
                </form>
              </section>
            </div>
          </details>
          {role === 'admin' ? (
            <details className="book-lookup book-disclosure" ref={lookupRef}>
              <summary>{t('book.metadataAgent')}</summary>
              <div className="book-disclosure-body book-lookup-panel">
                <div className="book-lookup-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={pending || edition.metadataPrivate}
                    aria-describedby={edition.metadataPrivate ? `${baseId}-private-reason` : undefined}
                    onClick={() => void lookup()}
                  >
                    <Wand2 size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('book.runAgent')}
                  </button>
                </div>
                {edition.metadataPrivate ? (
                  <p className="hint" id={`${baseId}-private-reason`}>
                    {t('metadataPrivate.lookupOff')}
                  </p>
                ) : null}
                {activity === 'lookup' ? (
                  <p className="alert alert-info" role="status">
                    <Loader2 className="spin" size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('book.lookupRunning')}
                  </p>
                ) : null}
                {activity === 'apply' ? (
                  <p className="alert alert-info" role="status">
                    <Loader2 className="spin" size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('book.applyRunning')}
                  </p>
                ) : null}
                {lookupNote === 'none' ? <p className="hint">{t('book.noSuggestion')}</p> : null}
                {lookupTrace ? (
                  <TrajectoryDisclosure
                    trajectoryId={lookupTrace.trajectoryId}
                    stepCount={lookupTrace.stepCount}
                    active={lookupTrace.active}
                  />
                ) : null}
                {preview ? (
                  <form className="form preview-form" onSubmit={(event) => void applyPreview(event)}>
                    <h3 ref={previewHeadingRef} tabIndex={-1}>
                      {t('book.preview')}
                    </h3>
                    {preview.source || preview.model ? (
                      <p className="hint">
                        {preview.source && preview.source !== 'assistant'
                          ? preview.source
                          : t('book.previewSource')}
                        {preview.model ? ` · ${preview.model}` : ''}
                      </p>
                    ) : null}
                    <ul className="preview-list">
                      {preview.fields.map((field) => (
                        <li key={field.field} className="preview-row">
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
                          ) : (
                            <span className="preview-check" aria-hidden="true">
                              {field.status === 'kept' ? <Lock size={14} strokeWidth={1.5} /> : <Minus size={14} strokeWidth={1.5} />}
                            </span>
                          )}
                          <span className="preview-field">{t(FIELD_LABEL[field.field] ?? 'book.title')}</span>
                          {field.status === 'kept' ? <StateTag tone="warning">{t('book.kept')}</StateTag> : null}
                          {field.status === 'unchanged' ? <span className="hint-inline">{t('book.unchanged')}</span> : null}
                          {field.field === 'cover' ? (
                            <PreviewCovers field={field} />
                          ) : field.proposed ? (
                            <span className="preview-proposed">{String(field.proposed)}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <div className="form-footer">
                      <button className="btn btn-primary" type="submit" disabled={pending}>
                        {t('book.confirm')}
                      </button>
                      <button className="btn" type="button" disabled={pending} onClick={() => void discardPreview()}>
                        {t('book.discardPreview')}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </>
    ),
  });
  if (tabIds.includes('similar')) {
    tabs.push({
      id: 'similar',
      label: t('book.suggestions'),
      content: (
        <>
          <p className="hint">{t('book.suggestionNote')}</p>
          <ul className="suggestion-list">
            {edition.suggestions.map((suggestion) => (
              <li key={suggestion.id} className="suggestion-row">
                <span className="suggestion-copy">
                  <Link className="suggestion-link" to={`/books/${suggestion.otherEditionId}`}>
                    {suggestion.otherTitle}
                  </Link>
                  {suggestion.reasons && suggestion.reasons.length > 0 ? (
                    <span className="suggestion-reason">
                      {suggestion.reasons
                        .map((reason) =>
                          reason === 'identifier'
                            ? suggestion.identifier
                              ? t('book.suggestionReason.identifier').replace(
                                  '{identifier}',
                                  `${schemeLabel(t, suggestion.identifier.scheme)} ${suggestion.identifier.value}`,
                                )
                              : t('book.suggestionReason.identifierAny')
                            : t('book.suggestionReason.title_author'),
                        )
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void dismiss(suggestion.id)}>
                  {t('book.dismiss')}
                </button>
              </li>
            ))}
          </ul>
        </>
      ),
    });
  }

  function onReadingEdition(next: EditionDetail) {
    setEdition(next);
    setForm(toForm(next));
  }

  return (
    <div className="book-page" data-tint={tint ? 'cover' : 'stock'} style={tintStyle}>
      <div className="book-page-inner">
        <Link className="back-link" to="/">
          <ArrowLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('book.back')}
        </Link>

        <article className="book-jacket" aria-labelledby={`${baseId}-heading`}>
          <div className="book-jacket-side" ref={setSide}>
            <div className="book-jacket-cover">
              {firstReadable ? (
                // The Read button below carries the same action for keyboard and screen-reader users.
                <Link className="book-cover-link" to={`/books/${edition.id}/read/${firstReadable.id}`} tabIndex={-1} aria-hidden="true">
                  {cover}
                </Link>
              ) : (
                cover
              )}
            </div>
            {readable.length > 0 ? (
              <div className="book-read-actions">
                {readable.map((asset, index) => (
                  <Link
                    key={asset.id}
                    className={index === 0 ? 'btn btn-primary book-read-primary' : 'btn'}
                    to={`/books/${edition.id}/read/${asset.id}`}
                  >
                    {index === 0 ? <BookOpen size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
                    {t('book.read')} {asset.format.toUpperCase()}
                  </Link>
                ))}
              </div>
            ) : null}
            <ReadingActions edition={edition} onEdition={onReadingEdition} />
          </div>

          <div className="book-jacket-body">
            <header className="book-hero">
              <h1 className="book-title" id={`${baseId}-heading`} title={edition.title}>
                {edition.title}
              </h1>
              {/* On the title row on desktop; at the end of the head when the card stacks. */}
              <ShelfMenu edition={edition} onEdition={onReadingEdition} />
              {edition.authors.length > 0 ? <p className="book-byline">{edition.authors.join(', ')}</p> : null}
              {edition.translators.length > 0 ? (
                <p className="book-translators">
                  {t('book.translatedBy').replace('{names}', edition.translators.join(', '))}
                </p>
              ) : null}
              {edition.metadataPrivate ? (
                <p className="book-private-mark">
                  <Lock size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span>{t('metadataPrivate.mark')}</span>
                  <span className="visually-hidden">{t('metadataPrivate.markDescription')}</span>
                </p>
              ) : null}
              {showNotice && edition.pendingLookup ? (
                <p className="lookup-notice">
                  <span>
                    {(edition.pendingLookup.changedFields.length === 1
                      ? t('book.lookupPendingOne')
                      : t('book.lookupPendingMany')
                    ).replace('{count}', String(edition.pendingLookup.changedFields.length))}
                  </span>
                  <span className="lookup-notice-sep" aria-hidden="true">
                    ·
                  </span>
                  <button
                    type="button"
                    className="lookup-notice-action"
                    disabled={pending}
                    onClick={() => void reviewLookup()}
                  >
                    {t('book.lookupReview')}
                  </button>
                </p>
              ) : null}
              <BookRatings
                edition={edition}
                role={role}
                onRatings={(update) => setEdition((current) => (current ? { ...current, ...update } : current))}
              />
              {edition.tags.length > 0 ? (
                <ul className="book-tags" aria-label={t('book.tags')}>
                  {edition.tags.map((tag) => <li key={tag}>{tag}</li>)}
                </ul>
              ) : null}
            </header>

            {formError || saved ? (
              <div className="book-alerts">
                {formError ? (
                  <div className="alert alert-error" role="alert">
                    {errorText(t, formError)}
                  </div>
                ) : null}
                {saved ? (
                  <p className="alert alert-success" role="status">
                    <Check size={15} strokeWidth={1.5} aria-hidden="true" />
                    {t('book.saved')}
                  </p>
                ) : null}
              </div>
            ) : null}

            <BookTabs idBase={baseId} label={t('book.tabsLabel')} tabs={tabs} active={tab} onSelect={selectTab} />
          </div>
        </article>
      </div>
    </div>
  );
}

/** The cover row of a lookup preview: the current and proposed images as small plates. */
function PreviewCovers({ field }: { field: FieldPreview }) {
  const { t } = useLocale();
  const current = isCoverPreview(field.current) ? field.current : null;
  const proposed = isCoverPreview(field.proposed) ? field.proposed : null;
  return (
    <div className="preview-proposed preview-covers">
      <CoverPlate label={t('book.coverCurrent')} cover={current} empty={t('book.noCover')} />
      <CoverPlate label={t('book.coverFound')} cover={proposed} empty={t('book.noCoverFound')} />
    </div>
  );
}

function CoverPlate({ label, cover, empty }: { label: string; cover: CoverPreview | null; empty: string }) {
  const { t } = useLocale();
  const source = cover?.sourceUrl ? safeHttpUrl(cover.sourceUrl) : null;
  return (
    <figure className="preview-cover">
      <span className="preview-cover-label">{label}</span>
      {cover ? (
        <>
          <span className="plate preview-cover-plate">
            <img className="cover-image" src={cover.url} alt="" decoding="async" />
          </span>
          <figcaption className="preview-cover-meta">
            {source && cover.host ? (
              <span>
                {t('book.coverFrom')}{' '}
                <a className="text-link" href={source} target="_blank" rel="noreferrer noopener" title={source}>
                  {cover.host}
                </a>
              </span>
            ) : null}
            {cover.width && cover.height ? (
              <span className="num">
                {cover.width} × {cover.height} px
              </span>
            ) : null}
          </figcaption>
        </>
      ) : (
        <span className="hint-inline">{empty}</span>
      )}
    </figure>
  );
}

function isCoverPreview(value: unknown): value is CoverPreview {
  return typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string';
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function ReaderPage({
  editionId,
  assetId,
}: {
  editionId: number;
  assetId: number;
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
      <div className="state-page">
        <ErrorNotice message={errorText(t, error)} />
        <Link className="back-link" to="/">
          <ArrowLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('book.back')}
        </Link>
      </div>
    );
  }
  if (!edition) return <LoadingState />;
  const asset = edition.assets.find((item) => item.id === assetId);
  if (!asset) {
    return (
      <div className="state-page">
        <ErrorNotice message={t('errors.not_found')} />
        <Link className="back-link" to="/">
          <ArrowLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('book.back')}
        </Link>
      </div>
    );
  }
  if (asset.availability !== 'present' || (asset.format !== 'epub' && asset.format !== 'pdf')) {
    return (
      <div className="reader-placeholder-page">
        <Link className="back-link" to={`/books/${edition.id}`}>
          <ArrowLeft size={15} strokeWidth={1.5} aria-hidden="true" />
          {t('book.back')}
        </Link>
        <div className="reader-placeholder-card">
          <h1>{edition.title}</h1>
          <p className="reader-placeholder-format">
            {t('book.read')} {asset.format.toUpperCase()}
          </p>
          <p className="placeholder">
            {asset.availability === 'missing' ? t('book.missing') : t('book.readPlaceholder')}
          </p>
        </div>
      </div>
    );
  }
  return (
    <>
      {asset.format === 'pdf' ? (
        <PdfReader editionId={edition.id} assetId={asset.id} title={edition.title} />
      ) : (
        <EpubReader editionId={edition.id} assetId={asset.id} title={edition.title} />
      )}
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

/** The edition's identifiers as a ruled list, each value linked to its record page. */
function IdentifierList({
  identifiers,
  locked,
}: {
  identifiers: EditionIdentifier[];
  locked: boolean;
}) {
  const { t } = useLocale();
  if (identifiers.length === 0) {
    return (
      <dl className="fact-list identifier-list identifier-list-none">
        <div className="fact-row">
          <dt>{t('book.identifiers')}</dt>
          <dd>
            <UnidentifiedMark />
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <div className="identifier-block">
      <p className="identifier-caption" id="book-identifiers-caption">
        <span>{t('book.identifiers')}</span>
        {locked ? (
          <span className="identifier-lock" title={t('identifiers.lockedHint')}>
            <Lock size={11} strokeWidth={1.5} aria-hidden="true" />
            {t('identifiers.locked')}
          </span>
        ) : null}
      </p>
      <dl className="fact-list identifier-list" aria-labelledby="book-identifiers-caption">
        {identifiers.map((identifier) => (
          <div className="fact-row identifier-row" key={`${identifier.scheme}:${identifier.value}`}>
            <dt>{schemeLabel(t, identifier.scheme)}</dt>
            <dd>
              <IdentifierValue identifier={identifier} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Add, remove and edit identifier rows; a row the server rejected carries its error inline. */
function IdentifierEditor({
  baseId,
  rows,
  locked,
  errorKey,
  onChange,
}: {
  baseId: string;
  rows: IdentifierRow[];
  locked: boolean;
  errorKey: number | null;
  onChange: (rows: IdentifierRow[], changedKey: number | null) => void;
}) {
  const { t } = useLocale();
  const legendId = `${baseId}-identifiers`;
  const hintId = `${baseId}-identifiers-hint`;
  const update = (key: number, patch: Partial<IdentifierRow>) =>
    onChange(
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      key,
    );
  return (
    <fieldset className="field identifier-editor" aria-describedby={hintId}>
      <legend id={legendId}>{t('book.identifiers')}</legend>
      {locked ? <p className="hint">{t('book.locked')}</p> : null}
      {rows.length === 0 ? (
        <p className="hint">{t('identifiers.none')}</p>
      ) : (
        <ul className="identifier-edit-list">
          {rows.map((row) => {
            const inputId = `${baseId}-identifier-${row.key}`;
            const errorId = `${inputId}-error`;
            const invalid = row.key === errorKey;
            const label = schemeLabel(t, row.scheme);
            const known = (IDENTIFIER_SCHEMES as readonly string[]).includes(row.scheme);
            return (
              <li key={row.key} className={invalid ? 'identifier-edit-row identifier-edit-invalid' : 'identifier-edit-row'}>
                <select
                  aria-label={t('identifiers.schemeField')}
                  value={row.scheme}
                  onChange={(event) => update(row.key, { scheme: event.target.value })}
                >
                  {IDENTIFIER_SCHEMES.map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {schemeLabel(t, scheme)}
                    </option>
                  ))}
                  {known ? null : <option value={row.scheme}>{row.scheme}</option>}
                </select>
                <input
                  id={inputId}
                  className="num"
                  aria-label={`${label} · ${t('identifiers.valueField')}`}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  value={row.value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update(row.key, { value: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm identifier-remove"
                  aria-label={t('identifiers.remove').replace('{scheme}', label)}
                  title={t('identifiers.remove').replace('{scheme}', label)}
                  onClick={() => onChange(rows.filter((item) => item.key !== row.key), row.key)}
                >
                  <X size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
                {invalid ? (
                  <p className="field-error" id={errorId}>
                    {t('identifiers.invalid').replace('{scheme}', label)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="identifier-edit-foot">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onChange([...rows, identifierRow('isbn', '')], null)}
        >
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          {t('identifiers.add')}
        </button>
        <p className="hint" id={hintId}>
          {t('book.identifiersHint')}
        </p>
      </div>
    </fieldset>
  );
}

function jobPreview(job: ImportJob): LookupPreview | null {
  const result = job.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const preview = (result as { preview?: unknown }).preview;
  if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) return null;
  const record = preview as { previewId?: unknown; fields?: unknown; source?: unknown; model?: unknown };
  if (typeof record.previewId !== 'number' || !Array.isArray(record.fields)) return null;
  return {
    previewId: record.previewId,
    fields: record.fields as MetadataPreview['fields'],
    source: typeof record.source === 'string' ? record.source : null,
    model: typeof record.model === 'string' ? record.model : null,
  };
}

function jobError(job: ImportJob): string | null {
  const result = job.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
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

  const cleanIdentifiers = sentIdentifiers(form.identifiers).map(({ scheme, value }) => ({ scheme, value }));
  if (cleanIdentifiers.some((item) => !item.scheme)) return 'invalid';
  const current = edition.identifiers.map(({ scheme, value }) => ({ scheme, value }));
  if (JSON.stringify(cleanIdentifiers) !== JSON.stringify(current)) patch.identifiers = cleanIdentifiers;

  const tags = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.join('\n') !== edition.tags.join('\n')) patch.tags = tags;
  return patch;
}
