import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Highlighter, Plus, StickyNote, X } from 'lucide-react';
import { api, type ApiResult } from '../../api';
import { useLocale } from '../../shell';
import { parsePdfPlace } from './locator';
import { parsePdfSelection, type PdfAnnotationMark, type PdfTextSelection } from './annotations';

export interface PdfHighlight {
  id: number;
  assetId: number | null;
  locator: string;
  quote: string | null;
  revision: number;
}

export interface PdfNote {
  id: number;
  assetId: number | null;
  locator: string | null;
  body: string;
  revision: number;
}

interface NoteDraft {
  id?: number;
  locator: string;
  body: string;
  revision: number;
  quote?: string;
}

export function pdfAnnotationPoint(locator: string | null) {
  const selection = parsePdfSelection(locator);
  if (selection) {
    const first = selection.pages[0];
    return { page: first.page, x: first.rects[0][0], y: first.rects[0][3] };
  }
  return parsePdfPlace(locator);
}

export function usePdfAnnotations({ editionId, assetId, settle, onOpen }: {
  editionId: number;
  assetId: number;
  settle: <T>(result: ApiResult<T>) => Promise<T | null | undefined>;
  onOpen: (panel: 'notes' | 'highlights') => void;
}) {
  const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
  const [notes, setNotes] = useState<PdfNote[]>([]);
  const [selection, setSelection] = useState<PdfTextSelection | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lifecycle = useRef(0);
  useEffect(() => {
    lifecycle.current += 1;
    return () => { lifecycle.current += 1; };
  }, [editionId, assetId]);

  function clearSelection() {
    setSelection(null);
    const native = window.getSelection();
    if (native?.anchorNode?.parentElement?.closest('.pdf-scroller')) native.removeAllRanges();
  }

  function load(data: { highlights?: PdfHighlight[]; notes?: PdfNote[] }) {
    setHighlights((data.highlights ?? []).filter((item) => item.assetId === assetId && parsePdfSelection(item.locator)));
    setNotes((data.notes ?? []).filter((item) => item.assetId === assetId && pdfAnnotationPoint(item.locator)));
  }

  async function mutate<T>(request: () => Promise<ApiResult<T>>, apply: (data: T | null) => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const ticket = lifecycle.current;
    try {
      const result = await request();
      if (ticket !== lifecycle.current) return;
      const data = await settle(result);
      if (ticket !== lifecycle.current) return;
      if (result.status === 409) setDraft(null);
      if (data !== undefined && !result.error) apply(data);
    } finally {
      busyRef.current = false;
      if (ticket === lifecycle.current) setBusy(false);
    }
  }

  function highlight() {
    if (!selection) return;
    const captured = selection;
    void mutate(() => api<{ highlight: PdfHighlight }>(`/api/editions/${editionId}/highlights`, {
      method: 'POST', body: { assetId, locator: captured.locator, quote: captured.quote, revision: 0 },
    }), (data) => {
      if (!data?.highlight) return;
      setHighlights((items) => [...items, data.highlight]);
      clearSelection();
    });
  }

  function startNote(locator: string, quote?: string) {
    if (busyRef.current) return;
    setDraft({ locator, body: '', revision: 0, quote });
    clearSelection();
    onOpen('notes');
  }

  function editNote(note: PdfNote) {
    if (!note.locator || busyRef.current) return;
    setDraft({ id: note.id, locator: note.locator, body: note.body, revision: note.revision });
    onOpen('notes');
  }

  function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!draft || !draft.body.trim()) return;
    const captured = draft;
    void mutate(() => api<{ note: PdfNote }>(`/api/editions/${editionId}/notes${captured.id ? `/${captured.id}` : ''}`, {
      method: captured.id ? 'PATCH' : 'POST',
      body: captured.id
        ? { body: captured.body.trim(), revision: captured.revision }
        : { assetId, locator: captured.locator, body: captured.body.trim(), revision: 0 },
    }), (data) => {
      if (!data?.note) return;
      setNotes((items) => captured.id ? items.map((item) => item.id === captured.id ? data.note : item) : [...items, data.note]);
      setDraft(null);
    });
  }

  function remove(kind: 'highlights' | 'notes', item: PdfHighlight | PdfNote) {
    void mutate(() => api(`/api/editions/${editionId}/${kind}/${item.id}`, {
      method: 'DELETE', body: { revision: item.revision },
    }), () => {
      if (kind === 'highlights') setHighlights((items) => items.filter((mark) => mark.id !== item.id));
      else {
        setNotes((items) => items.filter((note) => note.id !== item.id));
        setDraft((current) => current?.id === item.id ? null : current);
      }
    });
  }

  const marks = useMemo<PdfAnnotationMark[]>(() => [
    ...highlights.map((item) => ({ id: `highlight-${item.id}`, locator: item.locator, kind: 'highlight' as const })),
    ...notes.filter((item) => parsePdfSelection(item.locator)).map((item) => ({ id: `note-${item.id}`, locator: item.locator!, kind: 'note' as const })),
  ], [highlights, notes]);

  return { highlights, notes, selection, setSelection, clearSelection, draft, setDraft, busy, load, highlight, startNote, editNote, saveNote, remove, marks };
}

