import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { loadNames } from './edition-fields.js';
import { editions, fileAssets, series } from './schema.js';

/**
 * The name a book file goes by inside QiJuan: in the Files list, in downloads, and
 * over OPDS. It is computed from the current metadata every time and never stored,
 * so it follows title, author, date and series edits. Files on disk keep their names.
 *
 *   作者 - 书名 [系列 #n] (年份).ext
 */

export type AssetFormat = 'epub' | 'pdf';

export interface FileNameInput {
  title: string | null;
  authors: string[];
  publishedDate: string | null;
  series: string | null;
  seriesOrder: number | null;
  format: AssetFormat;
  /** The raw upload or on-disk name; used only when the metadata gives nothing usable. */
  originalFilename: string;
  /** 1 for the first file of this format on the edition, 2 for the second, and so on. */
  copy?: number;
}

export const FILE_NAME_MAX_BYTES = 200;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function displayFilename(input: FileNameInput): string {
  const ext = `.${input.format}`;
  const copy = input.copy && input.copy > 1 ? ` (${input.copy})` : '';
  const title = clean(input.title ?? '');
  if (!trimEnd(title)) return fallbackFilename(input.originalFilename, ext, copy);

  const author = authorPart(input.authors.map(clean).filter((name) => name.length > 0));
  const seriesName = clean(input.series ?? '');
  const seriesPart =
    seriesName && input.seriesOrder != null && Number.isFinite(input.seriesOrder) && !title.includes(seriesName)
      ? ` [${seriesName} #${input.seriesOrder}]`
      : '';
  const year = /\d{4}/.exec(input.publishedDate ?? '')?.[0];
  const yearPart = year ? ` (${year})` : '';
  const prefix = author ? `${author} - ` : '';
  const suffix = `${seriesPart}${yearPart}${copy}${ext}`;

  const room = FILE_NAME_MAX_BYTES - bytes(prefix) - bytes(suffix);
  if (room >= bytes(title)) return `${trimEnd(`${prefix}${title}${seriesPart}${yearPart}`)}${copy}${ext}`;
  const short = trimEnd(truncate(title, Math.max(room, 0)));
  if (short) return `${prefix}${short}${seriesPart}${yearPart}${copy}${ext}`;
  // Authors and series alone fill the budget: shorten the whole stem instead.
  const stem = `${prefix}${title}${seriesPart}${yearPart}`;
  return `${trimEnd(truncate(stem, FILE_NAME_MAX_BYTES - bytes(copy + ext)))}${copy}${ext}`;
}

/** The plain-ASCII `filename=` fallback: non-ASCII becomes "_", and a name with no letters left becomes book.<ext>. */
export function asciiFilename(name: string, format: AssetFormat): string {
  const ext = `.${format}`;
  const stem = name.endsWith(ext) ? name.slice(0, -ext.length) : name;
  const ascii = stem
    .replace(/[^\x20-\x7e]+/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/_+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return /[A-Za-z]/.test(ascii) ? `${ascii}${ext}` : `book${ext}`;
}

/** An RFC 6266 header with an ASCII `filename` and the real name in RFC 5987 `filename*`. */
export function contentDisposition(name: string, format: AssetFormat, type: 'inline' | 'attachment'): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${asciiFilename(name, format)}"; filename*=UTF-8''${encoded}`;
}

/** Display names for every live asset of the edition, keyed by asset id. */
export function editionAssetFilenames(db: AppDatabase, editionId: number): Map<number, string> {
  const edition = db
    .select({
      title: editions.title,
      publishedDate: editions.publishedDate,
      seriesId: editions.seriesId,
      seriesOrder: editions.seriesOrder,
    })
    .from(editions)
    .where(eq(editions.id, editionId))
    .get();
  const names = new Map<number, string>();
  if (!edition) return names;
  const seriesName =
    edition.seriesId == null
      ? null
      : db.select({ name: series.name }).from(series).where(eq(series.id, edition.seriesId)).get()?.name ?? null;
  const authors = loadNames(db, editionId, 'author');
  const assets = db
    .select({ id: fileAssets.id, format: fileAssets.format, originalFilename: fileAssets.originalFilename })
    .from(fileAssets)
    .where(and(eq(fileAssets.editionId, editionId), isNull(fileAssets.trashedAt)))
    .orderBy(asc(fileAssets.id))
    .all();
  const seen = new Map<AssetFormat, number>();
  for (const asset of assets) {
    const copy = (seen.get(asset.format) ?? 0) + 1;
    seen.set(asset.format, copy);
    names.set(
      asset.id,
      displayFilename({
        title: edition.title,
        authors,
        publishedDate: edition.publishedDate,
        series: seriesName,
        seriesOrder: edition.seriesOrder,
        format: asset.format,
        originalFilename: asset.originalFilename,
        copy,
      }),
    );
  }
  return names;
}

export function assetDisplayFilename(db: AppDatabase, editionId: number, assetId: number): string | null {
  return editionAssetFilenames(db, editionId).get(assetId) ?? null;
}

function authorPart(authors: string[]): string {
  if (authors.length === 0) return '';
  const shown = authors.slice(0, 2);
  const cjk = shown.some((name) => CJK.test(name));
  const joined = shown.join(cjk ? '、' : ' & ');
  if (authors.length <= 2) return joined;
  return cjk ? `${joined}等` : `${joined} et al.`;
}

function fallbackFilename(original: string, ext: string, copy: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  const stem = clean(base.replace(/\.(epub|pdf)$/i, ''));
  const kept = trimEnd(truncate(stem, FILE_NAME_MAX_BYTES - bytes(copy + ext)));
  return `${kept || 'book'}${copy}${ext}`;
}

/** Makes one name part safe on every common file system. */
function clean(value: string): string {
  return value
    .replace(/:/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/[/\\*?"<>|\p{Cc}]/gu, '_')
    .trim();
}

function trimEnd(value: string): string {
  return value.replace(/[\s.]+$/u, '');
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** The longest prefix of whole characters that fits in `max` UTF-8 bytes. */
function truncate(value: string, max: number): string {
  if (bytes(value) <= max) return value;
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = bytes(segment);
    if (used + size > max) break;
    out += segment;
    used += size;
  }
  return out;
}
