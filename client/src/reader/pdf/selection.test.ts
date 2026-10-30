import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePdfSelection, PDF_SELECTION_MAX_RECTS, PDF_SELECTION_MAX_TEXT } from './annotations';
import { readPdfSelection, selectedPages, transformRect, type SelectionPage } from './selection';
import type { RenderedPage } from './types';

function box(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} };
}

let root: HTMLDivElement;
let positions: WeakMap<Node, { left: number; top: number; columns: number; duplicate?: boolean }>;
const rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  root.getBoundingClientRect = () => box(0, 0, 640, 480);
  positions = new WeakMap();
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: vi.fn(function (this: Range) {
    const position = positions.get(this.startContainer);
    // This deliberate ancestor box must never be used for a text selection.
    if (!position || this.startContainer !== this.endContainer) return [box(0, 0, 640, 1000)];
    const result: DOMRect[] = [];
    for (let start = this.startOffset; start < this.endOffset;) {
      const line = Math.floor(start / position.columns);
      const end = Math.min(this.endOffset, (line + 1) * position.columns);
      const rect = box(position.left + (start % position.columns) * 10, position.top + line * 20, (end - start) * 10, 16);
      result.push(rect);
      if (position.duplicate) result.push(rect);
      start = end;
    }
    return result;
  }) });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  root.remove();
  if (rectDescriptor) Object.defineProperty(Range.prototype, 'getClientRects', rectDescriptor);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  vi.restoreAllMocks();
});

const rendered: RenderedPage = {
  cssWidth: 400, cssHeight: 1000, scale: 2,
  toPdf: (x, y) => ({ x: 10 + x / 2, y: 800 - y / 2 }),
  toViewport: (x, y) => ({ x: (x - 10) * 2, y: (800 - y) * 2 }),
};

function addPage(page: number, content: string, left = 100, top = 50, columns = 10) {
  const shell = document.createElement('div');
  shell.dataset.page = String(page);
  shell.getBoundingClientRect = () => box(left, top, 400, 1000);
  const text = document.createElement('div');
  text.className = 'textLayer';
  const span = document.createElement('span');
  span.textContent = content;
  const node = span.firstChild!;
  positions.set(node, { left: left + 20, top: top + 40, columns });
  text.append(span);
  shell.append(text);
  root.append(shell);
  return { shell, text, rendered, node };
}

function select(start: Node, startOffset: number, end = start, endOffset = start.textContent!.length) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function value(selection: Selection, pages: ReadonlyMap<number, SelectionPage>) {
  const result = readPdfSelection(root, selection, pages);
  expect(result.kind).toBe('selected');
  if (result.kind !== 'selected') throw new Error(result.kind);
  return { ...result.value, parsed: parsePdfSelection(result.value.locator) };
}

