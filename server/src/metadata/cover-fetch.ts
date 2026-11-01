import type { WebTransport } from './assistant/client.js';
import { PAGE_HTML_MAX_BYTES, decodeHtml, extractPageImages } from './assistant/page-images.js';
import { safeGet } from './safe-fetch.js';

/**
 * Downloads and checks a cover image the metadata agent proposed. Only JPEG, PNG, and WebP
 * are accepted, by magic bytes, and the pixel size must look like a book cover.
 */

export const COVER_MIN_BYTES = 2 * 1024;
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_MIN_WIDTH = 150;
/** Height divided by width. */
export const COVER_MIN_ASPECT = 1.0;
export const COVER_MAX_ASPECT = 2.0;

export type CoverMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageInfo {
  mediaType: CoverMediaType;
  width: number;
  height: number;
}

export interface VerifiedCover extends ImageInfo {
  bytes: Buffer;
  /** The image URL after redirects. */
  url: string;
  host: string;
  sourceUrl: string | null;
}

export type CoverRejection =
  | 'url_rejected'
  | 'redirect_rejected'
  | 'too_many_redirects'
  | 'http_error'
  | 'timeout'
  | 'network'
  | 'not_an_image'
  | 'unsupported_type'
  | 'too_small'
  | 'too_large'
  | 'unreadable_dimensions'
  | 'too_narrow'
  | 'wrong_aspect';

export type CoverFetchResult =
  | { ok: true; cover: VerifiedCover }
  | { ok: false; reason: CoverRejection; detail: string; host: string | null };

export type CoverCheck = ({ ok: true } & ImageInfo) | { ok: false; reason: CoverRejection; detail: string };

/** Fetches `url` with the same URL rules as page_images and verifies the bytes. Never throws. */
export async function fetchVerifiedCover(
  input: { url: string; sourceUrl?: string | null },
  transport: WebTransport,
): Promise<CoverFetchResult> {
  const sourceUrl = input.sourceUrl ?? null;
  const host = hostOf(input.url);
  const reply = await safeGet(input.url, {
    transport,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
    maxBytes: COVER_MAX_BYTES,
    overflow: 'reject',
    referer: (url) => coverReferer(url, sourceUrl),
  });
  if (!reply.ok) {
    const detail = reply.code === 'too_large' ? `larger than ${COVER_MAX_BYTES} bytes` : reply.detail;
    return { ok: false, reason: reply.code, detail, host };
  }
  const check = verifyCoverBytes(reply.bytes, reply.contentType);
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail, host: reply.url.hostname };
  return {
    ok: true,
    cover: {
      bytes: reply.bytes,
      mediaType: check.mediaType,
      width: check.width,
      height: check.height,
      url: reply.url.href,
      host: reply.url.hostname,
      sourceUrl,
    },
  };
}

/** How many of a page's meta images (og:image, twitter:image, image_src) are tried. */
export const PAGE_COVER_CANDIDATES = 2;

export type PageCoverResult =
  | { ok: true; cover: VerifiedCover }
  | { ok: false; reason: CoverRejection | 'page_unavailable' | 'not_html' | 'no_page_image'; detail: string; host: string | null };

/**
 * The cover a book's record page advertises. Only meta images are tried: the <img> tags on a
 * record page are often other books (Douban lists related titles). Each candidate goes through
 * `fetchVerifiedCover` with the page as its source. Never throws.
 */
export async function fetchPageCover(pageUrl: string, transport: WebTransport): Promise<PageCoverResult> {
  const reply = await safeGet(pageUrl, {
    transport,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    maxBytes: PAGE_HTML_MAX_BYTES,
    overflow: 'truncate',
  });
  const pageHost = hostOf(pageUrl);
  if (!reply.ok) return { ok: false, reason: 'page_unavailable', detail: `${reply.code}: ${reply.detail}`, host: pageHost };
  const type = (reply.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type && type !== 'text/html' && type !== 'application/xhtml+xml') {
    return { ok: false, reason: 'not_html', detail: `the page is ${type}`, host: reply.url.hostname };
  }
  const { images } = extractPageImages(decodeHtml(reply.bytes, reply.contentType), reply.url);
  const candidates = images.filter((image) => image.kind !== 'img').slice(0, PAGE_COVER_CANDIDATES);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_page_image', detail: 'the page has no og:image or similar', host: reply.url.hostname };
  }
  let last: PageCoverResult | null = null;
  for (const image of candidates) {
    const result = await fetchVerifiedCover({ url: image.url, sourceUrl: reply.url.href }, transport);
    if (result.ok) return result;
    last = result;
  }
  return last!;
}