type AnnotationTools = ReturnType<typeof usePdfAnnotations>;

export function PdfSelectionToolbar({ tools }: { tools: AnnotationTools }) {
  const { t } = useLocale();
  const selection = tools.selection;
  if (!selection) return null;
  const center = selection.anchor.left + selection.anchor.width / 2;
  const left = Math.max(112, Math.min(window.innerWidth - 112, center));
  const top = Math.max(8, Math.min(window.innerHeight - 52, selection.anchor.top >= 58
    ? selection.anchor.top - 50 : selection.anchor.top + selection.anchor.height + 8));
  return (
    <div className="pdf-selection-toolbar" role="toolbar" aria-label={t('reader.selection')}
      style={{ left, top }} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" disabled={tools.busy} onClick={tools.highlight}>
        <Highlighter size={15} aria-hidden="true" />{t('reader.highlight')}
      </button>
      <button type="button" disabled={tools.busy} onClick={() => tools.startNote(selection.locator, selection.quote)}>
        <StickyNote size={15} aria-hidden="true" />{t('reader.note')}
      </button>
      <button type="button" className="pdf-selection-close" aria-label={t('reader.close')} onClick={tools.clearSelection}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function PdfAnnotationPanel({ kind, tools, onNavigate, onPageNote, ready }: {
  kind: 'highlights' | 'notes'; tools: AnnotationTools;
  onNavigate: (locator: string) => void; onPageNote: () => void; ready: boolean;
}) {
  const { t } = useLocale();
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = kind === 'notes' ? tools.draft : null;
  useEffect(() => { if (draft) input.current?.focus(); }, [draft?.id, draft?.locator, kind]);
  const items = kind === 'highlights' ? tools.highlights : tools.notes;
  return (
    <div className="pdf-annotations">
      {kind === 'notes' && !draft ? (
        <button type="button" className="btn btn-ghost btn-sm pdf-add-note" disabled={!ready || tools.busy} onClick={onPageNote}>
          <Plus size={15} aria-hidden="true" />{t('reader.addPageNote')}
        </button>
      ) : null}
      {draft ? (
        <form className="pdf-note-form" onSubmit={tools.saveNote}>
          <span className="pdf-annotation-page">{t('reader.page')} {pdfAnnotationPoint(draft.locator)?.page}</span>
          {draft.quote ? <blockquote>{draft.quote}</blockquote> : null}
          <label>
            <span className="visually-hidden">{t('reader.noteBody')}</span>
            <textarea ref={input} value={draft.body} maxLength={10000} required rows={5} disabled={tools.busy}
              placeholder={t('reader.notePlaceholder')} onChange={(event) => tools.setDraft({ ...draft, body: event.target.value })} />
          </label>
          <div className="pdf-annotation-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={tools.busy || !draft.body.trim()}>{t('reader.saveNote')}</button>
            <button className="btn btn-ghost btn-sm" type="button" disabled={tools.busy} onClick={() => tools.setDraft(null)}>{t('reader.cancel')}</button>
          </div>
        </form>
      ) : null}
      {!items.length && !draft ? <p className="placeholder">{t(kind === 'notes' ? 'reader.noNotes' : 'reader.noHighlights')}</p> : null}
      <ul className="pdf-annotation-list">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="pdf-annotation-jump" onClick={() => item.locator && onNavigate(item.locator)}>
              <span className="pdf-annotation-page">{t('reader.page')} {pdfAnnotationPoint(item.locator)?.page}</span>
              <span className={kind === 'highlights' ? 'pdf-annotation-quote' : 'pdf-annotation-body'}>
                {'quote' in item ? item.quote || t('reader.highlight') : item.body}
              </span>
            </button>
            <div className="pdf-annotation-actions">
              {kind === 'notes' ? <button type="button" className="btn btn-ghost btn-sm" disabled={tools.busy} onClick={() => tools.editNote(item as PdfNote)}>{t('reader.editNote')}</button> : null}
              <button type="button" className="btn btn-ghost btn-sm" disabled={tools.busy} onClick={() => tools.remove(kind, item)}>{t('reader.remove')}</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
