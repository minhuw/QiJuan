const LOCATOR_MAX = 200;
const NUM = '-?(?:0|[1-9]\\d{0,6})(?:\\.\\d{1,4})?';
const PDF_POS = new RegExp(`^pdfpos\\(page=([1-9]\\d{0,6});x=(${NUM});y=(${NUM});(?:zoom=(${NUM})|fit=width)\\)$`);

export interface PdfPlace {
  page: number;
  x: number;
  y: number;
  zoom: number | 'width';
}

/**
 * Page, visible top-left in PDF user space, and zoom or fit-width.
 * Not a document-wide percentage.
 */
export function parsePdfPlace(value: unknown): PdfPlace | null {
  if (typeof value !== 'string') return null;
  const locator = value.trim();
  if (locator.length > LOCATOR_MAX || locator.includes('%')) return null;
  const match = PDF_POS.exec(locator);
  if (!match) return null;
  const page = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000) return null;
  if (!validCoord(x) || !validCoord(y)) return null;
  if (match[4] === undefined) return { page, x, y, zoom: 'width' };
  const zoom = Number(match[4]);
  if (!(zoom > 0) || zoom > 16) return null;
  return { page, x, y, zoom };
}

export function parsePdfLocator(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const locator = value.trim();
  if (!parsePdfPlace(locator)) return null;
  return locator;
}

export function formatPdfLocator(place: PdfPlace): string | null {
  if (!Number.isInteger(place.page) || place.page < 1 || place.page > 1_000_000) return null;
  const x = formatCoord(place.x);
  const y = formatCoord(place.y);
  if (x == null || y == null) return null;
  if (place.zoom === 'width') return parsePdfLocator(`pdfpos(page=${place.page};x=${x};y=${y};fit=width)`);
  const zoom = formatCoord(place.zoom);
  if (zoom == null) return null;
  const scale = Number(zoom);
  if (!(scale > 0) || scale > 16) return null;
  return parsePdfLocator(`pdfpos(page=${place.page};x=${x};y=${y};zoom=${zoom})`);
}

function formatCoord(value: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1000) / 1000;
  if (Object.is(rounded, -0)) return '0';
  if (!validCoord(rounded)) return null;
  const text = String(rounded);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  return text;
}

function validCoord(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}
