import { describe, expect, it } from 'vitest';
import { PageStream, PDF_PAGE_GAP } from './layout';

const size = (cssHeight: number, cssWidth = 400) => ({ cssHeight, cssWidth, scale: 1 });

describe('PDF page stream geometry', () => {
  it('includes one gap between pages and uses each measured size', () => {
    const layout = new PageStream(4, size(1000));
    layout.sizes.set(2, size(600, 900));
    expect(layout.offset(1)).toBe(0);
    expect(layout.offset(2)).toBe(1016);
    expect(layout.offset(3)).toBe(1632);
    expect(layout.height).toBe(3648);
    expect(layout.width(640)).toBe(900);
    expect(layout.pageAt(1015)).toBe(1);
    expect(layout.pageAt(1016)).toBe(2);
    expect(layout.pageAt(1640)).toBe(3);
  });

  it('mounts visible pages plus one viewport of overscan on either side', () => {
    const layout = new PageStream(10000, size(1000));
    const top = layout.offset(5000) + 850;
    expect(layout.range(top, 480)).toEqual([5000, 5001]);
    expect(layout.range(top, 480).length).toBeLessThan(5);
    expect(layout.height).toBe(10000 * 1000 + 9999 * PDF_PAGE_GAP);
  });

  it('includes all visible small pages and handles the ends of a document', () => {
    const layout = new PageStream(10, size(50));
    expect(layout.range(0, 200)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(layout.range(layout.height - 100, 200).at(-1)).toBe(10);
    expect(new PageStream(0, size(1000)).range(0, 480)).toEqual([]);
  });
});