describe('PDF native selection conversion', () => {
  it('clips partial words and multiline text with shell offsets, PDF origin and zoom', () => {
    const page = addPage(1, 'abcdefghijklmnopqrst');
    positions.get(page.node)!.duplicate = true;
    const result = value(select(page.node, 3, page.node, 14), new Map([[1, page]]));
    expect(result.quote).toBe('defghijklmn');
    expect(result.parsed).toEqual({ pages: [{ page: 1, rects: [[35, 772, 70, 780], [20, 762, 40, 770]] }] });
    expect(result.anchor).toEqual({ left: 150, top: 90, width: 70, height: 16 });
    expect(vi.mocked(Range.prototype.getClientRects).mock.contexts.every((range) => (range as unknown as Range).startContainer.nodeType === Node.TEXT_NODE)).toBe(true);
  });

  it('normalizes rotated coordinates using all corners and preserves page sorting', () => {
    const first = addPage(1, 'first');
    const second = addPage(2, 'second', 80, 200);
    second.rendered = { ...rendered, toPdf: (x, y) => ({ x: y + 20, y: 900 - x }) };
    const pages = new Map([[2, second], [1, first]]);
    const result = value(select(first.node, 2, second.node, 3), pages);
    expect(result.quote).toBe('rst sec');
    expect(result.parsed).toEqual({ pages: [
      { page: 1, rects: [[30, 772, 45, 780]] },
      { page: 2, rects: [[60, 850, 76, 880]] },
    ] });
    expect(transformRect([10, 20, 30, 40], (x, y) => ({ x: x - y, y: x + y }))).toEqual([-30, 30, 10, 70]);
  });

  it('merges touching fragments on a line, preserving gaps and explicit line breaks in quotes', () => {
    const page = addPage(1, 'Hello');
    const next = document.createElement('span');
    next.textContent = ' world';
    page.text.append(next, document.createElement('br'));
    const last = document.createElement('span');
    last.textContent = 'next';
    page.text.append(last);
    positions.set(next.firstChild!, { left: 170, top: 90, columns: 100 });
    positions.set(last.firstChild!, { left: 120, top: 110, columns: 100 });
    const result = value(select(page.node, 0, last.firstChild!, 4), new Map([[1, page]]));
    expect(result.quote).toBe('Hello world next');
    expect(result.parsed?.pages[0].rects).toEqual([[20, 772, 75, 780], [20, 762, 40, 770]]);
  });

  it('rejects controls, outside ranges, unpainted pages, collapsed and whitespace text', () => {
    const page = addPage(1, 'hello');
    const pages = new Map<number, SelectionPage>([[1, page]]);
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    expect(readPdfSelection(root, select(page.node, 0, outside.firstChild!, 3), pages).kind).toBe('empty');
    outside.remove();
    const control = document.createElement('button');
    control.textContent = 'control';
    page.text.append(control);
    expect(readPdfSelection(root, select(control.firstChild!, 0), pages).kind).toBe('empty');
    expect(readPdfSelection(root, select(page.node, 1, page.node, 1), pages).kind).toBe('empty');
    page.node.textContent = ' \n\t ';
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('empty');
    page.node.textContent = 'hello';
    pages.set(1, { ...page, rendered: undefined });
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('empty');
  });

  it('rejects oversized quotes and geometry instead of truncating, and accepts exact bounds', () => {
    const page = addPage(1, 'x'.repeat(PDF_SELECTION_MAX_TEXT + 1), 0, 0, 1000);
    const pages = new Map([[1, page]]);
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('too-large');
    page.node.textContent = 'x'.repeat(PDF_SELECTION_MAX_TEXT);
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('selected');
    page.node.textContent = 'x'.repeat(PDF_SELECTION_MAX_RECTS + 1);
    // Every glyph is on a separate line. Keep the PDF page tall enough to include them.
    positions.get(page.node)!.columns = 1;
    page.rendered = { ...rendered, cssHeight: 10000 };
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('too-large');
    page.node.textContent = 'x'.repeat(PDF_SELECTION_MAX_RECTS);
    expect(readPdfSelection(root, select(page.node, 0), pages).kind).toBe('selected');
  });

  it('bounds retained DOM to eight pages, keeps endpoints, and releases when collapsed', () => {
    const pages = new Map<number, ReturnType<typeof addPage>>();
    for (let number = 1; number <= 10; number += 1) pages.set(number, addPage(number, 'text'));
    const selection = select(pages.get(1)!.node, 0, pages.get(8)!.node, 4);
    expect(value(selection, pages).parsed?.pages).toHaveLength(8);
    selection.extend(pages.get(10)!.node, 4);
    expect(readPdfSelection(root, selection, pages).kind).toBe('too-large');
    expect(selectedPages(root, selection, pages)).toEqual([1, 2, 3, 4, 5, 6, 7, 10]);
    selection.collapse(pages.get(1)!.node, 0);
    expect(selectedPages(root, selection, pages)).toEqual([]);
  });

  it('does not save partial geometry across missing mounted pages', () => {
    const first = addPage(1, 'one');
    const third = addPage(3, 'three');
    const pages = new Map([[1, first], [3, third]]);
    expect(readPdfSelection(root, select(first.node, 0, third.node, 5), pages).kind).toBe('empty');
  });
});
