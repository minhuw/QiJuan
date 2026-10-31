import { describe, expect, it } from 'vitest';
import type { WebTransport } from '../src/metadata/assistant/client.js';
import {
  COVER_MAX_BYTES,
  coverReferer,
  describeCoverResult,
  fetchVerifiedCover,
  imageDimensions,
  sameSiteFamily,
  verifyCoverBytes,
} from '../src/metadata/cover-fetch.js';
import { jpegOfSize, pngOfSize, webpOfSize } from './fixtures.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

/** Every request is answered by `handler`; DNS resolves to a public address unless listed. */
function imageTransport(handler: (url: URL) => Response, dns: Record<string, string[]> = {}) {
  const seen: Seen[] = [];
  const transport: WebTransport = {
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      seen.push({ url: url.href, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
      return handler(url);
    },
    async lookup(host) {
      return dns[host] ?? ['93.184.216.34'];
    },
  };
  return { transport, seen };
}

const jpeg = (bytes: Buffer) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });

describe('cover dimensions', () => {
  it('reads the pixel size from JPEG, PNG, and every WebP variant', () => {
    expect(imageDimensions(jpegOfSize(357, 500))).toEqual({ mediaType: 'image/jpeg', width: 357, height: 500 });
    expect(imageDimensions(pngOfSize(600, 900))).toEqual({ mediaType: 'image/png', width: 600, height: 900 });
    expect(imageDimensions(webpOfSize(400, 640, 'VP8 '))).toEqual({ mediaType: 'image/webp', width: 400, height: 640 });
    expect(imageDimensions(webpOfSize(401, 641, 'VP8L'))).toEqual({ mediaType: 'image/webp', width: 401, height: 641 });
    expect(imageDimensions(webpOfSize(1200, 1800, 'VP8X'))).toEqual({ mediaType: 'image/webp', width: 1200, height: 1800 });
  });

  it('skips JPEG segments before the frame and gives up at the scan without a frame', () => {
    const noFrame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]), Buffer.alloc(3000)]);
    expect(imageDimensions(noFrame)).toBeNull();
    expect(imageDimensions(Buffer.from('GIF89a' + 'x'.repeat(3000)))).toBeNull();
  });
});

describe('cover verification', () => {
  it('accepts a cover-shaped JPEG, PNG, or WebP by magic bytes', () => {
    expect(verifyCoverBytes(jpegOfSize(357, 500), 'image/jpeg')).toEqual({ ok: true, mediaType: 'image/jpeg', width: 357, height: 500 });
    expect(verifyCoverBytes(pngOfSize(300, 300), 'image/png')).toMatchObject({ ok: true, mediaType: 'image/png' });
    // A wrong or generic header does not matter; the bytes decide the type.
    expect(verifyCoverBytes(webpOfSize(300, 600, 'VP8X'), 'image/jpeg')).toMatchObject({ ok: true, mediaType: 'image/webp' });
    expect(verifyCoverBytes(jpegOfSize(357, 500), 'application/octet-stream')).toMatchObject({ ok: true });
  });

  it('rejects the wrong type, a non-image response, and bytes that only claim to be an image', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4000)]);
    expect(verifyCoverBytes(gif, 'image/gif')).toMatchObject({ ok: false, reason: 'unsupported_type' });
    const html = Buffer.from(`<html>${'x'.repeat(4000)}</html>`);
    expect(verifyCoverBytes(html, 'image/jpeg')).toMatchObject({ ok: false, reason: 'unsupported_type' });
    expect(verifyCoverBytes(jpegOfSize(357, 500), 'text/html; charset=utf-8')).toMatchObject({ ok: false, reason: 'not_an_image' });
  });

  it('rejects files under 2 KiB or over 5 MiB', () => {
    expect(verifyCoverBytes(jpegOfSize(357, 500, 1500))).toMatchObject({ ok: false, reason: 'too_small' });
    expect(verifyCoverBytes(jpegOfSize(357, 500, COVER_MAX_BYTES + 1))).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('rejects images under 150px wide or not shaped like a book cover', () => {
    expect(verifyCoverBytes(jpegOfSize(120, 180))).toMatchObject({ ok: false, reason: 'too_narrow' });
    // Landscape (height/width < 1.0) and too tall (> 2.0) are both refused.
    expect(verifyCoverBytes(jpegOfSize(500, 357))).toMatchObject({ ok: false, reason: 'wrong_aspect' });
    expect(verifyCoverBytes(pngOfSize(200, 450))).toMatchObject({ ok: false, reason: 'wrong_aspect' });
    expect(verifyCoverBytes(pngOfSize(200, 400))).toMatchObject({ ok: true });
    expect(verifyCoverBytes(pngOfSize(300, 300))).toMatchObject({ ok: true });
  });
});

