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
 * A PDF place is a page, the visible top-left in PDF user space, and a zoom
 * factor or fit-width. A document-wide fraction or percent is not a place.
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

/** The stored locator, unchanged aside from surrounding whitespace. */
export function parsePdfLocator(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const locator = value.trim();
  if (!parsePdfPlace(locator)) return null;
  return locator;
}

function validCoord(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}
