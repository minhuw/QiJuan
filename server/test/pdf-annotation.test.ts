import { describe, expect, it } from 'vitest';
import {
  formatPdfSelection,
  parsePdfSelection,
  parsePdfSelectionLocator,
  PDF_SELECTION_MAX_PAGES,
  PDF_SELECTION_MAX_RECTS,
  type PdfSelection,
} from '../src/pdf-annotation.js';

const rect = [1, 2, 3, 4];
const payload = { v: 1, pages: [{ page: 1, rects: [rect] }] };
const locator = (value: unknown) => `pdfsel(${JSON.stringify(value)})`;
const canonical = 'pdfsel({"v":1,"pages":[{"page":1,"rects":[[1,2,3,4]]}]})';

function reject(value: unknown) {
  expect(parsePdfSelection(value)).toBeNull();
  expect(parsePdfSelectionLocator(value)).toBeNull();
}

describe('PDF selection locators', () => {
  it('matches canonical client vectors, preserving page and rectangle order', () => {
    const input = '  pdfsel({"pages":[{"rects":[[-0.0004,-12.34567,100.12349,200.9999],[2,3,4,5]],"page":2},{"page":1000000,"rects":[[-1000000,-1000000,1000000,1000000]]}],"v":1})  ';
    const expected = 'pdfsel({"v":1,"pages":[{"page":2,"rects":[[0,-12.346,100.123,201],[2,3,4,5]]},{"page":1000000,"rects":[[-1000000,-1000000,1000000,1000000]]}]})';
    const parsed = parsePdfSelection(input);
    expect(parsed?.pages[0].rects[0]).toEqual([-0, -12.346, 100.123, 201]);
    expect(parsePdfSelectionLocator(input)).toBe(expected);
    expect(formatPdfSelection(parsed!)).toBe(expected);
    expect(parsePdfSelectionLocator(expected)).toBe(expected);
    expect(parsePdfSelection(canonical)).toEqual({ pages: [{ page: 1, rects: [rect] }] });
    expect(formatPdfSelection({ pages: [{ page: 1, rects: [rect as [number, number, number, number]] }] })).toBe(canonical);
  });

  it.each([
    undefined, null, 1, {}, [], '', '42%', 'epubcfi(/6/4!/4/2:10)',
    'pdfpos(page=1;x=0;y=0;fit=width)', 'pdfsel()', 'pdfsel(null)', 'pdfsel([])',
    'pdfsel({)', 'PDFSEL({"v":1,"pages":[]})', `${canonical}junk`, canonical.slice(0, -1),
  ])('rejects malformed or non-selection input: %j', (value) => reject(value));

  it.each([
    {}, { ...payload, v: 2 }, { ...payload, v: '1' }, { pages: payload.pages },
    { ...payload, zoom: 1 }, { ...payload, pages: [] }, { ...payload, pages: {} },
    { ...payload, pages: [null] }, { ...payload, pages: [[]] },
    { ...payload, pages: [{ ...payload.pages[0], extra: true }] },
    { ...payload, pages: [{ page: 1 }] },
    ...[0, -1, 1.5, '1', 1_000_001, null].map((page) => ({ v: 1, pages: [{ page, rects: [rect] }] })),
    ...[[], null, {}, [null], [[1, 2, 3]], [[1, 2, 3, 4, 5]], [[1, '2', 3, 4]],
      [[1, 2, 1, 4]], [[3, 2, 1, 4]], [[1, 4, 3, 2]], [[1, 2, 3, 2]],
      [[0, 0, 0.0004, 1]], [[0, 0, 1, 0.0004]],
      [[-1_000_000.001, 0, 1, 1]], [[0, 0, 1_000_000.001, 1]],
    ].map((rects) => ({ v: 1, pages: [{ page: 1, rects }] })),
    { v: 1, pages: [{ page: 2, rects: [rect] }, { page: 2, rects: [rect] }] },
    { v: 1, pages: [{ page: 2, rects: [rect] }, { page: 1, rects: [rect] }] },
  ])('rejects bad versions, shapes, pages, and rectangles: %j', (value) => {
    reject(locator(value));
  });

  it('validates formatter pages and rectangle shapes', () => {
    for (const pages of [undefined, null, [], {}, [null], [{ page: 0, rects: [rect] }],
      [{ page: 1, rects: [] }], [{ page: 1, rects: [[1, 2, 1, 4]] }],
      [{ page: 1, rects: [rect], extra: true }]]) {
      expect(formatPdfSelection({ pages } as PdfSelection)).toBeNull();
    }
  });

  it('rejects non-finite coordinates before rounding', () => {
    for (const number of ['1e999', '-1e999', 'NaN', 'Infinity']) {
      reject(`pdfsel({"v":1,"pages":[{"page":1,"rects":[[0,0,${number},10]]}]})`);
    }
    for (const number of [NaN, Infinity, -Infinity]) {
      expect(formatPdfSelection({ pages: [{ page: 1, rects: [[0, 0, number, 10]] }] })).toBeNull();
    }
  });

  it('enforces page and total rectangle limits across all pages', () => {
    const pages = Array.from({ length: PDF_SELECTION_MAX_PAGES }, (_, index) => ({
      page: index + 1,
      rects: Array.from({ length: PDF_SELECTION_MAX_RECTS / PDF_SELECTION_MAX_PAGES }, () => rect),
    }));
    expect(parsePdfSelection(locator({ v: 1, pages }))).toEqual({ pages });
    expect(formatPdfSelection({ pages } as PdfSelection)).toBe(locator({ v: 1, pages }));
    reject(locator({ v: 1, pages: [...pages, { page: 9, rects: [rect] }] }));
    pages[7].rects.push(rect);
    reject(locator({ v: 1, pages }));
    expect(formatPdfSelection({ pages } as PdfSelection)).toBeNull();
    expect(parsePdfSelection(locator({ v: 1, pages: [{ page: 1, rects: Array(200).fill(rect) }] }))).not.toBeNull();
    reject(locator({ v: 1, pages: [{ page: 1, rects: Array(201).fill(rect) }] }));
  });

  it('limits the entire input locator to 16000 characters before trimming', () => {
    const atLimit = canonical.padEnd(16_000, ' ');
    expect(parsePdfSelectionLocator(atLimit)).toBe(canonical);
    reject(`${atLimit} `);
    reject(`pdfsel(${JSON.stringify(payload).padEnd(16_000, ' ')})`);
  });
});
