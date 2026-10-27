/** Pages whose thumbnails should be drawn. Far pages stay unrendered. */
export function nearbyPages(pages: number[], current: number, radius: number): number[] {
  if (!Number.isInteger(radius) || radius < 0) return [];
  return pages.filter((page) => Number.isInteger(page) && Math.abs(page - current) <= radius);
}

export const THUMBNAIL_RADIUS = 2;
export const THUMBNAIL_CSS_WIDTH = 96;
