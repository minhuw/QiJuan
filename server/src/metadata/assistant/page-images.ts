/**
 * Finds likely cover images in a page's HTML for the page_images tool. A small tag scanner,
 * not a full parser: it reads <meta>, <link>, <base>, <title>, and <img> tags.
 */

export const PAGE_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_IMAGES_MAX = 8;
const IMAGE_URL_MAX = 2000;
const ALT_MAX = 200;
const TITLE_MAX = 300;

export type PageImageKind = 'og:image' | 'twitter:image' | 'image_src' | 'img';

export interface PageImage {
  url: string;
  kind: PageImageKind;
  alt?: string;
  width?: number;
  height?: number;
}

/** Words in an <img> src, alt, class, or id that suggest a book cover. */
const COVER_HINT = /cover|封面|书影|mainpic|lpic|subject|jacket/i;
/** Images that are never a cover: icons, sprites, logos, avatars, and tracking pixels. */
const SKIP_HINT =
  /(?:^|[^a-z])(?:icon|icons|favicon|sprite|sprites|logo|logos|avatar|avatars|emoji|badge|button|btn|qrcode|qr|pixel|spacer|blank|beacon|tracking|tracker|1x1|loading|placeholder)(?:[^a-z]|$)/i;

/** Decodes HTML bytes using the charset from the header or a <meta> tag; UTF-8 otherwise. */
export function decodeHtml(bytes: Buffer, contentType: string | null): string {
  const label = charsetOf(contentType) ?? sniffMetaCharset(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function charsetOf(contentType: string | null): string | null {
  const match = contentType ? /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType) : null;
  return match ? match[1]!.toLowerCase() : null;
}

function sniffMetaCharset(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 4096).toString('latin1');
  const match = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Lists up to eight absolute http(s) image URLs, meta images first in document order, then
 * cover-like <img> tags, then other <img> tags. data: URIs, SVG, GIF, icons, sprites, and
 * tiny images are skipped.
 */
export function extractPageImages(html: string, pageUrl: URL): { title: string | null; images: PageImage[] } {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  let base = pageUrl;
  const baseTag = /<base\b([^>]*)>/i.exec(cleaned);
  if (baseTag) {
    const href = attributes(baseTag[1]!).href;
    const resolved = href ? resolveUrl(href, pageUrl) : null;
    if (resolved) base = resolved;
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned);
  const title = titleMatch ? cleanText(decodeEntities(titleMatch[1]!), TITLE_MAX) : null;

  const meta: PageImage[] = [];
  const hinted: PageImage[] = [];
  const other: PageImage[] = [];
  const seen = new Set<string>();
  let lastOg: PageImage | null = null;

  const tag = /<(meta|link|img)\b([^>]*)>/gi;
  for (let match = tag.exec(cleaned); match; match = tag.exec(cleaned)) {
    const name = match[1]!.toLowerCase();
    const attrs = attributes(match[2]!);
    if (name === 'meta') {
      const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
      if (key === 'og:image:width' || key === 'og:image:height') {
        const size = dimension(attrs.content);
        if (lastOg && size) lastOg[key === 'og:image:width' ? 'width' : 'height'] = size;
        continue;
      }
      const kind: PageImageKind | null =
        key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url'
          ? 'og:image'
          : key === 'twitter:image' || key === 'twitter:image:src'
            ? 'twitter:image'
            : null;
      if (!kind) continue;
      const image = candidate(attrs.content, kind, base, seen);
      if (image) {
        meta.push(image);
        if (kind === 'og:image') lastOg = image;
      }
      continue;
    }
    if (name === 'link') {
      const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
      if (!rel.includes('image_src')) continue;
      const image = candidate(attrs.href, 'image_src', base, seen);
      if (image) meta.push(image);
      continue;
    }
    const src = pickImgSource(attrs);
    if (!src) continue;
    const hints = [src, attrs.alt ?? '', attrs.class ?? '', attrs.id ?? ''].join(' ');
    const width = dimension(attrs.width);
    const height = dimension(attrs.height);
    if ((width !== undefined && width < 50) || (height !== undefined && height < 50)) continue;
    if (SKIP_HINT.test(`${attrs.class ?? ''} ${attrs.id ?? ''} ${pathOf(src)}`)) continue;
    const image = candidate(src, 'img', base, seen);
    if (!image) continue;
    const alt = cleanText(decodeEntities(attrs.alt ?? ''), ALT_MAX);
    if (alt) image.alt = alt;
    if (width) image.width = width;
    if (height) image.height = height;
    (COVER_HINT.test(hints) ? hinted : other).push(image);
  }
  return { title, images: [...meta, ...hinted, ...other].slice(0, PAGE_IMAGES_MAX) };
}

/** Lazy-loading attributes first, then the largest srcset entry, then src. */
function pickImgSource(attrs: Record<string, string>): string | null {
  for (const key of ['data-original', 'data-src', 'data-lazy-src']) {
    const value = attrs[key]?.trim();
    if (value && !value.startsWith('data:')) return value;
  }
  const srcset = attrs.srcset ?? attrs['data-srcset'];
  if (srcset) {
    let best: { url: string; size: number } | null = null;
    for (const part of srcset.split(',')) {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) continue;
      const size = descriptor ? Number.parseFloat(descriptor) || 0 : 1;
      if (!best || size > best.size) best = { url, size };
    }
    if (best && !best.url.startsWith('data:')) return best.url;
  }
  const src = attrs.src?.trim();
  return src ? src : null;
}

function candidate(raw: string | undefined, kind: PageImageKind, base: URL, seen: Set<string>): PageImage | null {
  if (!raw) return null;
  const value = decodeEntities(raw).trim();
  if (!value || /^data:/i.test(value)) return null;
  const url = resolveUrl(value, base);
  if (!url || url.href.length > IMAGE_URL_MAX) return null;
  if (/\.(svg|svgz|ico|gif)$/i.test(url.pathname)) return null;
  if (seen.has(url.href)) return null;
  seen.add(url.href);
  return { url: url.href, kind };
}

function resolveUrl(value: string, base: URL): URL | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function pathOf(value: string): string {
  return value.split(/[?#]/)[0] ?? value;
}

function dimension(value: string | undefined): number | undefined {
  if (!value || !/^\s*\d+(?:px)?\s*$/i.test(value)) return undefined;
  const size = Number.parseInt(value, 10);
  return size > 0 && size < 100_000 ? size : undefined;
}

/** Attribute name/value pairs; names lowercased, the first occurrence wins. */
function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const name = match[1]!.toLowerCase();
    if (name in attrs) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function cleanText(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
