import { describe, expect, it } from 'vitest';
import { formatPdfLocator, parsePdfLocator, parsePdfPlace } from './locator';

const place = 'pdfpos(page=3;x=12.5;y=240;zoom=1.25)';
const fitted = 'pdfpos(page=2;x=0;y=400;fit=width)';

describe('pdf locator', () => {
  it('keeps a page, a PDF-space offset, and zoom or fit-width', () => {
    expect(parsePdfPlace(place)).toEqual({ page: 3, x: 12.5, y: 240, zoom: 1.25 });
    expect(parsePdfPlace(fitted)).toEqual({ page: 2, x: 0, y: 400, zoom: 'width' });
    expect(parsePdfLocator(`  ${place}  `)).toBe(place);
    expect(formatPdfLocator({ page: 3, x: 12.5, y: 240, zoom: 1.25 })).toBe(place);
    expect(formatPdfLocator({ page: 2, x: 0, y: 400.0004, zoom: 'width' })).toBe(fitted);
    for (const locator of [place, fitted]) {
      expect(locator.includes('%')).toBe(false);
      expect(locator.startsWith('pdfpos(')).toBe(true);
    }
  });

  it('refuses a document-wide percentage', () => {
    expect(parsePdfLocator('0.42')).toBeNull();
    expect(parsePdfLocator('42%')).toBeNull();
    expect(parsePdfLocator('1')).toBeNull();
    expect(parsePdfLocator('0')).toBeNull();
    expect(parsePdfLocator('pdfpos(page=1;x=0;y=0;zoom=100%)')).toBeNull();
    expect(parsePdfLocator('pdfpos(page=1;x=0;y=0;zoom=0)')).toBeNull();
    expect(parsePdfLocator('epubcfi(/6/4!/4/2:10)')).toBeNull();
    expect(formatPdfLocator({ page: 1, x: 0, y: 0, zoom: 0 })).toBeNull();
  });
});
