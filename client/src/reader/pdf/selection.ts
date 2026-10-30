import {
  formatPdfSelection, PDF_SELECTION_MAX_PAGES, PDF_SELECTION_MAX_RECTS, PDF_SELECTION_MAX_TEXT,
  type PdfSelectionRect, type PdfTextSelection,
} from './annotations';
import type { RenderedPage } from './types';

export interface SelectionPage {
  shell: HTMLElement;
  text: HTMLElement;
  rendered?: RenderedPage;
}

type Box = { left: number; top: number; width: number; height: number };
type SelectionResult = { kind: 'empty' } | { kind: 'too-large' } | { kind: 'selected'; value: PdfTextSelection };
const excluded = 'button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),.pdf-annotation-layer';

function endpoint(root: HTMLElement, node: Node | null, pages: ReadonlyMap<number, SelectionPage>) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  const layer = element?.closest('.textLayer');
  if (!layer || !root.contains(layer) || element?.closest(excluded)) return null;
  for (const [page, entry] of pages) {
    if (entry.text === layer) return page;
  }
  return null;
}

/** A bounded pin set, read synchronously before virtualization can detach a range. */
export function selectedPages(root: HTMLElement, selection: Selection | null, pages: ReadonlyMap<number, SelectionPage>): number[] {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const first = endpoint(root, selection.anchorNode, pages);
  const last = endpoint(root, selection.focusNode, pages);
  if (first === null || last === null) return [];
  const low = Math.min(first, last);
  const high = Math.max(first, last);
  const candidates = [...pages.keys()].filter((page) => page >= low && page <= high).sort((a, b) => a - b);
  // Keep both native endpoints even when rejecting a selection beyond the limit.
  // Detaching either endpoint here can collapse it before the scheduled rejection.
  return candidates.length <= PDF_SELECTION_MAX_PAGES ? candidates
    : [...candidates.slice(0, PDF_SELECTION_MAX_PAGES - 1), candidates[candidates.length - 1]];
}

/** Transform every corner: rotations and cropped PDF origins need no special case. */
export function transformRect(rect: PdfSelectionRect, transform: RenderedPage['toPdf']): PdfSelectionRect {
  const [left, top, right, bottom] = rect;
  const points = [transform(left, top), transform(right, top), transform(left, bottom), transform(right, bottom)];
  return [Math.min(...points.map((point) => point.x)), Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)), Math.max(...points.map((point) => point.y))];
}

function mergeRects(rects: PdfSelectionRect[]) {
  const merged: PdfSelectionRect[] = [];
  for (const rect of rects.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = merged.find((other) => Math.abs(other[1] - rect[1]) <= 0.5
      && Math.abs(other[3] - rect[3]) <= 0.5 && other[2] >= rect[0] - 0.5 && other[0] <= rect[2] + 0.5);
    if (previous) {
      previous[0] = Math.min(previous[0], rect[0]);
      previous[1] = Math.min(previous[1], rect[1]);
      previous[2] = Math.max(previous[2], rect[2]);
      previous[3] = Math.max(previous[3], rect[3]);
    } else merged.push([...rect]);
  }
  return merged;
}

function anchorFor(rects: Box[], root: HTMLElement): Box {
  const bounds = root.getBoundingClientRect();
  for (const rect of rects) {
    const left = Math.max(rect.left, bounds.left, 0);
    const top = Math.max(rect.top, bounds.top, 0);
    const right = Math.min(rect.left + rect.width, bounds.width ? bounds.right : Infinity, window.innerWidth);
    const bottom = Math.min(rect.top + rect.height, bounds.height ? bounds.bottom : Infinity, window.innerHeight);
    if (right > left && bottom > top) return { left, top, width: right - left, height: bottom - top };
  }
  return rects[0];
}

/** Read only selected text nodes; element ranges can report entire ancestor boxes. */
export function readPdfSelection(root: HTMLElement, selection: Selection | null, pages: ReadonlyMap<number, SelectionPage>): SelectionResult {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return { kind: 'empty' };
  const first = endpoint(root, selection.anchorNode, pages);
  const last = endpoint(root, selection.focusNode, pages);
  if (first === null || last === null) return { kind: 'empty' };
  if (Math.abs(last - first) + 1 > PDF_SELECTION_MAX_PAGES) return { kind: 'too-large' };
  const numbers = selectedPages(root, selection, pages);
  // Never save partial geometry when native selection bridges an unpainted gap.
  if (numbers.length !== Math.abs(last - first) + 1 || numbers.some((page) => !pages.get(page)?.rendered)) return { kind: 'empty' };
  const output: { page: number; rects: PdfSelectionRect[] }[] = [];
  const clientRects: Box[] = [];
  const quoteParts: string[] = [];
  let rectCount = 0;
  for (const page of numbers) {
    const entry = pages.get(page)!;
    const rendered = entry.rendered!;
    const bounds = entry.shell.getBoundingClientRect();
    const rects: PdfSelectionRect[] = [];
    const pageParts: string[] = [];
    const walker = document.createTreeWalker(entry.text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType !== Node.TEXT_NODE) {
        if (node.nodeName === 'BR' && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some((range) => range.intersectsNode(node!))) pageParts.push(' ');
        continue;
      }
      if (node.parentElement?.closest(excluded)) continue;
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const native = selection.getRangeAt(index);
        if (!native.intersectsNode(node)) continue;
        const start = native.startContainer === node ? native.startOffset : 0;
        const end = native.endContainer === node ? native.endOffset : node.textContent!.length;
        if (end <= start) continue;
        const text = node.textContent!.slice(start, end);
        pageParts.push(text);
        if ([...quoteParts, pageParts.join('')].join(' ').replace(/\s+/gu, ' ').trim().length > PDF_SELECTION_MAX_TEXT) return { kind: 'too-large' };
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        for (const rect of Array.from(range.getClientRects())) {
          const left = Math.max(0, rect.left - bounds.left);
          const top = Math.max(0, rect.top - bounds.top);
          const right = Math.min(rendered.cssWidth, rect.right - bounds.left);
          const bottom = Math.min(rendered.cssHeight, rect.bottom - bounds.top);
          if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
          rects.push([left, top, right, bottom]);
          clientRects.push({ left: left + bounds.left, top: top + bounds.top, width: right - left, height: bottom - top });
        }
      }
    }
    quoteParts.push(pageParts.join(''));
    // Whitespace at page boundaries is implicit in the DOM's absolutely positioned pages.
    if (quoteParts.join(' ').replace(/\s+/gu, ' ').trim().length > PDF_SELECTION_MAX_TEXT) return { kind: 'too-large' };
    const converted = mergeRects(rects).map((rect) => transformRect(rect, (x, y) => rendered.toPdf(x, y)))
      .filter((rect) => rect[2] - rect[0] >= 0.001 && rect[3] - rect[1] >= 0.001);
    rectCount += converted.length;
    if (rectCount > PDF_SELECTION_MAX_RECTS) return { kind: 'too-large' };
    if (converted.length) output.push({ page, rects: converted });
  }
  const quote = quoteParts.join(' ').replace(/\s+/gu, ' ').trim();
  if (!quote || !output.length || !clientRects.length) return { kind: 'empty' };
  const locator = formatPdfSelection({ pages: output });
  return locator ? { kind: 'selected', value: { locator, quote, anchor: anchorFor(clientRects, root) } } : { kind: 'too-large' };
}