/** Checks the type by magic bytes, the size, the pixel width, and the aspect ratio. */
export function verifyCoverBytes(bytes: Buffer, contentType: string | null = null): CoverCheck {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    return { ok: false, reason: 'not_an_image', detail: `served as ${type}` };
  }
  if (bytes.length < COVER_MIN_BYTES) {
    return { ok: false, reason: 'too_small', detail: `${bytes.length} bytes, under ${COVER_MIN_BYTES}` };
  }
  if (bytes.length > COVER_MAX_BYTES) {
    return { ok: false, reason: 'too_large', detail: `${bytes.length} bytes, over ${COVER_MAX_BYTES}` };
  }
  const mediaType = sniffCoverType(bytes);
  if (!mediaType) return { ok: false, reason: 'unsupported_type', detail: 'not a JPEG, PNG, or WebP image' };
  const info = imageDimensions(bytes);
  if (!info) return { ok: false, reason: 'unreadable_dimensions', detail: `no pixel size in the ${shortType(mediaType)} header` };
  const { width, height } = info;
  if (width < COVER_MIN_WIDTH) {
    return { ok: false, reason: 'too_narrow', detail: `${width}×${height}, under ${COVER_MIN_WIDTH}px wide` };
  }
  const aspect = height / width;
  if (aspect < COVER_MIN_ASPECT || aspect > COVER_MAX_ASPECT) {
    return {
      ok: false,
      reason: 'wrong_aspect',
      detail: `${width}×${height} is not a book-cover shape (height/width ${aspect.toFixed(2)})`,
    };
  }
  return { ok: true, mediaType, width, height };
}

export function sniffCoverType(bytes: Buffer): CoverMediaType | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Reads the pixel size from the JPEG SOF, PNG IHDR, or WebP VP8/VP8L/VP8X header. */
export function imageDimensions(bytes: Buffer): ImageInfo | null {
  const mediaType = sniffCoverType(bytes);
  if (mediaType === 'image/png') return pngSize(bytes);
  if (mediaType === 'image/jpeg') return jpegSize(bytes);
  if (mediaType === 'image/webp') return webpSize(bytes);
  return null;
}

function pngSize(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return sized('image/png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function jpegSize(bytes: Buffer): ImageInfo | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length: TEM, RST0–7, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      return sized('image/jpeg', bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return sized('image/webp', width, height);
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return sized('image/webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

function sized(mediaType: CoverMediaType, width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { mediaType, width, height } : null;
}

/**
 * Some image hosts refuse a foreign Referer, or none (img*.doubanio.com answers 418 then). The
 * source page's origin is sent only when the image host belongs to the same site family;
 * otherwise no Referer at all.
 */
export function coverReferer(imageUrl: URL, sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (source.protocol !== 'https:' && source.protocol !== 'http:') return null;
  return sameSiteFamily(source.hostname, imageUrl.hostname) ? `${source.origin}/` : null;
}

/** Image hosts that serve a site's pictures under another domain. */
const SITE_FAMILIES: Record<string, readonly string[]> = {
  'douban.com': ['doubanio.com'],
  'jd.com': ['360buyimg.com'],
  'dangdang.com': ['ddimg.cn'],
  'amazon.com': ['media-amazon.com', 'ssl-images-amazon.com'],
  'amazon.cn': ['media-amazon.com', 'ssl-images-amazon.com'],
  'amazon.co.jp': ['media-amazon.com', 'ssl-images-amazon.com'],
  'amazon.co.uk': ['media-amazon.com', 'ssl-images-amazon.com'],
  'amazon.de': ['media-amazon.com', 'ssl-images-amazon.com'],
};

export function sameSiteFamily(pageHost: string, imageHost: string): boolean {
  const page = siteOf(pageHost);
  const image = siteOf(imageHost);
  if (!page || !image) return false;
  if (page === image) return true;
  return (SITE_FAMILIES[page] ?? []).includes(image);
}

/** Second-level labels under which registrations sit one level deeper (example.com.cn). */
const SECOND_LEVEL = new Set(['com', 'net', 'org', 'edu', 'gov', 'ac', 'co', 'or', 'ne', 'go']);

/** The registrable domain, approximately: the last two labels, or three under com.cn, co.uk, and the like. */
function siteOf(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const count = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-count).join('.');
}

/** A one-line trajectory note, e.g. "Cover verified 357×500 JPEG from img3.doubanio.com". */
export function describeCoverResult(result: CoverFetchResult | PageCoverResult): string {
  if (result.ok) {
    const { cover } = result;
    return `Cover verified ${cover.width}×${cover.height} ${shortType(cover.mediaType)} from ${cover.host}`;
  }
  return `Cover rejected${result.host ? ` from ${result.host}` : ''}: ${result.reason} (${result.detail})`;
}

function shortType(mediaType: CoverMediaType): string {
  return mediaType === 'image/jpeg' ? 'JPEG' : mediaType === 'image/png' ? 'PNG' : 'WebP';
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}
