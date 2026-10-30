export type PdfSelectionRect = [number, number, number, number];

export interface PdfSelectionPage {
  page: number;
  rects: PdfSelectionRect[];
}

export interface PdfSelection {
  pages: PdfSelectionPage[];
}

export interface PdfTextSelection {
  locator: string;
  quote: string;
  anchor: { left: number; top: number; width: number; height: number };
}

export interface PdfAnnotationMark {
  id: string;
  locator: string;
  kind: 'highlight' | 'note';
}

export const PDF_SELECTION_MAX_PAGES = 8;
export const PDF_SELECTION_MAX_RECTS = 200;
export const PDF_SELECTION_MAX_TEXT = 2000;
const LOCATOR_MAX = 16_000;

function normalize(value: unknown): PdfSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'v' && key !== 'pages') || record.v !== 1 || !Array.isArray(record.pages)
    || record.pages.length < 1 || record.pages.length > PDF_SELECTION_MAX_PAGES) return null;
  let previous = 0;
  let count = 0;
  const pages: PdfSelectionPage[] = [];
  for (const raw of record.pages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== 'page' && key !== 'rects') || typeof item.page !== 'number'
      || !Number.isInteger(item.page) || item.page <= previous || item.page > 1_000_000 || !Array.isArray(item.rects)
      || item.rects.length < 1 || (count += item.rects.length) > PDF_SELECTION_MAX_RECTS) return null;
    previous = item.page;
    const rects: PdfSelectionRect[] = [];
    for (const rect of item.rects) {
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1_000_000)) return null;
      const rounded = rect.map((number: number) => Math.round(number * 1000) / 1000) as PdfSelectionRect;
      if (rounded[0] >= rounded[2] || rounded[1] >= rounded[3]) return null;
      rects.push(rounded);
    }
    pages.push({ page: item.page, rects });
  }
  return { pages };
}

/** Versioned selection rectangles in PDF user coordinates, independent of zoom. */
export function parsePdfSelection(value: unknown): PdfSelection | null {
  if (typeof value !== 'string' || value.length > LOCATOR_MAX) return null;
  const text = value.trim();
  if (!text.startsWith('pdfsel(') || !text.endsWith(')')) return null;
  try {
    return normalize(JSON.parse(text.slice(7, -1)));
  } catch {
    return null;
  }
}

export function formatPdfSelection(selection: PdfSelection): string | null {
  const normalized = normalize({ v: 1, pages: selection.pages });
  if (!normalized) return null;
  const text = `pdfsel(${JSON.stringify({ v: 1, pages: normalized.pages })})`;
  return text.length <= LOCATOR_MAX ? text : null;
}

export function parsePdfSelectionLocator(value: unknown): string | null {
  const parsed = parsePdfSelection(value);
  return parsed ? formatPdfSelection(parsed) : null;
}
