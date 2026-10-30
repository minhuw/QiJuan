import type { PdfPlace } from './locator';
import type { PdfSearchHit } from './search';

export interface PdfOutlineItem {
  title: string;
  page: number | null;
  x: number | null;
  y: number | null;
  children: PdfOutlineItem[];
}

export interface PdfPageBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PdfPageSize {
  scale: number;
  cssWidth: number;
  cssHeight: number;
}

export interface RenderedPage extends PdfPageSize {
  toPdf(x: number, y: number): { x: number; y: number };
  toViewport(x: number, y: number): { x: number; y: number };
}

export interface RenderPageInput {
  page: number;
  zoom: PdfPlace['zoom'];
  containerWidth: number;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
}

export interface PdfSearchResult {
  searchable: boolean;
  hits: PdfSearchHit[];
}

export interface PdfSession {
  readonly pageCount: number;
  readonly outline: PdfOutlineItem[];
  /** Empty when this file has nothing to show as a thumbnail. */
  readonly thumbnailPages: number[];
  searchable(): Promise<boolean>;
  pageBox(page: number): Promise<PdfPageBox>;
  pageSize(page: number, zoom: PdfPlace['zoom'], containerWidth: number): Promise<PdfPageSize>;
  /** Each canvas has its own render lifetime, allowing adjacent pages to paint together. */
  renderPage(input: RenderPageInput): Promise<RenderedPage | null>;
  /** Cancel a detached page's work and release its canvas and text-layer references. */
  releasePage(canvas: HTMLCanvasElement): void;
  /** Draws one small page. False means that thumbnail is omitted, not a reader error. */
  renderThumbnail(page: number, canvas: HTMLCanvasElement, maxWidth: number): Promise<boolean>;
  search(query: string): Promise<PdfSearchResult>;
  destroy(): Promise<void>;
}

export type { PdfPlace } from './locator';
export type { PdfSearchHit } from './search';
