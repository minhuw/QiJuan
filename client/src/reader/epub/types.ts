import type { ReaderFlow, ReaderFont, ReaderTheme } from './settings';

export interface TocItem {
  label: string;
  href: string;
  children: TocItem[];
}

export interface SearchHit {
  cfi: string;
  excerpt: string;
}

export interface BookFacts {
  language: string | null;
  direction: 'ltr' | 'rtl';
}

export interface Typography {
  font: ReaderFont;
  fontSize: string;
  lineHeight: string;
  margin: string;
  theme: ReaderTheme;
}

export interface EpubSession {
  facts: BookFacts;
  toc: TocItem[];
  display(target: string): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  setFlow(mode: ReaderFlow): Promise<void>;
  applyTypography(typography: Typography, cfi: string | null): Promise<void>;
  resize(width: number, height: number, cfi: string | null): void;
  highlight(cfi: string): void;
  underline(cfi: string): void;
  removeMark(cfi: string, kind: 'highlight' | 'underline'): void;
  onRelocated(listener: (cfi: string) => void): () => void;
  onSelected(listener: (cfi: string, quote: string) => void): () => void;
  search(query: string): Promise<SearchHit[]>;
  destroy(): void;
}

export interface OpenEpubOptions {
  initialCfi: string | null;
  flow: ReaderFlow;
  typography: Typography;
}