describe('cover download', () => {
  it('sends the source origin as Referer to an image host of the same site family, and nothing else', async () => {
    const { transport, seen } = imageTransport(() => jpeg(jpegOfSize(357, 500)));
    const result = await fetchVerifiedCover(
      {
        url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg',
        sourceUrl: 'https://book.douban.com/subject/25869109/',
      },
      transport,
    );
    expect(result).toMatchObject({ ok: true, cover: { width: 357, height: 500, mediaType: 'image/jpeg', host: 'img3.doubanio.com' } });
    expect(seen[0]!.headers.referer).toBe('https://book.douban.com/');
    expect(seen[0]!.redirect).toBe('manual');
    expect(seen[0]!.headers['user-agent']).toMatch(/Mozilla\/5\.0/);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(result.ok && describeCoverResult(result)).toBe('Cover verified 357×500 JPEG from img3.doubanio.com');

    await fetchVerifiedCover({ url: 'https://images.example.org/c.jpg', sourceUrl: 'https://book.douban.com/subject/1/' }, transport);
    expect(seen[1]!.headers.referer).toBeUndefined();
    await fetchVerifiedCover({ url: 'https://img3.doubanio.com/c.jpg' }, transport);
    expect(seen[2]!.headers.referer).toBeUndefined();
  });

  it('knows which hosts share a site', () => {
    expect(sameSiteFamily('book.douban.com', 'img1.doubanio.com')).toBe(true);
    expect(sameSiteFamily('www.publisher.com.cn', 'static.publisher.com.cn')).toBe(true);
    expect(sameSiteFamily('a.com.cn', 'b.com.cn')).toBe(false);
    expect(sameSiteFamily('book.douban.com', 'evil-douban.com')).toBe(false);
    expect(coverReferer(new URL('https://img.doubanio.com/x.jpg'), 'javascript:alert(1)')).toBeNull();
  });

  it('re-validates every redirect hop and stops after three', async () => {
    const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
    const internal = imageTransport(
      (url) => (url.hostname === 'img.example.com' ? redirectTo('https://intranet.example.net/cover.jpg') : jpeg(jpegOfSize(357, 500))),
      { 'intranet.example.net': ['10.0.0.8'] },
    );
    const refused = await fetchVerifiedCover({ url: 'https://img.example.com/c.jpg' }, internal.transport);
    expect(refused).toMatchObject({ ok: false, reason: 'redirect_rejected' });
    expect(internal.seen.map((item) => item.url)).toEqual(['https://img.example.com/c.jpg']);

    let hops = 0;
    const loop = imageTransport(() => redirectTo(`https://img.example.com/${(hops += 1)}.jpg`));
    expect(await fetchVerifiedCover({ url: 'https://img.example.com/0.jpg' }, loop.transport)).toMatchObject({
      ok: false,
      reason: 'too_many_redirects',
    });
    expect(loop.seen).toHaveLength(4);

    const ok = imageTransport((url) => (url.pathname === '/a.jpg' ? redirectTo('/b.jpg') : jpeg(jpegOfSize(357, 500))));
    expect(await fetchVerifiedCover({ url: 'https://img.example.com/a.jpg' }, ok.transport)).toMatchObject({
      ok: true,
      cover: { url: 'https://img.example.com/b.jpg' },
    });
  });

  it('refuses unsafe urls without a request, and a body over 5 MiB', async () => {
    const { transport, seen } = imageTransport(() => jpeg(jpegOfSize(357, 500)), { 'local.example.com': ['127.0.0.1'] });
    for (const url of ['http://10.0.0.1/c.jpg', 'https://user:pw@img.example.com/c.jpg', 'https://local.example.com/c.jpg', 'ftp://img.example.com/c.jpg', 'https://img.example.com:8443/c.jpg']) {
      expect(await fetchVerifiedCover({ url }, transport)).toMatchObject({ ok: false, reason: 'url_rejected' });
    }
    expect(seen).toEqual([]);

    const advertised = imageTransport(
      () => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(COVER_MAX_BYTES + 1) } }),
    );
    expect(await fetchVerifiedCover({ url: 'https://img.example.com/big.jpg' }, advertised.transport)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
    const streamed = imageTransport(() => jpeg(jpegOfSize(357, 500, COVER_MAX_BYTES + 10)));
    expect(await fetchVerifiedCover({ url: 'https://img.example.com/big.jpg' }, streamed.transport)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reports an HTTP refusal, e.g. a hotlink block, with its status', async () => {
    const { transport } = imageTransport(() => new Response('', { status: 418 }));
    const result = await fetchVerifiedCover({ url: 'https://img3.doubanio.com/c.jpg' }, transport);
    expect(result).toMatchObject({ ok: false, reason: 'http_error', detail: 'HTTP 418', host: 'img3.doubanio.com' });
    expect(describeCoverResult(result)).toBe('Cover rejected from img3.doubanio.com: http_error (HTTP 418)');
  });

  it('never reaches the network without a stubbed transport under Vitest', async () => {
    expect(await fetchVerifiedCover({ url: 'https://img3.doubanio.com/c.jpg' }, {})).toMatchObject({ ok: false, reason: 'network' });
  });
});
