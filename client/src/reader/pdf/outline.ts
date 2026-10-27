import type { PdfOutlineItem } from './types';

export interface RawOutlineNode {
  title?: string;
  dest?: unknown;
  items?: RawOutlineNode[];
}

export interface DestDocument {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

/** An empty outline is a missing outline, not a failure. */
export async function mapOutline(nodes: RawOutlineNode[] | null | undefined, doc: DestDocument): Promise<PdfOutlineItem[]> {
  if (!nodes || nodes.length === 0) return [];
  const mapped: PdfOutlineItem[] = [];
  for (const node of nodes) {
    const place = await resolveDest(node.dest, doc);
    const children = await mapOutline(node.items, doc);
    const title = (node.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title && !place && children.length === 0) continue;
    mapped.push({
      title: title || (place ? String(place.page) : ''),
      page: place?.page ?? null,
      x: place?.x ?? null,
      y: place?.y ?? null,
      children,
    });
  }
  return mapped;
}

async function resolveDest(
  dest: unknown,
  doc: DestDocument,
): Promise<{ page: number; x: number | null; y: number | null } | null> {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const page = await pageNumber(explicit[0], doc);
    if (!page) return null;
    const kind = destKind(explicit[1]);
    let x: number | null = null;
    let y: number | null = null;
    if (kind === 'XYZ') {
      x = numOrNull(explicit[2]);
      y = numOrNull(explicit[3]);
    } else if (kind === 'FitH' || kind === 'FitBH') {
      y = numOrNull(explicit[2]);
    } else if (kind === 'FitV' || kind === 'FitBV') {
      x = numOrNull(explicit[2]);
    } else if (kind === 'FitR') {
      x = numOrNull(explicit[2]);
      y = numOrNull(explicit[5]);
    }
    return { page, x, y };
  } catch {
    return null;
  }
}

function destKind(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'name' in value && typeof (value as { name: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return null;
}

async function pageNumber(ref: unknown, doc: DestDocument): Promise<number | null> {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0) return ref + 1;
  if (!ref || typeof ref !== 'object' || !('num' in ref) || !('gen' in ref)) return null;
  const num = (ref as { num: unknown }).num;
  const gen = (ref as { gen: unknown }).gen;
  if (typeof num !== 'number' || typeof gen !== 'number') return null;
  const index = await doc.getPageIndex({ num, gen });
  if (!Number.isInteger(index) || index < 0) return null;
  return index + 1;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
