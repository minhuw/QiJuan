import type { PdfPageSize } from './types';

export const PDF_PAGE_GAP = 16;

/** Sparse page geometry: a large document needs metadata, not a DOM node per page. */
export class PageStream {
  constructor(
    readonly pageCount: number,
    public estimate: PdfPageSize,
    readonly sizes = new Map<number, PdfPageSize>(),
  ) {}

  size(page: number): PdfPageSize {
    return this.sizes.get(page) ?? this.estimate;
  }

  offset(page: number): number {
    let top = (page - 1) * (this.estimate.cssHeight + PDF_PAGE_GAP);
    for (const [number, size] of this.sizes) {
      if (number < page) top += size.cssHeight - this.estimate.cssHeight;
    }
    return top;
  }

  get height(): number {
    return this.pageCount > 0 ? this.offset(this.pageCount) + this.size(this.pageCount).cssHeight : 0;
  }

  width(containerWidth: number): number {
    let width = Math.max(containerWidth, this.estimate.cssWidth);
    for (const size of this.sizes.values()) width = Math.max(width, size.cssWidth);
    return width;
  }

  /** A gap belongs to the preceding page; callers clamp its local y to the page. */
  pageAt(top: number): number {
    let low = 1;
    let high = this.pageCount;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.offset(middle) <= top) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  range(top: number, viewportHeight: number): number[] {
    if (this.pageCount < 1) return [];
    const first = this.pageAt(Math.max(0, top - viewportHeight));
    const last = this.pageAt(top + viewportHeight * 2);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }
}
